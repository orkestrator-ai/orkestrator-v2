/**
 * Which OpenCode line a native session runs on
 * (docs/todo/agent-engines/0008-opencode-v2.md, build plan phase 3).
 *
 * The decision is made once, by the backend, when a session is created, and
 * stored on its record (`openCodeProtocol: "v2"`). Only new interactive tabs
 * of an ordinary local environment, or of a container environment whose image
 * runs 2.x (`containerRunsOpenCode2`), take 2.x, and only while the setting
 * asks for it: coordinators create their sessions with other origins or
 * owners, and a container from an older image stays on 1.x. Everything else,
 * every existing record included, is 1.x.
 *
 * Workflows (build pipelines, Multi Review, graph agent nodes) follow the same
 * switch through their own providers (`openCodeWorkflowRoutingDependencies`),
 * in local environments only for now: the line is chosen when a session is
 * created and recorded in the `opencode2-sessions` store before the id is
 * handed out.
 */
import type { AgentInteractionOrigin } from "@orkestrator/protocol/agent-interactions";
import type { AgentSessionOwner } from "@orkestrator/protocol/coordinator";
import {
  nativeAgentCapabilities,
  normalizeOpenCodeModelProviders,
} from "@orkestrator/protocol/native-agent";
import { resolveOpenCodeProtocol } from "@orkestrator/protocol/opencode-protocol";
import type { ProviderCreateSessionOptions } from "./agent-provider-contract.js";
import type { Environment, PersistedNativeAgentSession } from "./models.js";
import type { OpenCode2SessionsStorage } from "./storage-opencode2-sessions.js";
import type { OpenCodeRoutingDependencies } from "./opencode2/routing-provider.js";
import type { NativeAgentServiceOptions } from "./native-agent-service-shared.js";

/** What the selection reads of an environment. */
export type OpenCode2SessionEnvironment = Pick<
  Environment,
  "environmentType" | "containerId" | "containerLifecycle"
>;

export interface NewOpenCodeSessionInput {
  agent: string;
  origin?: AgentInteractionOrigin;
  owner?: AgentSessionOwner;
  executionPolicy?: string;
}

/** `"v2"` when a session created now should run on OpenCode 2.x, else undefined (1.x). */
export function newOpenCodeSessionProtocol(
  input: NewOpenCodeSessionInput,
  environment: Pick<Environment, "environmentType"> | null | undefined,
  setting: unknown,
  available: boolean,
  containerRunsV2 = false,
): "v2" | undefined {
  if (input.agent !== "opencode" || !available) return undefined;
  if (resolveOpenCodeProtocol(setting) !== "v2") return undefined;
  if ((input.origin ?? "interactive-native") !== "interactive-native") return undefined;
  if (input.owner && input.owner.kind !== "environment") return undefined;
  if (input.executionPolicy) return undefined;
  const type = environment?.environmentType;
  if (type !== "local" && !(type === "containerized" && containerRunsV2)) return undefined;
  return "v2";
}

/**
 * {@link newOpenCodeSessionProtocol} for one `ensureSession` request, reading
 * the environment and the setting. Only a backend with a 2.x host can answer
 * `"v2"`; an unreadable environment or setting keeps the default line.
 */
export async function selectNewOpenCodeSessionProtocol(
  storage: {
    getEnvironment(environmentId: string): Promise<OpenCode2SessionEnvironment | null>;
    loadConfig(): Promise<{ global: { openCodeProtocol?: unknown } }>;
  },
  options: Pick<NativeAgentServiceOptions, "openCode2HostServer" | "openCode2InContainer">,
  input: NewOpenCodeSessionInput & { environmentId: string },
): Promise<"v2" | undefined> {
  if (input.agent !== "opencode" || !options.openCode2HostServer) return undefined;
  try {
    const [environment, config] = await Promise.all([
      storage.getEnvironment(input.environmentId),
      storage.loadConfig(),
    ]);
    const setting = config.global.openCodeProtocol;
    // Everything but the image first, so a 1.x answer never reads Docker.
    if (!newOpenCodeSessionProtocol(input, environment, setting, true, true)) return undefined;
    if (environment?.environmentType !== "containerized") return "v2";
    const inContainer = options.openCode2InContainer;
    return inContainer && (await inContainer(environment)) ? "v2" : undefined;
  } catch {
    return undefined;
  }
}

type SessionReader = {
  readNativeAgentSessionsSnapshot?: () => Promise<readonly PersistedNativeAgentSession[]>;
  listNativeAgentSessions?: () => Promise<readonly PersistedNativeAgentSession[]>;
  /** The 2.x sessions workflows created (`storage-opencode2-sessions.ts`). */
  openCode2Sessions?: Pick<OpenCode2SessionsStorage, "isOpenCode2Session">;
};

/**
 * The persisted line of one environment's OpenCode provider session: a
 * native record's marker, or the workflow record of a 2.x session a build
 * pipeline, Multi Review or graph created (and a tab may later open).
 */
export async function persistedOpenCodeProtocol(
  storage: SessionReader,
  environmentId: string,
  providerSessionId: string,
): Promise<"v2" | undefined> {
  if (storage.openCode2Sessions?.isOpenCode2Session(environmentId, providerSessionId)) return "v2";
  const sessions = storage.readNativeAgentSessionsSnapshot
    ? await storage.readNativeAgentSessionsSnapshot()
    : storage.listNativeAgentSessions
      ? await storage.listNativeAgentSessions()
      : [];
  return sessions.some(
    (session) =>
      session.environmentId === environmentId &&
      session.agent === "opencode" &&
      session.providerSessionId === providerSessionId &&
      session.openCodeProtocol === "v2",
  )
    ? "v2"
    : undefined;
}

