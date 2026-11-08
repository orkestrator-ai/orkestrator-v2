/**
 * Which OpenCode line a native session runs on
 * (docs/todo/agent-engines/0008-opencode-v2.md, build plan phase 3).
 *
 * The decision is made once, by the backend, when a session is created, and
 * stored on its record (`openCodeProtocol: "v2"`). Only new interactive tabs
 * of an ordinary local environment take 2.x, and only while the setting asks
 * for it: build pipelines, Multi Review, graphs and coordinators create their
 * sessions with other origins or owners, and container environments wait for
 * the container half. Everything else, every existing record included, is
 * 1.x.
 */
import type { AgentInteractionOrigin } from "@orkestrator/protocol/agent-interactions";
import type { AgentSessionOwner } from "@orkestrator/protocol/coordinator";
import { resolveOpenCodeProtocol } from "@orkestrator/protocol/opencode-protocol";
import type { Environment, PersistedNativeAgentSession } from "./models.js";
import type { OpenCodeRoutingDependencies } from "./opencode2/routing-provider.js";
import type { NativeAgentServiceOptions } from "./native-agent-service-shared.js";

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
): "v2" | undefined {
  if (input.agent !== "opencode" || !available) return undefined;
  if (resolveOpenCodeProtocol(setting) !== "v2") return undefined;
  if ((input.origin ?? "interactive-native") !== "interactive-native") return undefined;
  if (input.owner && input.owner.kind !== "environment") return undefined;
  if (input.executionPolicy) return undefined;
  if (environment?.environmentType !== "local") return undefined;
  return "v2";
}

/**
 * {@link newOpenCodeSessionProtocol} for one `ensureSession` request, reading
 * the environment and the setting. Only a backend with a 2.x host can answer
 * `"v2"`; an unreadable environment or setting keeps the default line.
 */
export async function selectNewOpenCodeSessionProtocol(
  storage: {
    getEnvironment(environmentId: string): Promise<Pick<Environment, "environmentType"> | null>;
    loadConfig(): Promise<{ global: { openCodeProtocol?: unknown } }>;
  },
  options: Pick<NativeAgentServiceOptions, "openCode2HostServer">,
  input: NewOpenCodeSessionInput & { environmentId: string },
): Promise<"v2" | undefined> {
  if (input.agent !== "opencode" || !options.openCode2HostServer) return undefined;
  try {
    const [environment, config] = await Promise.all([
      storage.getEnvironment(input.environmentId),
      storage.loadConfig(),
    ]);
    return newOpenCodeSessionProtocol(input, environment, config.global.openCodeProtocol, true);
  } catch {
    return undefined;
  }
}

type SessionReader = {
  readNativeAgentSessionsSnapshot?: () => Promise<readonly PersistedNativeAgentSession[]>;
  listNativeAgentSessions?: () => Promise<readonly PersistedNativeAgentSession[]>;
};

/** The persisted marker of one environment's OpenCode provider session. */
export async function persistedOpenCodeProtocol(
  storage: SessionReader,
  environmentId: string,
  providerSessionId: string,
): Promise<"v2" | undefined> {
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
  options: Pick<NativeAgentServiceOptions, "openCode2HostServer">,
  storage: SessionReader,
  environmentId: string,
): OpenCodeRoutingDependencies | undefined {
  const host = options.openCode2HostServer;
  if (!host) return undefined;
  return {
    connection: (start) => host(environmentId, start),
    persistedProtocol: (sessionId) => persistedOpenCodeProtocol(storage, environmentId, sessionId),
  };
}
