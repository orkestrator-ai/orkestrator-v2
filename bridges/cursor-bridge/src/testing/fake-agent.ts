/**
 * A stand-in for an attached `SDKAgent`.
 *
 * The bridge attaches lazily and caches the agent on the session, so a test
 * can put one of these there and exercise the real prompt route, the real
 * translator and the real journal without a credential or a network call.
 * Nothing in the production path knows this exists.
 */
import type { SDKAgent } from "@cursor/sdk";
import type { SessionState } from "../state.js";

export interface FakeRunScript {
  /** Interaction updates delivered through `onDelta`, in order. */
  updates?: unknown[];
  status?: "finished" | "error" | "cancelled";
  result?: string;
  errorMessage?: string;
  durationMs?: number;
  /** Held open until resolved, so a test can observe a turn mid-flight. */
  hold?: Promise<void>;
  /** Rejects `send` itself, standing in for a run that never started. */
  failToStart?: Error;
}

export interface FakeAgent extends SDKAgent {
  readonly sends: Array<{ message: unknown; options: unknown }>;
  readonly cancels: number;
}

export function fakeAgent(script: FakeRunScript = {}): FakeAgent {
  const sends: Array<{ message: unknown; options: unknown }> = [];
  let cancels = 0;
  let cancelled = false;

  const agent = {
    agentId: "fake-agent",
    model: undefined,
    async send(message: unknown, options: { onDelta?: (args: { update: unknown }) => void } = {}) {
      sends.push({ message, options });
      if (script.failToStart) throw script.failToStart;

      // Delivered synchronously, exactly as the translator's no-await contract
      // assumes: if this ever needed to be awaited, the production path would
      // be back-pressuring a live run.
      for (const update of script.updates ?? []) options.onDelta?.({ update });

      const settle = async () => {
        if (script.hold) await script.hold;
        return {
          id: "fake-run",
          status: cancelled ? ("cancelled" as const) : (script.status ?? ("finished" as const)),
          ...(script.result !== undefined ? { result: script.result } : {}),
          ...(script.errorMessage ? { error: { message: script.errorMessage } } : {}),
          ...(script.durationMs !== undefined ? { durationMs: script.durationMs } : {}),
        };
      };

      return {
        id: "fake-run",
        agentId: "fake-agent",
        status: "running" as const,
        supports: () => true,
        unsupportedReason: () => undefined,
        // eslint-disable-next-line require-yield
        async *stream() {
          if (script.hold) await script.hold;
        },
        conversation: async () => [],
        wait: settle,
        cancel: async () => {
          cancels += 1;
          cancelled = true;
        },
        onDidChangeStatus: () => () => undefined,
      };
    },
    close: () => undefined,
    reload: async () => undefined,
    [Symbol.asyncDispose]: async () => undefined,
    listArtifacts: async () => [],
    downloadArtifact: async () => Buffer.alloc(0),
    getUsage: async () => ({ runs: [] }),
    get sends() {
      return sends;
    },
    get cancels() {
      return cancels;
    },
  };
  return agent as unknown as FakeAgent;
}

/** Attach a fake agent to a session, bypassing the SDK's cold start. */
export function attachFake(state: SessionState, script: FakeRunScript = {}): FakeAgent {
  const agent = fakeAgent(script);
  state.agent = agent;
  state.agentId = agent.agentId;
  return agent;
}
