/**
 * A stand-in for an attached `SDKAgent`.
 *
 * The bridge attaches lazily and caches the agent on the session, so a test
 * can put one of these there and exercise the real prompt route, the real
 * translator and the real journal without a credential or a network call.
 * Nothing in the production path knows this exists.
 */
import type { ModelSelection, SDKAgent } from "@cursor/sdk";
import { modelSelection } from "../models.js";
import { mcpConnectionKey } from "../mcp.js";
import type { SessionState } from "../state.js";

export interface FakeRunScript {
  initialModel?: ModelSelection;
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
  /** Updates emitted synchronously before a start failure is reported. */
  updatesBeforeStartFailure?: unknown[];
  /**
   * Holds `send` open, standing in for the SDK taking its time to start a run.
   * This is the window in which the session is already `running` but no run
   * handle exists yet, so a cancel arriving here has nothing to act on.
   */
  holdSend?: Promise<void>;
  /** Holds `asyncDispose` open, standing in for a stalled SDK teardown. */
  holdDispose?: Promise<void>;
  /** Rejects `asyncDispose`, standing in for a teardown that throws. */
  failDispose?: Error;
  /** Rejects `summarize` itself: no run started. */
  failSummarize?: Error;
  /** Messages `run.stream()` yields, such as a `summary` status. */
  streamMessages?: unknown[];
}

export interface FakeAgent extends SDKAgent {
  readonly sends: Array<{ message: unknown; options: unknown }>;
  readonly cancels: number;
  readonly summarizes: number;
  readonly summaryModels: Array<ModelSelection | undefined>;
}

export function fakeAgent(script: FakeRunScript = {}): FakeAgent {
  const sends: Array<{ message: unknown; options: unknown }> = [];
  let cancels = 0;
  let cancelled = false;
  let summarizes = 0;
  const summaryModels: Array<ModelSelection | undefined> = [];

  const startedRun = () => {
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
      async *stream() {
        if (script.hold) await script.hold;
        for (const message of script.streamMessages ?? []) yield message;
      },
      conversation: async () => [],
      wait: settle,
      cancel: async () => {
        cancels += 1;
        cancelled = true;
      },
      onDidChangeStatus: () => () => undefined,
    };
  };

  const agent = {
    agentId: "fake-agent",
    model: script.initialModel,
    async send(
      message: unknown,
      options: { model?: ModelSelection; onDelta?: (args: { update: unknown }) => void } = {},
    ) {
      sends.push({ message, options });
      if (script.holdSend) await script.holdSend;
      if (script.failToStart) {
        for (const update of script.updatesBeforeStartFailure ?? []) {
          options.onDelta?.({ update });
        }
        throw script.failToStart;
      }

      // Delivered synchronously, exactly as the translator's no-await contract
      // assumes: if this ever needed to be awaited, the production path would
      // be back-pressuring a live run.
      for (const update of script.updates ?? []) options.onDelta?.({ update });

      if (options.model) agent.model = options.model;
      return startedRun();
    },
    async summarize() {
      summarizes += 1;
      summaryModels.push(agent.model);
      if (script.holdSend) await script.holdSend;
      if (script.failSummarize) throw script.failSummarize;
      return startedRun();
    },
    close: () => undefined,
    reload: async () => undefined,
    [Symbol.asyncDispose]: async () => {
      if (script.holdDispose) await script.holdDispose;
      if (script.failDispose) throw script.failDispose;
    },
    listArtifacts: async () => [],
    downloadArtifact: async () => Buffer.alloc(0),
    getUsage: async () => ({ runs: [] }),
    get sends() {
      return sends;
    },
    get cancels() {
      return cancels;
    },
    get summaryModels() {
      return summaryModels;
    },
    get summarizes() {
      return summarizes;
    },
  };
  return agent as unknown as FakeAgent;
}

/** Attach a fake agent to a session, bypassing the SDK's cold start. */
export function attachFake(state: SessionState, script: FakeRunScript = {}): FakeAgent {
  const agent = fakeAgent({ initialModel: modelSelection(state.composer), ...script });
  state.agent = agent;
  state.agentId = agent.agentId;
  // Same fingerprint `ensureAgent` writes after a real attach, including the
  // empty-string env-fallback. Without it an installed agent looks stale.
  state.attachedMcpKey = mcpConnectionKey(state.agentMcp);
  return agent;
}
