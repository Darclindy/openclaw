---
summary: "Dev-mode end-to-end performance tracing across gateway, agent runtime, and LLM provider, viewed as a Perfetto flame graph"
read_when:
  - You need to find where a chat request spends its time across the frontend, gateway, and model call
  - You want a flame graph of one request instead of guessing at the bottleneck
  - You are profiling agent runtime or provider latency in dev
title: "Performance tracing"
---

Performance tracing captures a single chat request as a span timeline across the
gateway, the agent runtime, and the LLM provider, then exports it as a flame
graph you open in [Perfetto](https://ui.perfetto.dev) or `chrome://tracing`.

It has two halves that work together:

- **Span timeline** answers _which phase is slow_ (gateway dispatch, agent run,
  model request, tool execution) with wall-clock timing that includes network
  and queue waits. Spans are correlated by `runId` and grouped into swimlanes by
  layer.
- **CPU profile** answers _which function is slow_ inside a hot span. It is a
  standard V8 `.cpuprofile` that also opens in Perfetto.

Everything is opt-in and env-gated, so production keeps zero overhead.

## Quick start

```bash
# Wraps `pnpm gateway:watch`, captures the timeline, exports on Ctrl-C.
node scripts/trace-dev.mjs

# Also capture V8 CPU profiles for per-function drilldown.
node scripts/trace-dev.mjs --cpu

# Wrap a different command instead of the gateway.
node scripts/trace-dev.mjs -- pnpm dev
```

Reproduce the slow request, then stop the command with Ctrl-C. The script prints
the path of a `*.perfetto.json` file under `~/.openclaw/logs/perf-trace/`. Drag
that file into [ui.perfetto.dev](https://ui.perfetto.dev).

## Manual workflow

The timeline is the existing [diagnostics timeline](/diagnostics/flags). Enable
it with two environment variables, run the gateway, then export:

```bash
export OPENCLAW_DIAGNOSTICS=timeline
export OPENCLAW_DIAGNOSTICS_TIMELINE_PATH=/tmp/openclaw-timeline.jsonl
pnpm gateway:watch
# ... reproduce the request, then stop the gateway ...

openclaw diagnostics trace-export /tmp/openclaw-timeline.jsonl
```

The exporter writes `/tmp/openclaw-timeline.perfetto.json` next to the input.

### Export options

```bash
openclaw diagnostics trace-export <input.jsonl> [--out <file>] [--run <runId>] [--json]
```

- `--out <file>` choose the output path.
- `--run <runId>` keep only the spans for one chat request. The `runId` equals
  the gateway `idempotencyKey` for that send; you can read it from the span
  `args` in Perfetto or from the JSONL.
- `--json` print machine-readable metadata instead of the human summary.

Without a build, the same export runs through
`node --import tsx scripts/perf-trace-export.ts <input.jsonl> [--out <file>] [--run <runId>]`.

## Reading the flame graph

Each layer is a swimlane (Perfetto track):

| Layer      | Swimlane | What it covers                                                                 |
| ---------- | -------- | ------------------------------------------------------------------------------ |
| `frontend` | frontend | desktop UI client spans: submit to first event to final (`frontend.chat_send`) |
| `gateway`  | gateway  | `chat.send` handling: session load, attachment prep, dispatch                  |
| `agent`    | agent    | the embedded run loop (`agent.run`) and its phases                             |
| `provider` | provider | the model request (`provider.request`): connect plus token stream              |

Spans nest by time, so the model request appears inside the agent run, which
appears inside the gateway dispatch. Span `args` carry `runId`, `provider`,
`model`, and other attributes.

### Span dictionary

| Span                                    | Layer    | Notes                                                                                                                         |
| --------------------------------------- | -------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `frontend.chat_send`                    | frontend | desktop UI span from message submit to the run terminal; the `frontend.first_event` mark records time to first streamed event |
| `gateway.chat_send.load_session`        | gateway  | resolve session entry and config                                                                                              |
| `gateway.chat_send.prepare_attachments` | gateway  | stage images and offloads                                                                                                     |
| `gateway.chat_send.dispatch_inbound`    | gateway  | dispatch to the agent runtime; the agent run is awaited inside this span, so its `runId` propagates to every nested span      |
| `agent.run`                             | agent    | one embedded agent run                                                                                                        |
| `provider.request`                      | provider | the model API request and token stream                                                                                        |

## CPU profile drilldown

When a span is hot but you need the function-level cause, capture a V8 CPU
profile of that window. Set a directory and the runtime captures one on demand:

```bash
export OPENCLAW_CPU_PROFILE_DIR=~/.openclaw/logs/perf-trace
```

`node scripts/trace-dev.mjs --cpu` sets this for you. Profiles are written as
`<label>-<pid>-<ms>.cpuprofile` and open in Perfetto or
[speedscope](https://www.speedscope.app). This is a bounded, on-demand
alternative to whole-process `node --cpu-prof`.

## Frontend layer

The desktop UI is a separate process with no filesystem access, so it reports
its spans to the gateway over the existing WebSocket (the `diagnostics.clientTrace`
RPC), and the gateway writes them into the same timeline tagged `layer: "frontend"`.
The UI uses the same `runId` it sends with `chat.send`, so frontend spans line up
with the gateway/agent/provider spans for that request.

Frontend capture is opt-in. In the desktop UI devtools console:

```js
localStorage.setItem("openclaw:perf-trace", "1");
```

The gateway it connects to must be running with the timeline enabled (for
example via `node scripts/trace-dev.mjs`). Clock alignment relies on the UI and
gateway sharing a machine, which is the case for the desktop app.

## How it works

- Spans use the diagnostics timeline engine in `src/infra/diagnostics-timeline.ts`.
  `runId` is set once on the gateway dispatch span and propagates to nested agent
  and provider spans through `AsyncLocalStorage`.
- The agent runtime emits spans through `src/agents/agent-timeline.ts`; provider
  requests are wrapped in `src/agents/openai-transport-stream.ts`.
- The desktop UI collects client spans in `ui/src/ui/perf/trace-client.ts` and
  flushes them through `diagnostics.clientTrace`, ingested by
  `src/gateway/server-methods/diagnostics-client-trace.ts`.
- The exporter (`src/infra/diagnostics-timeline-export.ts`) pairs span start and
  end events into Chrome trace complete events and maps each layer to a track.
- CPU profiles use `src/infra/cpu-profile.ts` (`node:inspector`).

## Notes and limits

- Dev only. With the timeline disabled, all spans are no-ops and add no overhead.
  Frontend capture additionally requires the `openclaw:perf-trace` localStorage flag.
- Only one CPU profile session runs at a time (a V8 limitation).
