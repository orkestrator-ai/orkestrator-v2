import { describe, expect, test } from "bun:test";
import {
  CRITICAL_READ_RESUME_MAX_DELAY_MS,
  READ_RESUME_COALESCE_MS,
  READ_RETRY_MAX_MS,
  classifyReadError,
  createReadCoordinator,
  getReadCoordinator,
  notifyReadCoordinatorReconnected,
  resetReadCoordinatorForTests,
  type ReadContext,
  type ReadCoordinator,
  type ReadKey,
  type ReadState,
} from "./read-coordinator";
import { createFakeReadEnvironment, flushMicrotasks as flush } from "./testing/read-coordinator";

const setup = createFakeReadEnvironment;

interface PendingRead<T> {
  context: ReadContext;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
}

/** Transport whose reads settle only when the test says so. */
function deferredTransport<T>() {
  const calls: PendingRead<T>[] = [];
  const read = (context: ReadContext) =>
    new Promise<T>((resolve, reject) => {
      calls.push({ context, resolve, reject });
    });
  return {
    calls,
    read,
    last: () => calls.at(-1)!,
    async resolveLast(value: T) {
      calls.at(-1)!.resolve(value);
      await flush();
    },
    async rejectLast(error: unknown) {
      calls.at(-1)!.reject(error);
      await flush();
    },
  };
}

const key = (overrides: Partial<ReadKey> = {}): ReadKey => ({
  resource: "files-panel",
  target: "env-1",
  ...overrides,
});

function collect<T>() {
  const states: ReadState<T>[] = [];
  return { states, onState: (state: ReadState<T>) => states.push(state) };
}

