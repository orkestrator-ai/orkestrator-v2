/**
 * The one description of how an ACP-speaking platform is launched.
 *
 * Grok and Antigravity both run on `bridges/acp-bridge`, as separate
 * processes with separate state. The bridge's behaviour for each comes from
 * a launcher record (`ACP_PROVIDER_CONFIG`) the backend builds. The host
 * bridge (`commands/servers.ts`), the cold catalogue probe
 * (`host-model-catalog-refresh.ts`) and the container launch
 * (`commands/registry-servers.ts`) all take it from here, so no launch path
 * can start Grok's flags for an Antigravity selection, or the other way round.
 *
 * Provider quirks that must hold whatever a record says stay in the bridge,
 * keyed by provider id (`bridges/acp-bridge/src/acp-provider-config.ts`).
 */
import { AGENT_PLATFORM_LABELS } from "@orkestrator/protocol/agent-platforms";
import type { AgentConversationMode } from "@orkestrator/protocol/native-agent";
import type { AcpLocalServerKind } from "./local-server-runtime.js";

export type { AcpLocalServerKind };

/** The platforms the ACP bridge runs. */
export const ACP_LOCAL_SERVER_KINDS = [
  "grok",
  "antigravity",
] as const satisfies readonly AcpLocalServerKind[];

export function isAcpLocalServerKind(value: unknown): value is AcpLocalServerKind {
  return ACP_LOCAL_SERVER_KINDS.includes(value as AcpLocalServerKind);
}

/** The managed toolchain entry each ACP platform runs (`packages/toolchain/src/manifest.ts`). */
export const ACP_TOOLCHAIN_NAMES: Readonly<Record<AcpLocalServerKind, string>> = Object.freeze({
  grok: "grok",
  antigravity: "antigravity",
});

/**
 * An argument every ACP bridge is started with, naming its provider. The
 * bridge ignores it; it is there so a process listing tells a Grok bridge
 * from an Antigravity one (`local-server-reaper.ts` markers, the container
 * `pkill` patterns), since both run the same entrypoint.
 */
export function acpBridgeProviderArgument(kind: AcpLocalServerKind): string {
  return `--provider=${kind}`;
}

/** The bridge's `AcpProviderConfig`, as JSON-serializable data. */
export interface AcpProviderLaunchRecord {
  id: AcpLocalServerKind;
  name: string;
  executable: string;
  argv: string[];
  env: Record<string, string>;
  requiresAuthenticate: boolean;
  authMethodEnv?: string;
  modeMap: Record<string, AgentConversationMode>;
  extensionPrefixes: string[];
  acknowledgedExtensionMethods: string[];
  modelUpdateMethods: string[];
  sessionUpdateMethods: string[];
}

/** The backend-owned variable that names Antigravity's ACP auth method, when one is chosen. */
export const ANTIGRAVITY_AUTH_METHOD_ENV = "ORKESTRATOR_ANTIGRAVITY_AUTH_METHOD";

/**
 * The launcher record for `kind`, running `executable`.
 *
 * Grok: `agent stdio` with its model and effort flags, x.ai extensions, and
 * `authenticate` with Grok's own method.
 *
 * Antigravity: `agy acp --process-per-session`. The flag serves each session
 * from its own worker, which is what makes agy 1.5.12 advertise HTTP MCP, so
 * Orkestrator's per-tab MCP connection can be handed to `session/new`
 * (observed: without it `initialize` has no `mcpCapabilities`). No model or
 * effort flag (both are session config options) and no vendor extensions.
 * `requiresAuthenticate` is false: agy's `authenticate` starts a browser
 * sign-in, while its stored login (`agy acp --login`) serves session
 * requests directly.
 */
export function acpProviderLaunchRecord(
  kind: AcpLocalServerKind,
  executable: string,
): AcpProviderLaunchRecord {
  if (kind === "antigravity") {
    return {
      id: "antigravity",
      name: AGENT_PLATFORM_LABELS.antigravity,
      executable,
      argv: ["acp", "--process-per-session"],
      env: {},
      requiresAuthenticate: false,
      authMethodEnv: ANTIGRAVITY_AUTH_METHOD_ENV,
      modeMap: { default: "build", plan: "plan" },
      extensionPrefixes: [],
      acknowledgedExtensionMethods: [],
      modelUpdateMethods: [],
      sessionUpdateMethods: [],
    };
  }
  return {
    id: "grok",
    name: AGENT_PLATFORM_LABELS.grok,
    executable,
    argv: ["--always-approve", "agent", "{{model}}", "{{effort}}", "stdio"],
    env: {},
    requiresAuthenticate: true,
    authMethodEnv: "GROK_AUTH_METHOD_ID",
    modeMap: {
      agent: "build",
      code: "build",
      build: "build",
      agentic: "build",
      plan: "plan",
      architect: "plan",
      ask: "plan",
    },
    extensionPrefixes: ["x.ai/", "_x.ai/"],
    acknowledgedExtensionMethods: [],
    modelUpdateMethods: ["x.ai/models/update", "_x.ai/models/update"],
    sessionUpdateMethods: ["x.ai/session/update", "_x.ai/session/update"],
  };
}

/**
 * The environment an ACP bridge for `kind` is started with: provider, agent
 * path, launcher record and a provider-scoped state directory, so two
 * providers in one environment never share a journal or state file.
 */
export function acpProviderLaunchEnv(
  kind: AcpLocalServerKind,
  options: { executable: string; stateDirectory?: string; appVersion?: string },
): Record<string, string> {
  return {
    ACP_PROVIDER: kind,
    ACP_AGENT_PATH: options.executable,
    ACP_PROVIDER_CONFIG: JSON.stringify(acpProviderLaunchRecord(kind, options.executable)),
    ...(options.stateDirectory ? { ACP_STATE_DIR: options.stateDirectory } : {}),
    // The bridge sends it as ACP `clientInfo.version`.
    ...(options.appVersion ? { ORKESTRATOR_VERSION: options.appVersion } : {}),
  };
}

/**
 * Why a platform's container bridge does not start, or undefined when it does.
 *
 * Antigravity is local-only for now. Its Google login lives in the host's OS
 * keyring, which cannot be copied into a container, and no container sign-in
 * route has been qualified; running agy on the host while presenting it as
 * the container's agent is not an option either.
 */
export function acpContainerUnavailableReason(kind: AcpLocalServerKind): string | undefined {
  return kind === "antigravity"
    ? "Antigravity is not available in containers yet: its sign-in lives in the host's keyring and cannot be handed to a container. Use a local environment for Antigravity."
    : undefined;
}
