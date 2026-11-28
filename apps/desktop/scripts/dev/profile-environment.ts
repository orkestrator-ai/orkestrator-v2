import os from "node:os";
import path from "node:path";

import {
  defaultRuntimeProfileRoots,
  RUNTIME_APP_SLUG,
  type RuntimeProfileRoots,
} from "@orkestrator/protocol/node/runtime-profile-status";

/**
 * The environment an agent-test profile inherits from whoever started it.
 *
 * `dev:test` and the agent-test runners are usually started by an agent that
 * the production Orkestrator app launched, so their shell holds that app's
 * own addresses and directories: the agent account's `CLAUDE_CONFIG_DIR`
 * inside the real data directory, `CLAUDE_CLI_PATH` in its `toolchains/`,
 * the agent MCP URL and token, the parent environment's `ORKESTRATOR_*`
 * identifiers and `NODE_ENV`. Passed through, a profile's Electron, Vite,
 * backend and bridges could use the production agent-account home, its
 * binaries or its MCP endpoint. This module removes them before anything is
 * spawned, so nobody has to unset them by hand.
 *
 * The scrub is a deny rule for the provider namespaces and an allow-list for
 * `ORKESTRATOR_*`: a new parent-app identifier is dropped without anyone
 * having to list it, while the documented test knobs below still reach the
 * profile. Values are never logged, only names.
 */

/**
 * Ports the installed app owns: its gateway and control ports, and the agent
 * tools port of the production install on the Linux qualification host. Kept
 * in step with `RESERVED_AGENT_TOOLS_PORTS` (`electron/runtime-profile.ts`).
 */
const RESERVED_PORTS = ["34121", "34122", "45507"] as const;

/**
 * `ORKESTRATOR_*` prefixes that name test knobs. A caller sets these on
 * purpose for a profile or the specs that drive it.
 */
const KEPT_ORKESTRATOR_PREFIXES = [
  "ORKESTRATOR_AGENT_TEST_",
  "ORKESTRATOR_CLAUDE_APPARMOR_",
  "ORKESTRATOR_E2E_",
  "ORKESTRATOR_LIVE_",
  "ORKESTRATOR_LOCAL_TRANSPORT_",
  "ORKESTRATOR_PI_CHATGPT_",
  "ORKESTRATOR_POLICY_",
  "ORKESTRATOR_PROVIDER_RECORD_",
  "ORKESTRATOR_TEST_",
] as const;

/** Single `ORKESTRATOR_*` knobs (switches, levels, test inputs), never addresses of the parent app. */
const KEPT_ORKESTRATOR_NAMES = new Set([
  "ORKESTRATOR_BRIDGE_DEBUG",
  "ORKESTRATOR_CLI_CONFIG_DIR",
  "ORKESTRATOR_CONTROL_MCP_PORT",
  "ORKESTRATOR_COOPERATIVE_STALE_MS",
  "ORKESTRATOR_COOPERATIVE_STARTUP_MS",
  "ORKESTRATOR_DEV_PROCESS_MEMORY_MS",
  "ORKESTRATOR_DISABLE_AUTO_UPDATE",
  "ORKESTRATOR_GATEWAY_COMPRESSION",
  "ORKESTRATOR_HOST_REACHABILITY_CHECK",
  "ORKESTRATOR_KEYED_SCHEDULING_ROLLBACK",
  "ORKESTRATOR_LOG_LEVEL",
  "ORKESTRATOR_NATIVE_MENU_INPUT",
  "ORKESTRATOR_NATIVE_OBSERVATION_SHARING",
  "ORKESTRATOR_NATIVE_SHORTCUT_INPUT",
  "ORKESTRATOR_PACKAGED_APP_EXECUTABLE",
  "ORKESTRATOR_PREVIEW_RELAY",
  "ORKESTRATOR_PREVIEW_TRANSPORT",
  "ORKESTRATOR_PROFILE",
  "ORKESTRATOR_PROFILE_FLAVOR",
  "ORKESTRATOR_PUBLIC_E2E_PORT",
  "ORKESTRATOR_QUALIFICATION_DOCKER",
  "ORKESTRATOR_RECURRING_METRICS",
  "ORKESTRATOR_REVIEW_VALIDATION",
  "ORKESTRATOR_SCENARIO_MODEL",
  "ORKESTRATOR_SHIPPED_APP_EXECUTABLE",
  "ORKESTRATOR_TMUX_HOLD_CONTAINER_IMAGE",
  "ORKESTRATOR_VALIDATION_GRANTED_WORKERS",
]);