describe("read coordinator: demand and joining", () => {
  test("two subscribers of one key share one timer and one read", async () => {
    const { clock, coordinator } = setup();
    const transport = deferredTransport<string>();
    const first = collect<string>();
    const second = collect<string>();
    coordinator.subscribe({
      key: key(),
      read: transport.read,
      demand: { intervalMs: 1_000 },
      onState: first.onState,
    });
    coordinator.subscribe({
      key: key(),
      read: transport.read,
      demand: { intervalMs: 1_000 },
      onState: second.onState,
    });

    expect(transport.calls).toHaveLength(1);
    expect(transport.last().context.reason).toBe("mount");
    await transport.resolveLast("v1");
    expect(first.states.at(-1)).toMatchObject({ value: "v1", revision: 1, status: "current" });
    expect(second.states.at(-1)).toMatchObject({ value: "v1", revision: 1 });
    expect(clock.pending).toBe(1);

    await clock.advance(1_000);
    expect(transport.calls).toHaveLength(2);
    expect(transport.last().context.reason).toBe("interval");
    await transport.resolveLast("v2");
    expect(first.states.at(-1)?.revision).toBe(2);
    expect(coordinator.getDiagnostics().entries).toHaveLength(1);
  });

  test("the fastest active demand wins and closing it restores the slower cadence", async () => {
    const { clock, coordinator } = setup();
    const transport = deferredTransport<number>();
    coordinator.subscribe({
      key: key(),
      read: transport.read,
      readOnSubscribe: false,
      demand: { intervalMs: 5_000 },
    });
    const fast = coordinator.subscribe({
      key: key(),
      read: transport.read,
      readOnSubscribe: false,
      demand: { intervalMs: 3_000 },
    });

    await clock.advance(3_000);
    expect(transport.calls).toHaveLength(1);
    await transport.resolveLast(1);
    await clock.advance(3_000);
    expect(transport.calls).toHaveLength(2);
    await transport.resolveLast(2);

    fast.dispose();
    await clock.advance(4_999);
    expect(transport.calls).toHaveLength(2);
    await clock.advance(1);
    expect(transport.calls).toHaveLength(3);
  });

  test("keys with different options or views never share a response", async () => {
    const { coordinator } = setup();
    const transport = deferredTransport<string>();
    const small = collect<string>();
    const large = collect<string>();
    coordinator.subscribe({
      key: key({ options: "limit=50" }),
      read: transport.read,
      onState: small.onState,
    });
    coordinator.subscribe({
      key: key({ options: "limit=100" }),
      read: transport.read,
      onState: large.onState,
    });
    coordinator.subscribe({
      key: key({ options: "limit=50", view: "tab-2" }),
      read: transport.read,
    });

    expect(transport.calls).toHaveLength(3);
    transport.calls[0]!.resolve("fifty");
    await flush();
    expect(small.states.at(-1)?.value).toBe("fifty");
    expect(large.states.some((state) => state.value === "fifty")).toBe(false);
  });

  test("invalidations during a read set one dirty flag and cause exactly one trailing read", async () => {
    const { clock, coordinator } = setup();
    const transport = deferredTransport<string>();
    const sub = coordinator.subscribe({
      key: key(),
      read: transport.read,
      demand: { intervalMs: 1_000 },
    });
    expect(transport.calls).toHaveLength(1);

    sub.invalidate();
    sub.invalidate();
    sub.invalidate();
    expect(transport.calls).toHaveLength(1);
    expect(sub.getState().stale).toBe(false);

    await transport.resolveLast("before-change");
    expect(transport.calls).toHaveLength(2);
    expect(transport.last().context.reason).toBe("invalidate");
    await transport.resolveLast("after-change");
    expect(sub.getState()).toMatchObject({ value: "after-change", revision: 2 });

    // No further reads until the next periodic slot.
    await clock.advance(999);
    expect(transport.calls).toHaveLength(2);
  });

  test("an explicit refresh during a read obtains a post-call observation", async () => {
    const { coordinator } = setup();
    const transport = deferredTransport<string>();
    const sub = coordinator.subscribe({ key: key(), read: transport.read });
    expect(transport.calls).toHaveLength(1);

    let refreshed: ReadState<string> | null = null;
    void sub.refresh().then((state) => {
      refreshed = state;
    });
    await flush();
    expect(transport.calls).toHaveLength(1);

    await transport.resolveLast("pre-click");
    // Joining the older read does not satisfy the explicit refresh.
    expect(refreshed).toBeNull();
    expect(transport.calls).toHaveLength(2);
    expect(transport.last().context).toMatchObject({ reason: "explicit", explicit: true });

    await transport.resolveLast("post-click");
    expect(refreshed).toMatchObject({ value: "post-click", revision: 2 });
  });

  test("inactive subscribers receive no automatic reads and ignore invalidations", async () => {
    const { clock, coordinator } = setup();
    const transport = deferredTransport<string>();
    const sub = coordinator.subscribe({
      key: key(),
      read: transport.read,
      readOnSubscribe: false,
      demand: { active: false, intervalMs: 1_000 },
    });
    await clock.advance(5_000);
    sub.invalidate();
    expect(transport.calls).toHaveLength(0);

    await clock.advance(250);
    sub.update({ demand: { active: true, intervalMs: 1_000 } });
    await clock.advance(999);
    expect(transport.calls).toHaveLength(0);
    await clock.advance(1);
    expect(transport.calls).toHaveLength(1);
  });

  test("periodic ticks that land during a read are skipped like a fixed-rate interval", async () => {
    const { clock, coordinator } = setup();
    const transport = deferredTransport<string>();
    coordinator.subscribe({
      key: key(),
      read: transport.read,
      readOnSubscribe: false,
      demand: { intervalMs: 500 },
    });
    await clock.advance(500);
    expect(transport.calls).toHaveLength(1);
    // The read takes 700 ms: the 1,000 ms tick is skipped, 1,500 ms runs.
    await clock.advance(700);
    await transport.resolveLast("slow");
    await clock.advance(299);
    expect(transport.calls).toHaveLength(1);
    await clock.advance(1);
    expect(transport.calls).toHaveLength(2);
  });
});

