import { canonicalJson } from "@orkestrator/protocol/canonical-json";
import { INHERITED_GLOBAL_SETTING_KEYS } from "@orkestrator/protocol/controller-settings";

import { stripRendererCredentials } from "../commands-validation.js";

/**
 * Machine administration a workspace client (a client grant or the relay)
 * never runs. A workspace is agent chat, terminals, previews, files and the
 * project boards; the machine's own settings, credentials and updates belong
 * to its user and are reached from Settings, which the window runs on its
 * command node and sends to another machine with `invoke_on_node`.
 *
 * This is a deny-list (security report I1): a new administration command
 * fails open until it is added here, so add it with the command.
 */
export const WORKSPACE_ADMINISTRATION_COMMANDS: ReadonlySet<string> = new Set([
  // Operator public API has no workspace renderer callers. Refuse the whole
  // entrypoint, including indirect operation retries and node-targeted actions.
  "public_action",
  // Global settings. An older realm's no-op echo is still answered; see
  // `isGlobalConfigEcho`.
  "save_config",
  "update_global_config",
  "patch_global_config",
  "update_notification_sound_settings",
  "set_workflow_result_tools_rollout",
  "web_annotations_rollout_set",
  "save_desktop_connections",
  // Installation-wide Docker budget and cleanup (including cleanup tokens).
  "set_container_resource_limits",
  "docker_cleanup_preview",
  "docker_cleanup_execute",
  // Machine credentials stored in the global settings.
  "set_github_token",
  "set_cursor_api_key",
  "set_anthropic_api_key",
  "set_opencode_zen_api_key",
  // The machine's identity, storage, preview publication and logs.
  "update_backend_profile",
  "update_worktree_locations",
  "update_preview_settings",
  "cleanup_logs",
  "get_database_stats",
  "plan_diagnostics_bundle",
  "read_diagnostics_bundle",
  "record_renderer_errors",
  "record_domain_adapter_usage",
  "graph_capability_ceiling_set",
  // Host updates and dependency maintenance.
  "request_host_update_check",
  "request_host_update",
  "cancel_host_update",
  "start_host_toolchain_repair",
  "start_host_image_update",
  "set_host_update_channel",
  "set_host_gh_channel",
]);

const GLOBAL_CONFIG_WRITES: ReadonlySet<string> = new Set([
  "update_global_config",
  "patch_global_config",
]);

const INHERITED_KEYS: ReadonlySet<string> = new Set(INHERITED_GLOBAL_SETTING_KEYS);

/**
 * Settings nothing reads any more. An older client's form still sends them,
 * whatever this machine stores, so they say nothing about whether a write
 * would change the machine. See the version compatibility register.
 */
const RETIRED_GLOBAL_SETTING_KEYS: ReadonlySet<string> = new Set([
  "experimentalCodexRawEventLogging",
]);

export function isGlobalConfigWriteCommand(command: string): boolean {
  return GLOBAL_CONFIG_WRITES.has(command);
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** Equal as JSON, with absent and `undefined` alike. */
function sameJson(left: unknown, right: unknown): boolean {
  if (left === undefined || right === undefined) return left === right;
  try {
    return (
      canonicalJson(JSON.parse(JSON.stringify(left))) ===
      canonicalJson(JSON.parse(JSON.stringify(right)))
    );
  } catch {
    return false;
  }
}

/**
 * Whether a refused global-settings write would change nothing on this
 * machine, so a workspace client may be answered with the current settings
 * instead of a refusal.
 *
 * Realms of releases before `patch_global_config` (v2.35.1-beta and earlier)
 * save a model favourite on the command node and then send the leaf's own
 * settings back to it unchanged, with `preserveInheritedSettings`. That
 * write never changed the leaf; answering it keeps those realms working.
 * Any write that would change a stored setting is still refused. Credentials
 * are left out of the comparison: both commands keep the stored ones.
 *
 * `current` is this machine's `get_config` answer.
 */
export function isGlobalConfigEcho(command: string, args: unknown, current: unknown): boolean {
  const stored = record(record(current)?.global);
  const input = record(args);
  if (!stored || !input) return false;
  const storedGlobal = stripRendererCredentials(stored) as Record<string, unknown>;
  if (command === "update_global_config") {
    const incoming = record(input.global);
    if (!incoming) return false;
    const preserveInherited = input.preserveInheritedSettings === true;
    const incomingGlobal = stripRendererCredentials(incoming) as Record<string, unknown>;
    const keys = new Set([...Object.keys(storedGlobal), ...Object.keys(incomingGlobal)]);
    for (const key of keys) {
      if (preserveInherited && INHERITED_KEYS.has(key)) continue;
      if (RETIRED_GLOBAL_SETTING_KEYS.has(key)) continue;
      if (!sameJson(incomingGlobal[key], storedGlobal[key])) return false;
    }
    return true;
  }
  if (command === "patch_global_config") {
    const patch = record(input.patch ?? {});
    if (!patch) return false;
    const unset = input.unset ?? [];
    if (!Array.isArray(unset)) return false;
    const patchGlobal = stripRendererCredentials(patch) as Record<string, unknown>;
    for (const [key, value] of Object.entries(patchGlobal)) {
      if (RETIRED_GLOBAL_SETTING_KEYS.has(key)) continue;
      if (!sameJson(value, storedGlobal[key])) return false;
    }
    return unset.every((key) => typeof key === "string" && storedGlobal[key] === undefined);
  }
  return false;
}
