/**
 * An administrator-managed Codex host (8085 (retired)).
 *
 * An administrator can constrain every Codex session on a machine through
 * `/etc/codex/requirements.toml` (or MDM). Two of its settings bear on how a
 * session runs here:
 *
 * - `allowed_sandbox_modes`: Codex refuses a thread or turn that asks for a
 *   mode outside the list. Orkestrator's host default asks for
 *   `danger-full-access` (no sandbox), so on a host that leaves it out every
 *   turn of a default session was refused. The bridge narrows such a request
 *   to the widest mode the administrator allows instead.
 * - `[network_proxy] enabled`: Codex routes and asks about network access
 *   only inside its own sandbox, so a session without one bypasses the proxy.
 *   Nothing changes there (the administrator's lever is the sandbox list); the
 *   reported policy says so.
 *
 * The bridge never reads `/etc` itself: app-server answers
 * `configRequirements/read` with the effective requirements. Verified against
 * Codex 0.167.0 and 0.169.0, which report `network` there even without the experimental
 * API, although the generated bindings do not declare it.
 */
import {
  appendNativeAgentPolicyNote,
  type NativeAgentExecutionPolicy,
} from "@orkestrator/protocol/native-agent";
import { createLogger, formatLogError } from "@orkestrator/protocol/logger";
import { AppServerRpcError, JSON_RPC_METHOD_NOT_FOUND } from "./app-server/errors.js";
import type { EngineGeneration, EngineTurnConfig } from "./engine/types.js";

const log = createLogger("bridge.codex");

export type CodexSandboxMode = NonNullable<EngineTurnConfig["sandbox"]>;

/** Widest first: narrowing walks down this list, never up. */
const SANDBOX_MODES_BY_ACCESS: readonly CodexSandboxMode[] = [
  "danger-full-access",
  "workspace-write",
  "read-only",
];

/** What the administrator's Codex requirements say about sandboxes. */
export interface CodexManagedRequirements {
  /** Modes Codex accepts; absent when the requirements do not restrict them. */
  allowedSandboxModes?: readonly CodexSandboxMode[];
  /** The administrator's network proxy is on. */
  networkProxy: boolean;
}

/**
 * Read a `configRequirements/read` answer. `null` when the host has no
 * requirements; `undefined` when the answer is not one this bridge can read,
 * which leaves every session as it was.
 */
export function parseCodexManagedRequirements(
  response: unknown,
): CodexManagedRequirements | null | undefined {
  if (!isRecord(response) || !("requirements" in response)) return undefined;
  const requirements = response.requirements;
  if (requirements === null) return null;
  if (!isRecord(requirements)) return undefined;
  const modes = requirements.allowedSandboxModes;
  const allowedSandboxModes = Array.isArray(modes)
    ? SANDBOX_MODES_BY_ACCESS.filter((mode) => modes.includes(mode))
    : undefined;
  const network = requirements.network;
  return {
    ...(allowedSandboxModes ? { allowedSandboxModes } : {}),
    networkProxy: isRecord(network) && network.enabled === true,
  };
}

/**
 * Whether the administrator's sandbox list governs this configuration.
 *
 * Not where something else already decided the sandbox for a reason narrowing
 * would break: a permission profile sends no sandbox mode at all; a read-only
 * turn without Codex's command sandbox runs where that sandbox cannot start,
 * and so does a container session, whose boundary is the container. There a
 * narrowed sandbox would fail every command, so Codex's own refusal stands.
 */
function governedBySandboxList(config: EngineTurnConfig): boolean {
  return (
    !config.permissionProfile &&
    config.readOnlyCommandSandboxOff === undefined &&
    config.policy?.sandbox !== "container"
  );
}

/**
 * The sandbox mode Codex will accept for `config`: the requested one when the
 * administrator allows it, else the widest allowed mode narrower than it. A
 * request no narrower mode can satisfy is left for Codex to refuse.
 */
export function codexManagedSandbox(
  config: EngineTurnConfig,
  requirements: CodexManagedRequirements | null | undefined,
): EngineTurnConfig["sandbox"] {
  const requested = config.sandbox ?? (config.mode === "plan" ? "read-only" : "danger-full-access");
  const allowed = requirements?.allowedSandboxModes;
  if (!allowed || !governedBySandboxList(config) || allowed.includes(requested)) {
    return config.sandbox;
  }
  const narrower = SANDBOX_MODES_BY_ACCESS.slice(SANDBOX_MODES_BY_ACCESS.indexOf(requested) + 1);
  return narrower.find((mode) => allowed.includes(mode)) ?? config.sandbox;
}