describe("read coordinator: visibility, focus and reconnect", () => {
  test("a hidden document pauses periodic reads and resume reconciles critical first", async () => {
    const { clock, document, coordinator } = setup();
    const order: string[] = [];
    const reads = (name: string) => async () => {
      order.push(name);
      return name;
    };
    coordinator.subscribe({
      key: key({ resource: "files" }),
      read: reads("files"),
      readOnSubscribe: false,
      demand: { intervalMs: 5_000, priority: "standard" },
    });
    coordinator.subscribe({
      key: key({ resource: "metrics" }),
      read: reads("metrics"),
      readOnSubscribe: false,
      demand: { intervalMs: 5_000, priority: "auxiliary" },
    });
    coordinator.subscribe({
      key: key({ resource: "session" }),
      read: reads("session"),
      readOnSubscribe: false,
      demand: { intervalMs: 1_500, priority: "critical" },
    });

    document.setVisibility("hidden");
    await clock.advance(60_000);
    expect(order).toEqual([]);
    expect(clock.pending).toBe(0);

    document.setVisibility("visible");
    await clock.advance(CRITICAL_READ_RESUME_MAX_DELAY_MS - 1);
    expect(order).toEqual([]);
    await clock.advance(1);
    expect(order).toEqual(["session"]);
    // random() === 0 puts each lower priority at the start of its window.
    await clock.advance(100);
    expect(order).toEqual(["session", "files"]);
    await clock.advance(200);
    expect(order).toEqual(["session", "files", "metrics"]);
  });

  test("resume spreading stays within each priority's bounded window", async () => {
    const { clock, document, coordinator } = setup({ random: () => 0.999 });
    const started: Record<string, number> = {};
    for (const priority of ["critical", "standard", "auxiliary"] as const) {
      coordinator.subscribe({
        key: key({ resource: priority }),
        read: async () => {
          started[priority] ??= clock.now();
        },
        readOnSubscribe: false,
        demand: { intervalMs: 1_000, priority },
      });
    }
    document.setVisibility("hidden");
    await clock.advance(10_000);
    document.setVisibility("visible");
    await clock.advance(5_000);
    const resumedAt = 10_000 + READ_RESUME_COALESCE_MS;
    expect(started.critical).toBe(resumedAt);
    expect(started.standard! - resumedAt).toBeLessThanOrEqual(600);
    expect(started.auxiliary! - resumedAt).toBeLessThanOrEqual(1_500);
    expect(started.auxiliary! - resumedAt).toBeGreaterThanOrEqual(300);
  });

  test("rapid hide/show inside a period adds no reads", async () => {
    const { clock, document, coordinator } = setup();
    const transport = deferredTransport<string>();
    coordinator.subscribe({
      key: key(),
      read: transport.read,
      readOnSubscribe: false,
      demand: { intervalMs: 1_500, priority: "critical" },
    });
    await clock.advance(100);
    document.setVisibility("hidden");
    await clock.advance(20);
    document.setVisibility("visible");
    document.setVisibility("hidden");
    document.setVisibility("visible");
    await clock.advance(200);
    expect(transport.calls).toHaveLength(0);
    await clock.advance(1_180);
    expect(transport.calls).toHaveLength(1);
    expect(transport.last().context.reason).toBe("interval");
  });

  test("a read settling after the document is hidden does not rearm a timer", async () => {
    const { clock, document, coordinator } = setup();
    const transport = deferredTransport<string>();
    const sub = coordinator.subscribe({
      key: key(),
      read: transport.read,
      readOnSubscribe: false,
      demand: { intervalMs: 1_000, priority: "critical" },
    });
    await clock.advance(1_000);
    expect(transport.calls).toHaveLength(1);
    document.setVisibility("hidden");
    await transport.resolveLast("while-hiding");
    expect(sub.getState().value).toBe("while-hiding");
    expect(clock.pending).toBe(0);

    // The visibility event is delivered late, well after the period elapsed.
    await clock.advance(4_000);
    document.setVisibility("visible");
    await clock.advance(READ_RESUME_COALESCE_MS);
    expect(transport.calls).toHaveLength(2);
    expect(transport.last().context.reason).toBe("resume");
  });

  test("invalidations while hidden are deferred and reconciled with one read", async () => {
    const { clock, document, coordinator } = setup();
    const transport = deferredTransport<string>();
    const sub = coordinator.subscribe({
      key: key(),
      read: transport.read,
      demand: { priority: "critical" },
    });
    await transport.resolveLast("initial");
    document.setVisibility("hidden");
    sub.invalidate();
    sub.invalidate();
    await clock.advance(10_000);
    expect(transport.calls).toHaveLength(1);
    expect(sub.getState()).toMatchObject({ value: "initial", stale: true });

    document.setVisibility("visible");
    await clock.advance(READ_RESUME_COALESCE_MS);
    expect(transport.calls).toHaveLength(2);
    await transport.resolveLast("reconciled");
    expect(sub.getState()).toMatchObject({ value: "reconciled", stale: false, revision: 2 });
  });

  test("visibility, focus and reconnect signals coalesce into one reconcile", async () => {
    const { clock, document, window, coordinator } = setup();
    const transport = deferredTransport<string>();
    coordinator.subscribe({
      key: key(),
      read: transport.read,
      readOnSubscribe: false,
      demand: { intervalMs: 1_500, priority: "critical" },
    });
    document.setVisibility("hidden");
    await clock.advance(30_000);
    document.setVisibility("visible");
    window.dispatch("focus");
    window.dispatch("pageshow");
    coordinator.notifyReconnected();
    await clock.advance(READ_RESUME_COALESCE_MS);
    expect(transport.calls).toHaveLength(1);
    expect(transport.last().context.reason).toBe("reconnect");
    await transport.resolveLast("once");
    await clock.advance(1_499);
    expect(transport.calls).toHaveLength(1);
  });

  test("a read that started after the reconnect signal satisfies the reconcile", async () => {
    const { clock, coordinator } = setup();
    const transport = deferredTransport<string>();
    const sub = coordinator.subscribe({
      key: key(),
      read: transport.read,
      readOnSubscribe: false,
      demand: { intervalMs: 1_500, priority: "critical" },
    });
    coordinator.notifyReconnected();
    // e.g. the resync that follows the same reconnect invalidates the key.
    sub.invalidate();
    expect(transport.calls).toHaveLength(1);
    await transport.resolveLast("post-reconnect");
    await clock.advance(READ_RESUME_COALESCE_MS);
    expect(transport.calls).toHaveLength(1);

    // A read that was already running when the signal arrived is followed once.
    sub.invalidate();
    coordinator.notifyReconnected();
    await clock.advance(READ_RESUME_COALESCE_MS);
    expect(transport.calls).toHaveLength(2);
    await transport.resolveLast("pre-reconnect");
    expect(transport.calls).toHaveLength(3);
  });

  test("focus without a missed period does not read", async () => {
    const { clock, window, coordinator } = setup();
    const transport = deferredTransport<string>();
    coordinator.subscribe({
      key: key(),
      read: transport.read,
      readOnSubscribe: false,
      demand: { intervalMs: 1_500, priority: "critical" },
    });
    await clock.advance(200);
    window.dispatch("focus");
    await clock.advance(READ_RESUME_COALESCE_MS);
    expect(transport.calls).toHaveLength(0);
  });

  test("browser offline is only a hint; online retries a failing read at once", async () => {
    const { clock, window, coordinator } = setup();
    const transport = deferredTransport<string>();
    const sub = coordinator.subscribe({
      key: key(),
      read: transport.read,
      readOnSubscribe: false,
      demand: { intervalMs: 1_000, priority: "critical" },
    });
    // A Local backend stays reachable without internet: reads continue.
    window.dispatch("offline");
    await clock.advance(1_000);
    expect(transport.calls).toHaveLength(1);
    await transport.rejectLast(new Error("Failed to fetch"));
    expect(sub.getState().failures).toBe(1);

    window.dispatch("online");
    await clock.advance(READ_RESUME_COALESCE_MS);
    expect(transport.calls).toHaveLength(2);
    expect(transport.last().context.reason).toBe("reconnect");
  });

  test("a transport-declared disconnect pauses until it reconnects", async () => {
    const { clock, coordinator } = setup();
    const transport = deferredTransport<string>();
    coordinator.subscribe({
      key: key(),
      read: transport.read,
      readOnSubscribe: false,
      demand: { intervalMs: 1_000, priority: "critical" },
    });
    coordinator.setDisconnected(true);
    await clock.advance(5_000);
    expect(transport.calls).toHaveLength(0);
    coordinator.setDisconnected(false);
    await clock.advance(READ_RESUME_COALESCE_MS);
    expect(transport.calls).toHaveLength(1);
  });

  test("explicit refresh still runs while the document is hidden", async () => {
    const { document, coordinator } = setup();
    const transport = deferredTransport<string>();
    const sub = coordinator.subscribe({ key: key(), read: transport.read, readOnSubscribe: false });
    document.setVisibility("hidden");
    const refreshed = sub.refresh();
    expect(transport.calls).toHaveLength(1);
    await transport.resolveLast("hidden-click");
    expect((await refreshed).value).toBe("hidden-click");
  });
});

