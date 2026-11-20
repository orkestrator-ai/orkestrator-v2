/**
 * Agent Capabilities session-private plugins
 * (docs/architecture/agent-capabilities-management.md, "Session-private delivery").
 *
 * The backend stages the skills, commands and subagents a session's setups
 * select for that session alone into a content-addressed plugin directory it
 * owns, and sends the directory on each of that session's prompts as
 * `capabilityPlugins`. This bridge hands them to the SDK as inline plugins
 * (`--plugin-dir`), so no other session, provider or account home sees them.
 *
 * A prompt names paths, so they are accepted only from inside the root the
 * backend named at launch (`ORKESTRATOR_CAPABILITY_SESSION_PLUGINS_DIR`),
 * only as that root's own content-addressed children (no link, no nesting),
 * and only when each holds a plugin manifest. A read-only turn (a coordinator
 * or a review) loads none: a skill's frontmatter can declare hooks and tool
 * grants, which that boundary does not admit.
 */
import { lstat, realpath, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, join } from "node:path";
import {
  CAPABILITY_SESSION_PLUGINS_DIR_ENV,
  MAX_CAPABILITY_SESSION_PLUGINS,
} from "@orkestrator/protocol/capability-resources";
import type { NativeAgentExecutionPolicy } from "@orkestrator/protocol/native-agent";
import { createLogger } from "@orkestrator/protocol/logger";
import type { SdkPluginConfig } from "./plugin-config.js";
import { isCoordinatorReadOnlyPolicy } from "./read-only-policy.js";

const log = createLogger("bridge.claude");

const DIGEST_NAME = /^[0-9a-f]{16,64}$/;

/** The prompt body's `capabilityPlugins`, bounded; anything else is dropped. */
export function parseCapabilityPlugins(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const paths = value
    .filter(
      (entry): entry is string =>
        typeof entry === "string" && entry.length > 0 && entry.length <= 4096,
    )
    .slice(0, MAX_CAPABILITY_SESSION_PLUGINS);
  return paths.length > 0 ? paths : undefined;
}

/**
 * The inline plugins a turn passes for its session's private capabilities.
 * A path outside the backend's root, or not a plugin, is refused and logged
 * (content-free), never followed.
 */
export async function capabilitySessionPlugins(
  paths: readonly string[] | undefined,
  policy: NativeAgentExecutionPolicy | undefined,
  env: NodeJS.ProcessEnv = process.env,
): Promise<SdkPluginConfig[]> {
  if (!paths || paths.length === 0) return [];
  if (isCoordinatorReadOnlyPolicy(policy)) return [];
  const root = env[CAPABILITY_SESSION_PLUGINS_DIR_ENV];
  if (!root || !isAbsolute(root)) {
    log.warn("capability-plugins.refused", { reason: "no-root", count: paths.length });
    return [];
  }
  const realRoot = await realpath(root).catch(() => undefined);
  if (!realRoot) {
    log.warn("capability-plugins.refused", { reason: "root-missing", count: paths.length });
    return [];
  }
  const accepted: SdkPluginConfig[] = [];
  for (const path of paths) {
    if (!(await acceptable(path, realRoot))) {
      log.warn("capability-plugins.refused", { reason: "outside-root", count: 1 });
      continue;
    }
    accepted.push({ type: "local", path });
  }
  return accepted;
}

async function acceptable(path: string, realRoot: string): Promise<boolean> {
  if (!isAbsolute(path) || !DIGEST_NAME.test(basename(path))) return false;
  try {
    if ((await realpath(dirname(path))) !== realRoot) return false;
    const entry = await lstat(path);
    if (!entry.isDirectory() || entry.isSymbolicLink()) return false;
    const manifest = await stat(join(path, ".claude-plugin", "plugin.json"));
    return manifest.isFile();
  } catch {
    return false;
  }
}
