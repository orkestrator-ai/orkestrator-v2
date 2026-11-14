import { describe, expect, test } from "bun:test";
import {
  NativeAgentMailInjection,
  type NativeAgentMailInjectionHost,
} from "./native-agent-mail-injection.js";
import {
  nativeAgentSessionStorageKey,
  type DispatchNativeAgentPromptInput,
  type Environment,
  type NativeAgentRuntimeProvider,
  type PersistedNativeAgentSession,
  type PromptDispatchPreparation,
  type StorageService,
} from "./native-agent-service-shared.js";

const identity = {
  environmentId: "env-1",
  agent: "claude" as const,
  logicalSessionKey: "env-env-1:tab-1",
};
const sessionKey = nativeAgentSessionStorageKey(
  identity.environmentId,
  identity.agent,
  identity.logicalSessionKey,
);
const mail: DispatchNativeAgentPromptInput = {
  ...identity,
  prompt: "<orkestrator-peer-message>hi</orkestrator-peer-message>",
  requestId: "mail-1",
};

type Prepare = (
  session: PersistedNativeAgentSession,
  provider: NativeAgentRuntimeProvider,
) => Promise<PromptDispatchPreparation>;

function harness(
  input: {
    session?: Partial<PersistedNativeAgentSession> | null;
    environment?: Partial<Environment> | null;
    queue?: unknown;
    draft?: unknown;
    activity?: string;
    observationFresh?: boolean;
    provider?: Record<string, unknown>;
    dispatch?: Partial<NativeAgentMailInjectionHost["dispatch"]>;
  } = {},
) {
  const events: string[] = [];
  const dispatched: { input: DispatchNativeAgentPromptInput; flags: unknown[] }[] = [];
  const session =
    input.session === null
      ? null
      : ({
          ...identity,
          key: sessionKey,
          providerSessionId: "provider-session",
          ...input.session,
        } as PersistedNativeAgentSession);
  const provider = {
    agent: identity.agent,
    status: async () => "idle",
    ...input.provider,
  } as unknown as NativeAgentRuntimeProvider;
  const storage = {
    getEnvironment: async () =>
      input.environment === null
        ? null
        : ({
            id: identity.environmentId,
            status: "running",
            setupPhase: "ready",
            ...input.environment,
          } as Environment),
    getNativeAgentSession: async () => session,
    getPromptQueue: async () => input.queue ?? null,
    getComposeDraft: async () => (input.draft === undefined ? null : { value: input.draft }),
    clearPendingNativeAgentDispatch: async (_key: string, requestId: string) => {
      events.push(`clear:${requestId}`);
      return true;
    },
  } as unknown as StorageService;
  const host: NativeAgentMailInjectionHost = {
    storage,
    options: {},
    launches: {
      sessionTurnActivitySnapshot: () => input.activity ?? "idle",
    } as unknown as NativeAgentMailInjectionHost["launches"],
    observations: {
      // `observationSatisfies` reads the record, its age and post-dispatch flag.
      view: () =>
        input.observationFresh === false
          ? { freshness: "stale", postDispatch: false }
          : { record: {}, freshness: "fresh", ageMs: 0, postDispatch: true },
    } as unknown as NativeAgentMailInjectionHost["observations"],
    projections: {
      invalidateProjection: (key: string) => events.push(`invalidate:${key}`),
    } as unknown as NativeAgentMailInjectionHost["projections"],
    dispatch: {
      // Mirrors the dispatch collaborator: the admission check runs under its lease.
      dispatchPromptInternal: async (
        dispatchInput: DispatchNativeAgentPromptInput,
        prepare?: Prepare,
        ...flags: unknown[]
      ) => {
        dispatched.push({ input: dispatchInput, flags });
        const preparation = await prepare!(session!, provider);
        events.push(preparation.dispatch ? "sent" : "held");
        return session!;
      },
      dispatchPersistedSteer: async () => ({ outcome: "applied" }),
      settleAmbiguousDispatch: async () => undefined,
      settleAmbiguousSteer: async () => undefined,
      ...input.dispatch,
    } as unknown as NativeAgentMailInjectionHost["dispatch"],
    provider: async () => provider,
    resolveProjectionSession: async () =>
      session ? { key: sessionKey, session, provider, transient: false } : null,
  };
  return { mail: new NativeAgentMailInjection(host), events, dispatched };
}