/** The routing dependencies of one environment's OpenCode provider, or undefined without a 2.x host. */
export function openCodeRoutingDependencies(
  options: Pick<NativeAgentServiceOptions, "openCode2HostServer" | "openCode2InContainer">,
  storage: SessionReader & {
    loadConfig?: () => Promise<{
      global: { openCodeProtocol?: unknown; openCodeModelProviders?: unknown };
    }>;
    getEnvironment?: (environmentId: string) => Promise<OpenCode2SessionEnvironment | null>;
  },
  environmentId: string,
): OpenCodeRoutingDependencies | undefined {
  const host = options.openCode2HostServer;
  if (!host) return undefined;
  // Read per call, as the 1.x catalogue does: a settings edit applies at once.
  const global = async () => (storage.loadConfig ? (await storage.loadConfig()).global : {});
  return {
    connection: (start) => host(environmentId, start),
    persistedProtocol: (sessionId) => persistedOpenCodeProtocol(storage, environmentId, sessionId),
    allowedModelProviders: async () =>
      normalizeOpenCodeModelProviders((await global()).openCodeModelProviders),
    // Whether a new interactive tab here would take 2.x: the setting, and an
    // environment that can serve it (local, or a container whose image runs 2.x).
    newSessionsUseV2: async () => {
      if (resolveOpenCodeProtocol((await global()).openCodeProtocol) !== "v2") return false;
      if (!storage.getEnvironment) return true;
      const environment = await storage.getEnvironment(environmentId).catch(() => null);
      if (!environment || environment.environmentType === "local") return true;
      if (environment.environmentType !== "containerized" || !options.openCode2InContainer) {
        return false;
      }
      return options.openCode2InContainer(environment).catch(() => false);
    },
  };
}

/**
 * Whether a workflow session created now (build pipeline, Multi Review,
 * graph) should run on OpenCode 2.x: the same switch as interactive tabs,
 * with what a workflow needs that a 2.x session cannot give it yet kept on
 * 1.x:
 *
 * - a coordinator's read-only policy (coordinators are not qualified on 2.x);
 * - an environment whose record of 2.x sessions is full.
 *
 * A policy that asks for approvals (or none, so the agent's defaults ask) is
 * served: a 2.x approval or question reaches the workflow's own card surface
 * through the provider's `interactions`, as a 1.x one does.
 */
export function newOpenCodeWorkflowSessionProtocol(
  options: Pick<ProviderCreateSessionOptions, "policy">,
  environment: Pick<Environment, "environmentType"> | null | undefined,
  setting: unknown,
  hasCapacity: boolean,
): "v2" | undefined {
  if (resolveOpenCodeProtocol(setting) !== "v2") return undefined;
  if (environment?.environmentType !== "local") return undefined;
  if (options.policy?.id === "coordinator-read-only") return undefined;
  return hasCapacity ? "v2" : undefined;
}

export type OpenCodeWorkflowStorage = SessionReader & {
  getEnvironment(environmentId: string): Promise<Pick<Environment, "environmentType"> | null>;
  loadConfig(): Promise<{ global: { openCodeProtocol?: unknown } }>;
  openCode2Sessions: Pick<
    OpenCode2SessionsStorage,
    "isOpenCode2Session" | "hasOpenCode2SessionCapacity" | "recordOpenCode2Session"
  >;
};

/**
 * The routing dependencies of a workflow provider for one environment, or
 * undefined without a 2.x host. The line is chosen per new session and
 * recorded before the session is handed out, so a run started on one line
 * stays there whatever the setting says later.
 */
export function openCodeWorkflowRoutingDependencies(
  host: NativeAgentServiceOptions["openCode2HostServer"],
  storage: OpenCodeWorkflowStorage,
  environmentId: string,
): OpenCodeRoutingDependencies | undefined {
  if (!host) return undefined;
  return {
    connection: (start) => host(environmentId, start),
    persistedProtocol: (sessionId) => persistedOpenCodeProtocol(storage, environmentId, sessionId),
    newSessionProtocol: async (options) => {
      const [environment, config] = await Promise.all([
        storage.getEnvironment(environmentId),
        storage.loadConfig(),
      ]);
      return newOpenCodeWorkflowSessionProtocol(
        options,
        environment,
        config.global.openCodeProtocol,
        storage.openCode2Sessions.hasOpenCode2SessionCapacity(environmentId),
      );
    },
    recordSession: async (sessionId) => {
      storage.openCode2Sessions.recordOpenCode2Session(environmentId, sessionId);
    },
  };
}

/**
 * Whether a session receives the per-tab Orkestrator MCP credential with
 * each dispatch: the platform's own answer, or an OpenCode 2.x session, whose
 * server takes the connection per session (`opencode2/mcp.ts`) where 1.x's
 * is environment-wide.
 */
export function sessionTakesAgentTools(
  agent: Parameters<typeof nativeAgentCapabilities>[0],
  openCodeProtocol: "v2" | undefined,
): boolean {
  return (
    nativeAgentCapabilities(agent).agentTools === true ||
    (agent === "opencode" && openCodeProtocol === "v2")
  );
}