/**
 * `ORKESTRATOR_AGENT_TEST_*` names a profile's own backend sets for its
 * children. Inherited (an agent inside one profile starting another) they
 * describe the parent profile, so they are dropped like any parent value
 * rather than kept as knobs.
 */
const PARENT_PROFILE_PREFIXES = ["ORKESTRATOR_AGENT_TEST_HOST_"] as const;
const PARENT_PROFILE_NAMES = new Set([
  "ORKESTRATOR_AGENT_TEST_ISOLATED",
  "ORKESTRATOR_AGENT_TEST_HIDDEN_WINDOWS",
]);

/**
 * Provider variables kept only while their value stays outside the
 * production data directory: each is a route the `--credential-source`
 * seeding reads to find the host's own login, or a credential the backend
 * forwards only for an authorized source.
 */
const KEPT_PROVIDER_NAMES = new Set(["ANTHROPIC_API_KEY", "CLAUDE_CONFIG_DIR", "CODEX_HOME"]);

/** Never path-checked: the launcher's own location and home. */
const PATH_CHECK_EXEMPT = new Set(["HOME", "OLDPWD", "PWD", "PATH"]);

export type ProfileEnvironmentScrub = {
  /** The environment to hand the profile's processes. */
  env: NodeJS.ProcessEnv;
  /** Names of the inherited variables removed, sorted. Never their values. */
  dropped: string[];
  /** How many `PATH` entries inside the production data directory were removed. */
  droppedPathEntries: number;
};

export type ProfileEnvironmentOptions = {
  roots?: Pick<RuntimeProfileRoots, "productionDataDir" | "homeDir">;
  platform?: NodeJS.Platform;
};

/** Orkestrator data directories a value must not point into. */
function productionDataDirs(base: NodeJS.ProcessEnv, options: ProfileEnvironmentOptions): string[] {
  const platform = options.platform ?? process.platform;
  const roots =
    options.roots ??
    (platform === "win32" ? undefined : defaultRuntimeProfileRoots(platform, base));
  const homeDir = options.roots?.homeDir ?? os.homedir();
  // The canonical locations as well as the resolved one: a Linux shell with a
  // custom XDG_CONFIG_HOME may still name the default directory.
  const candidates = [
    roots?.productionDataDir,
    path.join(homeDir, "Library", "Application Support", RUNTIME_APP_SLUG),
    path.join(homeDir, ".config", RUNTIME_APP_SLUG),
  ].filter((entry): entry is string => Boolean(entry));
  return [...new Set(candidates.map((entry) => path.resolve(entry)))];
}