describe("read coordinator: errors", () => {
  test("a network failure keeps the stale value, reports truthful freshness and backs off", async () => {
    const { clock, coordinator } = setup({ random: () => 0.999 });
    const transport = deferredTransport<string>();
    const sub = coordinator.subscribe({
      key: key(),
      read: transport.read,
      demand: { intervalMs: 1_000 },
    });
    await transport.resolveLast("good");
    expect(sub.getState().observedAt).toBe(0);

    await clock.advance(1_000);
    await transport.rejectLast(new Error("network down"));
    expect(sub.getState()).toMatchObject({
      status: "error",
      value: "good",
      stale: true,
      observedAt: 0,
      failures: 1,
      errorKind: "transient",
    });

    // Retry ceilings double (1 s, 2 s, 4 s) with jitter, never faster than
    // the key's healthy 1 s cadence. random() ~ 1 keeps the ceiling.
    const due = () => coordinator.getDiagnostics().entries[0]!.timerDueAt;
    expect(due()).toBe(2_000);
    await clock.advance(999);
    expect(transport.calls).toHaveLength(2);
    await clock.advance(1);
    expect(transport.calls).toHaveLength(3);
    expect(transport.last().context.reason).toBe("retry");
    await transport.rejectLast(new Error("still down"));
    expect(due()).toBe(2_000 + 1_999);
    await clock.advance(1_999);
    expect(transport.calls).toHaveLength(4);
    await transport.rejectLast(new Error("still down"));
    expect(sub.getState().failures).toBe(3);
    expect(due()).toBe(3_999 + 3_998);
    await clock.advance(3_997);
    expect(transport.calls).toHaveLength(4);
    await clock.advance(1);
    expect(transport.calls).toHaveLength(5);

    await transport.resolveLast("recovered");
    expect(sub.getState()).toMatchObject({
      status: "current",
      value: "recovered",
      stale: false,
      failures: 0,
      observedAt: 7_997,
    });
  });

  test("backoff is capped and reset by reconnect", async () => {
    const { clock, coordinator } = setup();
    const transport = deferredTransport<string>();
    const sub = coordinator.subscribe({
      key: key(),
      read: transport.read,
      demand: { priority: "critical" },
    });
    for (let attempt = 0; attempt < 12; attempt += 1) {
      await transport.rejectLast(new Error("down"));
      const entry = coordinator.getDiagnostics().entries[0]!;
      expect(entry.timerDueAt! - clock.now()).toBeLessThanOrEqual(READ_RETRY_MAX_MS);
      await clock.advance(READ_RETRY_MAX_MS);
    }
    expect(sub.getState().failures).toBe(12);
    const before = transport.calls.length;
    await transport.rejectLast(new Error("down"));
    coordinator.notifyReconnected();
    await clock.advance(READ_RESUME_COALESCE_MS);
    expect(transport.calls.length).toBe(before + 1);
    expect(sub.getState().failures).toBe(0);
  });

  test("an auth failure is never cached as empty data", async () => {
    const { clock, coordinator } = setup();
    const transport = deferredTransport<string[]>();
    const sub = coordinator.subscribe({
      key: key(),
      read: transport.read,
      demand: { intervalMs: 1_000 },
    });
    await transport.resolveLast(["a.ts", "b.ts"]);
    await clock.advance(1_000);
    await transport.rejectLast(Object.assign(new Error("Unauthorized"), { status: 401 }));
    expect(sub.getState()).toMatchObject({
      status: "error",
      errorKind: "auth",
      value: ["a.ts", "b.ts"],
      hasValue: true,
      stale: true,
    });
    // Auth retries wait at the ceiling rather than the healthy cadence.
    await clock.advance(READ_RETRY_MAX_MS / 2 - 1);
    expect(transport.calls).toHaveLength(2);

    const fresh = setup().coordinator;
    const freshTransport = deferredTransport<string[]>();
    const unauthorized = fresh.subscribe({ key: key(), read: freshTransport.read });
    await freshTransport.rejectLast(Object.assign(new Error("Forbidden"), { status: 403 }));
    expect(unauthorized.getState()).toMatchObject({ hasValue: false, value: undefined });
  });

  test("a permanently unsupported API is not retried until reconnect or explicit refresh", async () => {
    const { clock, coordinator } = setup();
    const transport = deferredTransport<string>();
    const sub = coordinator.subscribe({
      key: key(),
      read: transport.read,
      demand: { intervalMs: 1_000 },
    });
    await transport.rejectLast(new Error("Unknown backend command: get_files_snapshot"));
    expect(sub.getState().status).toBe("unsupported");
    await clock.advance(60_000);
    sub.invalidate();
    expect(transport.calls).toHaveLength(1);

    const explicit = sub.refresh();
    expect(transport.calls).toHaveLength(2);
    await transport.rejectLast(new Error("Unknown backend command: get_files_snapshot"));
    expect((await explicit).status).toBe("unsupported");

    coordinator.notifyReconnected();
    await clock.advance(READ_RESUME_COALESCE_MS + 600);
    expect(transport.calls).toHaveLength(3);
  });

  test("the default classifier does not infer unsupported from network or auth errors", () => {
    expect(classifyReadError(new Error("Failed to fetch"))).toBe("transient");
    expect(classifyReadError(Object.assign(new Error("x"), { status: 404 }))).toBe("transient");
    expect(classifyReadError(Object.assign(new Error("x"), { status: 401 }))).toBe("auth");
    expect(classifyReadError(new Error("Unknown backend command: foo"))).toBe("unsupported");
  });
});