describe("NativeAgentMailInjection", () => {
  test("injects an idle turn through the dispatch collaborator as literal mail", async () => {
    const { mail: injection, events, dispatched } = harness();
    expect(await injection.dispatchMailInject(mail)).toEqual({
      outcome: "accepted",
      requestId: "mail-1",
    });
    expect(dispatched).toHaveLength(1);
    // No provider commands, the ambiguous dispatch persisted, and the mail flag set.
    expect(dispatched[0]!.input.allowProviderCommands).toBe(false);
    expect(dispatched[0]!.flags).toEqual([true, true]);
    expect(events).toEqual(["sent"]);
  });

  test("a stale idle observation costs one provider read before injecting", async () => {
    let reads = 0;
    const stale = harness({
      observationFresh: false,
      provider: {
        status: async () => {
          reads += 1;
          return "running";
        },
      },
    });
    expect(await stale.mail.dispatchMailInject(mail)).toEqual({ outcome: "held", reason: "busy" });
    expect(reads).toBe(1);
    expect(await harness({ observationFresh: false }).mail.mailInjectPresence(identity)).toBe(
      "unknown",
    );
  });

  test("holds mail behind a queue, a draft or a parked dispatch", async () => {
    const queued = harness({ queue: { messages: [{ id: "typed" }] } });
    expect(await queued.mail.dispatchMailInject(mail)).toEqual({
      outcome: "held",
      reason: "queue",
    });
    const parked = harness({ session: { pendingDispatch: { requestId: "typed" } } as never });
    expect(await parked.mail.dispatchMailInject(mail)).toEqual({
      outcome: "held",
      reason: "parked",
    });
  });

  test("a busy turn holds the mail and releases its refused record", async () => {
    const { mail: injection, events } = harness({ activity: "working" });
    expect(await injection.dispatchMailInject(mail)).toEqual({ outcome: "held", reason: "busy" });
    expect(events).toEqual(["held", "clear:mail-1"]);
  });

  test("presence reports a stopped environment and a waiting queue", async () => {
    expect(
      await harness({ environment: { status: "stopped" } as never }).mail.mailInjectPresence(
        identity,
      ),
    ).toBe("environment_stopped");
    expect(await harness({ environment: null }).mail.mailInjectPresence(identity)).toBe(
      "environment_stopped",
    );
    expect(
      await harness({ queue: { messages: [{ id: "typed" }] } }).mail.mailInjectPresence(identity),
    ).toBe("working");
  });

  test("steer is refused when the provider cannot steer and idle without a session", async () => {
    expect(
      await harness().mail.steerMailInject({ ...identity, text: "now", requestId: "steer-1" }),
    ).toEqual({ outcome: "refused", reason: "steer-unsupported" });
    expect(
      await harness({ session: null }).mail.steerMailInject({
        ...identity,
        text: "now",
        requestId: "steer-1",
      }),
    ).toEqual({ outcome: "idle" });
  });

  test("a running turn takes the mail steer through the dispatch collaborator", async () => {
    let steered = 0;
    const { mail: injection, events } = harness({
      provider: {
        performSessionAction: async () => ({ outcome: "applied" }),
        activeSteerRun: async () => ({ state: "running", runId: "run-1" }),
        steerSupported: async () => true,
        steerStatus: async () => "absent",
      },
      dispatch: {
        dispatchPersistedSteer: async () => {
          steered += 1;
          return { outcome: "applied" };
        },
      },
    });
    expect(
      await injection.steerMailInject({ ...identity, text: "now", requestId: "steer-2" }),
    ).toEqual({ outcome: "applied" });
    expect(steered).toBe(1);
    expect(events).toEqual([`invalidate:${sessionKey}`]);
  });

  test("reconciliation counts only evidence", async () => {
    expect(
      await harness({ session: { dispatchedRequestIds: ["mail-1"] } }).mail.reconcileMailInject({
        ...identity,
        requestId: "mail-1",
      }),
    ).toBe("dispatched");
    expect(
      await harness({
        session: { pendingDispatch: { requestId: "mail-1", mailRefused: true } } as never,
      }).mail.reconcileMailInject({ ...identity, requestId: "mail-1" }),
    ).toBe("not-dispatched");
    // A parked, unsettled send is unknown, never "not sent".
    expect(
      await harness({
        session: { pendingDispatch: { requestId: "mail-1" } } as never,
      }).mail.reconcileMailInject({ ...identity, requestId: "mail-1" }),
    ).toBe("unknown");
    expect(
      await harness({ session: { dispatchedRequestIds: ["steer-3"] } }).mail.reconcileMailSteer({
        ...identity,
        requestId: "steer-3",
      }),
    ).toBe("dispatched");
    expect(
      await harness({ session: null }).mail.reconcileMailSteer({
        ...identity,
        requestId: "steer-3",
      }),
    ).toBe("unknown");
  });
});