function isSameOrInside(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function expandHome(value: string, homeDir: string): string {
  return value === "~" || value.startsWith("~/") ? path.join(homeDir, value.slice(1)) : value;
}

/** Whether any `:`-separated absolute path in `value` lies inside a data directory. */
function pointsIntoDataDir(value: string, dataDirs: readonly string[], homeDir: string): boolean {
  return value.split(path.delimiter).some((segment) => {
    const expanded = expandHome(segment.trim(), homeDir);
    if (!path.isAbsolute(expanded)) return false;
    const resolved = path.resolve(expanded);
    return dataDirs.some((root) => isSameOrInside(resolved, root));
  });
}

/** Whether `value` is, or addresses, one of the installed app's ports. */
function addressesReservedPort(value: string): boolean {
  const trimmed = value.trim();
  return RESERVED_PORTS.some(
    (port) => trimmed === port || new RegExp(`:${port}(?![0-9])`).test(trimmed),
  );
}

/** Whether `name` is a documented knob the profile keeps. */
export function isKeptProfileKnob(name: string): boolean {
  if (!name.startsWith("ORKESTRATOR_")) return false;
  if (PARENT_PROFILE_NAMES.has(name)) return false;
  if (PARENT_PROFILE_PREFIXES.some((prefix) => name.startsWith(prefix))) return false;
  return (
    KEPT_ORKESTRATOR_NAMES.has(name) ||
    KEPT_ORKESTRATOR_PREFIXES.some((prefix) => name.startsWith(prefix))
  );
}

/**
 * Whether `name` is dropped whatever its value: `NODE_ENV`, agent CLI path
 * overrides (a profile runs only its own managed toolchain), the parent
 * agent session's `CLAUDE*`, `ANTHROPIC_*` and `CODEX_*` variables, and
 * every `ORKESTRATOR_*` name that is not a documented knob.
 */
function droppedByName(name: string): boolean {
  if (name === "NODE_ENV") return true;
  if (name.endsWith("_CLI_PATH")) return true;
  if (KEPT_PROVIDER_NAMES.has(name)) return false;
  if (name.startsWith("CLAUDE") || name.startsWith("ANTHROPIC_") || name.startsWith("CODEX_")) {
    return true;
  }
  return name.startsWith("ORKESTRATOR_") && !isKeptProfileKnob(name);
}

/**
 * The environment an agent-test profile's processes receive, with every
 * inherited variable that points at the parent Orkestrator install removed.
 *
 * Throws, naming the variable but never its value, when a documented knob
 * the profile would otherwise keep points into the production data directory
 * or at one of the installed app's ports: such a value is both legitimate and
 * risky, so the start is refused rather than silently passing or dropping it.
 */
export function scrubProfileEnvironment(
  base: NodeJS.ProcessEnv,
  options: ProfileEnvironmentOptions = {},
): ProfileEnvironmentScrub {
  const dataDirs = productionDataDirs(base, options);
  const homeDir = options.roots?.homeDir ?? os.homedir();
  const env: NodeJS.ProcessEnv = {};
  const dropped: string[] = [];
  const refused: string[] = [];
  let droppedPathEntries = 0;
  for (const [name, value] of Object.entries(base)) {
    if (value === undefined) continue;
    if (name === "PATH") {
      const entries = value.split(path.delimiter);
      const kept = entries.filter((entry) => !pointsIntoDataDir(entry, dataDirs, homeDir));
      droppedPathEntries = entries.length - kept.length;
      env.PATH = kept.join(path.delimiter);
      continue;
    }
    if (droppedByName(name)) {
      dropped.push(name);
      continue;
    }
    const risky =
      (!PATH_CHECK_EXEMPT.has(name) && pointsIntoDataDir(value, dataDirs, homeDir)) ||
      addressesReservedPort(value);
    if (risky && isKeptProfileKnob(name)) {
      refused.push(name);
      continue;
    }
    if (risky) {
      dropped.push(name);
      continue;
    }
    env[name] = value;
  }
  if (refused.length > 0) {
    refused.sort();
    throw new Error(
      `Refusing to start the profile: ${refused.join(", ")} ${refused.length === 1 ? "points" : "point"} into the production Orkestrator data directory or at a port the installed app owns (${RESERVED_PORTS.join(", ")}). Unset ${refused.length === 1 ? "it" : "them"} or point ${refused.length === 1 ? "it" : "them"} at the profile's own state.`,
    );
  }
  dropped.sort();
  return { env, dropped, droppedPathEntries };
}

/**
 * The launcher's log line for a scrub, or `null` when nothing was removed.
 * Names only: values can hold tokens and account paths.
 */
export function formatProfileEnvironmentScrub(
  scrub: Pick<ProfileEnvironmentScrub, "dropped" | "droppedPathEntries">,
): string | null {
  const parts: string[] = [];
  if (scrub.dropped.length > 0) {
    parts.push(
      `dropped ${scrub.dropped.length} inherited environment ${scrub.dropped.length === 1 ? "variable" : "variables"} that could reach the parent Orkestrator install: ${scrub.dropped.join(", ")}`,
    );
  }
  if (scrub.droppedPathEntries > 0) {
    parts.push(
      `removed ${scrub.droppedPathEntries} PATH ${scrub.droppedPathEntries === 1 ? "entry" : "entries"} inside the production data directory`,
    );
  }
  if (parts.length === 0) return null;
  const sentence = parts.join("; ");
  return `Profile environment: ${sentence} (values not shown).`;
}
