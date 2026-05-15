import fs from "node:fs";
import path from "node:path";
import { resolveStateDir } from "../../../config/paths.js";
import { expandHomePrefix } from "../../../infra/home-dir.js";
import {
  normalizePluginBindingApprovalsSnapshot,
  writePluginBindingApprovalsSnapshot,
} from "../../../plugins/conversation-binding.js";

const LEGACY_APPROVALS_PATH = "~/.openclaw/plugin-binding-approvals.json";

function resolveLegacyApprovalsPath(env: NodeJS.ProcessEnv = process.env): string {
  if (env.OPENCLAW_STATE_DIR?.trim()) {
    return path.join(resolveStateDir(env), "plugin-binding-approvals.json");
  }
  return expandHomePrefix(LEGACY_APPROVALS_PATH, { env });
}

export function legacyPluginBindingApprovalFileExists(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  try {
    return fs.statSync(resolveLegacyApprovalsPath(env)).isFile();
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

export function importLegacyPluginBindingApprovalFileToSqlite(
  env: NodeJS.ProcessEnv = process.env,
): {
  imported: boolean;
  approvals: number;
} {
  const filePath = resolveLegacyApprovalsPath(env);
  if (!legacyPluginBindingApprovalFileExists(env)) {
    return { imported: false, approvals: 0 };
  }
  const file = normalizePluginBindingApprovalsSnapshot(
    JSON.parse(fs.readFileSync(filePath, "utf8")) as unknown,
  );
  writePluginBindingApprovalsSnapshot(file, env);
  try {
    fs.unlinkSync(filePath);
  } catch {
    // Import succeeded; a later doctor pass can remove the stale file.
  }
  return { imported: true, approvals: file.approvals.length };
}