/** `config` as app-server will accept it on this host. */
export function codexManagedTurnConfig(
  config: EngineTurnConfig,
  requirements: CodexManagedRequirements | null | undefined,
): EngineTurnConfig {
  const sandbox = codexManagedSandbox(config, requirements);
  return sandbox === config.sandbox ? config : { ...config, sandbox };
}

/**
 * Whether a thread with this configuration needs the requirements read first:
 * only a request the administrator could refuse. A read-only request is the
 * narrowest there is.
 */
export function codexNeedsManagedRequirements(config: EngineTurnConfig): boolean {
  return (
    governedBySandboxList(config) &&
    (config.sandbox ?? (config.mode === "plan" ? "read-only" : "danger-full-access")) !==
      "read-only"
  );
}

export const CODEX_MANAGED_WORKSPACE_SANDBOX_NOTE =
  "This host's Codex requirements, set by its administrator, do not allow running without Codex's sandbox, so this session runs in Codex's workspace-write sandbox. That sandbox holds the repository's .git directory read-only, so Git commands that write to it may be refused.";

export const CODEX_MANAGED_READ_ONLY_SANDBOX_NOTE =
  "This host's Codex requirements, set by its administrator, allow only Codex's read-only sandbox, so this session runs in it and cannot change files.";

export const CODEX_MANAGED_NETWORK_PROXY_NOTE =
  "This host's Codex requirements turn on the administrator's network proxy, which Codex applies only inside its own sandbox. This session runs without one, so its network requests bypass the proxy. Choose the provider sandbox under Settings -> Execution policy to apply it.";

/**
 * The policy a session reports: what it applies on this host, not what it was
 * sent (`native-agent-policy-effects.ts`). A sandbox the administrator
 * narrowed reads as the provider sandbox with a note saying why; a session
 * that runs without a sandbox while the administrator's proxy is on says the
 * proxy does not apply to it.
 */
export function codexManagedReportedPolicy(
  config: EngineTurnConfig,
  requirements: CodexManagedRequirements | null | undefined,
): NativeAgentExecutionPolicy | undefined {
  const policy = config.policy;
  if (!policy || !requirements) return policy;
  const sandbox = codexManagedSandbox(config, requirements);
  if (sandbox !== config.sandbox) {
    return appendNativeAgentPolicyNote(
      { ...policy, sandbox: "provider" },
      sandbox === "read-only"
        ? CODEX_MANAGED_READ_ONLY_SANDBOX_NOTE
        : CODEX_MANAGED_WORKSPACE_SANDBOX_NOTE,
    );
  }
  if (
    requirements.networkProxy &&
    policy.sandbox === "none" &&
    (config.sandbox ?? "danger-full-access") === "danger-full-access"
  ) {
    return appendNativeAgentPolicyNote(policy, CODEX_MANAGED_NETWORK_PROXY_NOTE);
  }
  return policy;
}

/** One generation's read. */
interface GenerationRead {
  generation: EngineGeneration;
  read: Promise<CodexManagedRequirements | null | undefined>;
  settled: boolean;
  value: CodexManagedRequirements | null | undefined;
}

/**
 * Each app-server generation's `configRequirements/read`, asked at most once.
 *
 * A read app-server answered, even with an error (an older Codex without the
 * method), is kept for the generation. One the transport lost is asked again
 * by the next thread or turn. A failed read yields `undefined`, which leaves
 * every session's sandbox as it asked.
 */
export class CodexManagedRequirementsReader {
  private current: GenerationRead | null = null;

  constructor(private readonly request: (generation: EngineGeneration) => Promise<unknown>) {}

  /** The settled answer for `generation`, without asking. */
  known(generation: EngineGeneration): CodexManagedRequirements | null | undefined {
    const entry = this.current;
    return entry?.settled && entry.generation === generation ? entry.value : undefined;
  }

  read(generation: EngineGeneration): Promise<CodexManagedRequirements | null | undefined> {
    if (this.current?.generation === generation) return this.current.read;
    const entry: GenerationRead = {
      generation,
      read: Promise.resolve(undefined),
      settled: false,
      value: undefined,
    };
    entry.read = this.request(generation)
      .then(parseCodexManagedRequirements, (error: unknown) => {
        if (!(error instanceof AppServerRpcError) && this.current === entry) this.current = null;
        if (!(error instanceof AppServerRpcError && error.code === JSON_RPC_METHOD_NOT_FOUND)) {
          log.warn("managed-requirements.unreadable", {
            error: formatLogError(error, { stack: false }),
          });
        }
        return undefined;
      })
      .then((value) => {
        entry.value = value;
        entry.settled = true;
        return value;
      });
    this.current = entry;
    return entry.read;
  }

  /** The generation exited: its answer describes nothing that runs. */
  forget(): void {
    this.current = null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
