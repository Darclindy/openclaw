import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../../../infra/kysely-sync.js";
import type { DB as OpenClawStateKyselyDatabase } from "../../../state/openclaw-state-db.generated.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../../../state/openclaw-state-db.js";
import {
  importLegacyPluginBindingApprovalFileToSqlite,
  legacyPluginBindingApprovalFileExists,
} from "./plugin-conversation-binding.js";

type PluginBindingApprovalsDatabase = Pick<OpenClawStateKyselyDatabase, "plugin_binding_approvals">;

const tempRoots: string[] = [];

async function makeTempStateDir(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-plugin-binding-migrate-"));
  tempRoots.push(root);
  return root;
}

afterEach(async () => {
  closeOpenClawStateDatabaseForTest();
  await Promise.all(tempRoots.map((root) => fs.rm(root, { recursive: true, force: true })));
  tempRoots.length = 0;
});

describe("legacy plugin binding approvals migration", () => {
  it("uses the supplied doctor env for source and SQLite target", async () => {
    const realStateDir = await makeTempStateDir();
    const doctorStateDir = await makeTempStateDir();
    const env = { ...process.env, OPENCLAW_STATE_DIR: doctorStateDir };
    const legacyPath = path.join(doctorStateDir, "plugin-binding-approvals.json");
    await fs.writeFile(
      legacyPath,
      `${JSON.stringify({
        version: 1,
        approvals: [
          {
            pluginRoot: "/plugins/env-specific",
            pluginId: "env-plugin",
            pluginName: "Env Plugin",
            channel: "Discord",
            accountId: "default",
            approvedAt: 1777118400000,
          },
        ],
      })}\n`,
      "utf8",
    );

    expect(
      legacyPluginBindingApprovalFileExists({
        ...process.env,
        OPENCLAW_STATE_DIR: realStateDir,
      }),
    ).toBe(false);
    expect(legacyPluginBindingApprovalFileExists(env)).toBe(true);
    expect(importLegacyPluginBindingApprovalFileToSqlite(env)).toEqual({
      imported: true,
      approvals: 1,
    });

    const database = openOpenClawStateDatabase({ env });
    const db = getNodeSqliteKysely<PluginBindingApprovalsDatabase>(database.db);
    expect(
      executeSqliteQuerySync(
        database.db,
        db
          .selectFrom("plugin_binding_approvals")
          .select([
            "plugin_root",
            "plugin_id",
            "plugin_name",
            "channel",
            "account_id",
            "approved_at",
          ]),
      ).rows,
    ).toEqual([
      {
        plugin_root: "/plugins/env-specific",
        plugin_id: "env-plugin",
        plugin_name: "Env Plugin",
        channel: "discord",
        account_id: "default",
        approved_at: 1777118400000,
      },
    ]);
    await expect(fs.stat(legacyPath)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
