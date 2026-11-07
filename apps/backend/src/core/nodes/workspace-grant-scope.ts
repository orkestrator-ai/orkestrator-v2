import { canonicalJson } from "@orkestrator/protocol/canonical-json";
import type { CommandAccess } from "@orkestrator/protocol/contract/command";
import { INHERITED_GLOBAL_SETTING_KEYS } from "@orkestrator/protocol/controller-settings";

import { stripRendererCredentials } from "../commands-validation.js";
import { crossCheckLegacyWorkspaceScope } from "./workspace-grant-legacy-check.js";

/**
 * The workspace grant allow-list (report §10.2, plan item 7012).
 *
 * A workspace client (a client grant at this gateway, or the relay through
 * this command node) runs exactly the commands whose definition declares
 * `access: "workspace"`: agent chat, terminals, previews, files and the
 * project boards. Everything else is refused, failing closed: an `admin`
 * command (the machine's own settings, credentials and updates, which
 * Settings runs on the command node and sends to another machine with
 * `invoke_on_node`), an `internal` one (node-link and in-process plumbing), a
 * command registered without a definition, and a name this backend does not
 * know. A new command is refused through a grant until its definition says
 * otherwise.
 *
 * The set is the registry's own definitions, which the committed manifest
 * (`packages/protocol/contracts/manifest.json`) is generated from, so the two
 * cannot differ while `mise run contract:check` passes.
 */

/** A command's declared access, or `undefined` for one without a definition. */
export type CommandAccessOf = (command: string) => CommandAccess | undefined;

/** Which workspace path asked: a client grant here, or the relay to a leaf. */
export type WorkspaceGrantPath = "grant" | "relay";

/** Whether a workspace client may run `command`: only an `access: "workspace"` definition. */
export function isWorkspaceGrantCommand(command: string, accessOf: CommandAccessOf): boolean {
  return accessOf(command) === "workspace";
}

/** The allow-list of a registry's definitions: the manifest's `access: "workspace"` set. */
export function workspaceAllowList(
  contracts: ReadonlyMap<string, { readonly access: CommandAccess }>,
): ReadonlySet<string> {
  const names = new Set<string>();
  for (const [name, def] of contracts) if (def.access === "workspace") names.add(name);
  return names;
}

/**
 * The gate the gateway and the relay call. `accessOf` and `isRegistered` read
 * this backend's registry; without them every command is refused. While debug
 * logging is on for `nodes`, each verdict is also checked against the old
 * deny-lists' (`legacyWorkspaceAdmitted`), for one release.
 */
export function admitsWorkspaceCommand(
  command: string,
  path: WorkspaceGrantPath,
  registry: {
    readonly accessOf?: CommandAccessOf | undefined;
    readonly isRegistered?: ((command: string) => boolean) | undefined;
  },
): boolean {
  const admitted = registry.accessOf ? isWorkspaceGrantCommand(command, registry.accessOf) : false;
  crossCheckLegacyWorkspaceScope(command, path, admitted, registry.isRegistered);
  return admitted;
}

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