describe("read coordinator: identity and disposal", () => {
  test("an instance-scoped subscriber evicts its entry on dispose", async () => {
    const { coordinator } = setup();
    const sub = coordinator.subscribe({
      key: key({ view: "unique-instance" }),
      read: async () => ({ messages: ["large transcript"] }),
      retainOnDispose: false,
    });
    await flush();
    expect(sub.getState().hasValue).toBe(true);
    sub.dispose();
    expect(coordinator.getDiagnostics().entries).toEqual([]);
  });
  test("disconnect then reconnect fences a retained value", async () => {
    const { coordinator } = setup({ connectionId: "local" });
    const transport = deferredTransport<string>();
    const sub = coordinator.subscribe({ key: key(), read: transport.read });
    await transport.resolveLast("old server");
    expect(sub.getState().value).toBe("old server");
    coordinator.setConnection(null);
    expect(sub.getState().hasValue).toBe(false);
    coordinator.setConnection("remote");
    expect(sub.getState().connectionGeneration).toBe(2);
    expect(sub.getState().hasValue).toBe(false);
    const refreshed = sub.refresh();
    expect(transport.calls).toHaveLength(2);
    await transport.resolveLast("new server");
    await refreshed;
    expect(sub.getState().value).toBe("new server");
  });
  test("a server switch fences in-flight results and re-reads under the new identity", async () => {
    const { clock, coordinator } = setup({ connectionId: "local" });
    const transport = deferredTransport<string>();
    const states = collect<string>();
    const sub = coordinator.subscribe({
      key: key(),
      read: transport.read,
      demand: { intervalMs: 1_000, priority: "critical" },
      onState: states.onState,
    });
    const retained = deferredTransport<string>();
    coordinator.subscribe({ key: key({ target: "idle" }), read: retained.read }).dispose();
    const oldRead = transport.last();

    coordinator.setConnection("remote");
    expect(oldRead.context.signal.aborted).toBe(true);
    expect(transport.calls).toHaveLength(2);
    expect(transport.last().context).toMatchObject({
      connectionId: "remote",
      connectionGeneration: 1,
    });
    expect(coordinator.getDiagnostics().entries).toHaveLength(1);

    oldRead.resolve("old-server");
    await flush();
    expect(sub.getState().hasValue).toBe(false);
    expect(states.states.some((state) => state.value === "old-server")).toBe(false);

    await transport.resolveLast("new-server");
    expect(sub.getState()).toMatchObject({
      value: "new-server",
      connectionId: "remote",
      connectionGeneration: 1,
      revision: 1,
    });
    // Learning an identity is not a switch.
    const learning = setup().coordinator;
    learning.setConnection("local");
    expect(learning.getDiagnostics().connectionGeneration).toBe(0);
    await clock.advance(0);
  });

  test("a target change keeps the old key's late result away from the new subscriber", async () => {
    const { clock, coordinator } = setup();
    const transport = deferredTransport<string>();
    const oldStates = collect<string>();
    const newStates = collect<string>();
    const oldSub = coordinator.subscribe({
      key: key({ target: "env-1" }),
      read: transport.read,
      demand: { intervalMs: 1_000 },
      onState: oldStates.onState,
    });
    const oldRead = transport.last();
    oldSub.dispose();
    coordinator.subscribe({
      key: key({ target: "env-2" }),
      read: transport.read,
      demand: { intervalMs: 1_000 },
      onState: newStates.onState,
    });
    oldRead.resolve("env-1 files");
    await flush();
    expect(newStates.states.some((state) => state.value === "env-1 files")).toBe(false);
    expect(oldStates.states.some((state) => state.value === "env-1 files")).toBe(false);
    const oldEntry = coordinator
      .getDiagnostics()
      .entries.find((entry) => entry.id.includes("env-1"))!;
    expect(oldEntry).toMatchObject({ subscribers: 0, timerDueAt: null, inFlight: false });
    await transport.resolveLast("env-2 files");
    expect(newStates.states.at(-1)?.value).toBe("env-2 files");
    expect(clock.pending).toBe(1);
  });

  test("unmount leaves no timer and remount joins the running read", async () => {
    const { clock, coordinator } = setup();
    const transport = deferredTransport<string>();
    const first = collect<string>();
    const mounted = coordinator.subscribe({
      key: key(),
      read: transport.read,
      demand: { intervalMs: 1_000 },
      onState: first.onState,
    });
    const statesBeforeUnmount = first.states.length;
    mounted.dispose();
    const remount = collect<string>();
    const remounted = coordinator.subscribe({
      key: key(),
      read: transport.read,
      demand: { intervalMs: 1_000 },
      onState: remount.onState,
    });
    expect(transport.calls).toHaveLength(1);
    await transport.resolveLast("joined");
    expect(first.states).toHaveLength(statesBeforeUnmount);
    expect(remount.states.at(-1)?.value).toBe("joined");

    remounted.dispose();
    expect(clock.pending).toBe(0);
    await clock.advance(10_000);
    expect(transport.calls).toHaveLength(1);

    // A remount within the freshness window reuses the retained value.
    const fresh = coordinator.subscribe({
      key: key(),
      read: transport.read,
      demand: { intervalMs: 60_000 },
    });
    expect(transport.calls).toHaveLength(1);
    expect(fresh.getState().value).toBe("joined");
  });

  test("a new subscriber receives a kept value during error backoff", async () => {
    const { clock, coordinator } = setup();
    const transport = deferredTransport<string>();
    const first = coordinator.subscribe({
      key: key(),
      read: transport.read,
      demand: { intervalMs: 1_000 },
    });
    await transport.resolveLast("kept");
    await clock.advance(1_000);
    await transport.rejectLast(new Error("offline"));
    first.dispose();
    const states = collect<string>();
    const second = coordinator.subscribe({
      key: key(),
      read: transport.read,
      demand: { intervalMs: 1_000 },
      onState: states.onState,
    });
    await flush();
    expect(states.states.at(-1)).toMatchObject({ status: "error", value: "kept", hasValue: true });
    second.dispose();
  });

  test("a late result after unmount never rearms timers", async () => {
    const { clock, coordinator } = setup();
    const transport = deferredTransport<string>();
    const sub = coordinator.subscribe({
      key: key(),
      read: transport.read,
      demand: { intervalMs: 1_000 },
    });
    sub.invalidate();
    sub.dispose();
    await transport.resolveLast("late");
    expect(transport.calls).toHaveLength(1);
    expect(clock.pending).toBe(0);
  });

  test("cleanup after cancellation settles queued refreshes and removes every listener", async () => {
    const { clock, document, window, coordinator } = setup();
    const transport = deferredTransport<string>();
    const sub = coordinator.subscribe({
      key: key(),
      read: transport.read,
      demand: { intervalMs: 1_000 },
    });
    const queued = sub.refresh();
    sub.dispose();
    await transport.resolveLast("in-flight");
    const state = await queued;
    expect(state.value).toBe("in-flight");
    expect(transport.calls).toHaveLength(1);
    expect(clock.pending).toBe(0);

    const other = coordinator.subscribe({
      key: key({ target: "other" }),
      read: transport.read,
      demand: { intervalMs: 1_000 },
    });
    const orphan = other.refresh();
    coordinator.dispose();
    expect((await orphan).status).toBe("loading");
    expect(transport.last().context.signal.aborted).toBe(true);
    expect(document.listenerCount + window.listenerCount).toBe(0);
    expect(clock.pending).toBe(0);
    await transport.resolveLast("after-dispose");
    expect(clock.pending).toBe(0);
  });

  test("subscriber-less entries are bounded", async () => {
    const { coordinator } = setup({ maxRetainedEntries: 2 });
    for (const target of ["a", "b", "c", "d"]) {
      coordinator.subscribe({ key: key({ target }), read: async () => target }).dispose();
      await flush();
    }
    expect(coordinator.getDiagnostics().entries.map((entry) => entry.id)).toEqual([
      JSON.stringify(["files-panel", "c", "", ""]),
      JSON.stringify(["files-panel", "d", "", ""]),
    ]);
  });
});

