import { describe, expect, it } from "vitest";

async function getTestOnlyResolveAuthTokenForSignature() {
  await import("./test-helpers.runtime-state.js");
  await import("./test-helpers.mocks.js");
  const { testOnlyResolveAuthTokenForSignature } = await import("./test-helpers.server.js");
  return testOnlyResolveAuthTokenForSignature;
}

describe("testOnlyResolveAuthTokenForSignature", () => {
  it("matches connect auth precedence for bootstrap tokens", async () => {
    const testOnlyResolveAuthTokenForSignature = await getTestOnlyResolveAuthTokenForSignature();
    expect(
      testOnlyResolveAuthTokenForSignature({
        token: undefined,
        bootstrapToken: "bootstrap-token",
        deviceToken: "device-token",
      }),
    ).toBe("bootstrap-token");
  });

  it("still prefers the shared token when present", async () => {
    const testOnlyResolveAuthTokenForSignature = await getTestOnlyResolveAuthTokenForSignature();
    expect(
      testOnlyResolveAuthTokenForSignature({
        token: "shared-token",
        bootstrapToken: "bootstrap-token",
        deviceToken: "device-token",
      }),
    ).toBe("shared-token");
  });
});