describe("read coordinator: quiet backoff policy hook", () => {
  test("steps through the quiet schedule and resets on invalidation", async () => {
    const { clock, coordinator } = setup();
    const starts: number[] = [];
    const sub = coordinator.subscribe({
      key: key(),
      read: async () => {
        starts.push(clock.now());
      },
      readOnSubscribe: false,
      demand: { intervalMs: 1_000, quietBackoffMs: [3_000, 5_000] },
    });
    await clock.advance(14_000);
    expect(starts).toEqual([1_000, 4_000, 9_000, 14_000]);
    await clock.advance(500);
    sub.invalidate();
    await flush();
    await clock.advance(1_000);
    expect(starts).toEqual([1_000, 4_000, 9_000, 14_000, 14_500, 15_500]);
  });

  test("is disabled when any periodic subscriber has not opted in", async () => {
    const { clock, coordinator } = setup();
    const starts: number[] = [];
    const read = async () => {
      starts.push(clock.now());
    };
    coordinator.subscribe({
      key: key(),
      read,
      readOnSubscribe: false,
      demand: { intervalMs: 1_000, quietBackoffMs: [3_000] },
    });
    coordinator.subscribe({
      key: key(),
      read,
      readOnSubscribe: false,
      demand: { intervalMs: 1_000 },
    });
    await clock.advance(4_000);
    expect(starts).toEqual([1_000, 2_000, 3_000, 4_000]);
  });
});

describe("shared coordinator", () => {
  test("transport reconnects reach the shared instance without creating one", () => {
    let notified = 0;
    resetReadCoordinatorForTests(() => {
      const stub = createReadCoordinator({ document: null, window: null });
      return { ...stub, notifyReconnected: () => (notified += 1) } as ReadCoordinator;
    });
    try {
      notifyReadCoordinatorReconnected();
      expect(notified).toBe(0);
      getReadCoordinator();
      notifyReadCoordinatorReconnected();
      expect(notified).toBe(1);
    } finally {
      resetReadCoordinatorForTests();
    }
  });
});
