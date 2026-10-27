import { describe, expect, jest, mock, test } from "bun:test";
import {
  createSession,
  expectControlOnlyPrompt,
  nextQueryCall,
  queryControlOverrides,
  sendPrompt,
  track,
  waitFor,
} from "./session-manager-test-harness.js";
import { getAvailableModelCatalog, readClaudePlanUsage } from "./session-manager.js";
import { readClaudeAuthStatus } from "./claude-sign-in.js";
import {
  LIVE_CLAUDE_READ_TIMEOUT_MS,
  liveClaudeControls,
  readFromLiveClaude,
} from "./live-claude-control.js";

// The model catalogue, the account and the plan windows are bridge-wide. A
// CLI a session keeps warm between turns answers them; only without one does
// a read spawn a control-only probe.

const LIVE_MODEL = {
  value: "claude-live",
  resolvedModel: "claude-live-20261001",
  displayName: "Claude Live",
  description: "Listed by the running CLI",
  supportsFastMode: false,
  supportsEffort: true,
  supportedEffortLevels: ["low", "high"],
  supportsAdaptiveThinking: true,
  supportsAutoMode: false,
};

/** A session whose CLI stays open after one turn, as between real turns. */
async function warmSession(name: string) {
  const session = createSession(name);
  track(session.id);
  const prompt = sendPrompt(session.id, "hello", { includeLocalSettings: true });
  const call = await nextQueryCall();
  call.push({ type: "result", subtype: "success" });
  await prompt;
  await waitFor(() => session.status === "idle");
  expect(session.claudeRuntime?.state).toBe("open");
  return { session, call };
}

/** The read spawned no CLI of its own. */
async function expectNoProbe() {
  await expect(nextQueryCall(50)).rejects.toThrow("Timed out");
}

describe("bridge-wide reads from a running CLI", () => {
  test.each([undefined, "[]", '["user","project"]', '["local"]', "{}", "invalid"])(
    "probes past a CLI with mismatched settings sources: %s",
    async (sources) => {
      const initializationResult = mock(async () => ({ models: [LIVE_MODEL] }));
      queryControlOverrides.initializationResult = initializationResult;
      const { session } = await warmSession("mismatched settings");
      session.claudeRuntime!.launch.settingSources = sources;

      expect(liveClaudeControls()).toEqual([]);
      expect((await getAvailableModelCatalog()).models[0]?.id).toBe("claude-opus-mock");
      expect(initializationResult).not.toHaveBeenCalled();
      await expectControlOnlyPrompt(await nextQueryCall());
    },
  );

  test("selects the most recently active runtime without touching its idle clock", async () => {
    const { session: first } = await warmSession("first runtime");
    const { session: second } = await warmSession("second runtime");
    const older = first.claudeRuntime!;
    const newer = second.claudeRuntime!;
    older.lastFrameAt = Date.now();
    newer.lastFrameAt = older.lastFrameAt - 1;

    expect(liveClaudeControls()).toEqual([older.control, newer.control]);
    newer.lastFrameAt = older.lastFrameAt + 1;
    const read = mock(async (control) => (control === newer.control ? "newest" : "older"));
    expect(await readFromLiveClaude(read)).toBe("newest");
    expect(read).toHaveBeenCalledTimes(1);
    expect(read).toHaveBeenCalledWith(newer.control);
    expect(newer.lastFrameAt).toBe(older.lastFrameAt + 1);
    await expectNoProbe();
  });

  test.each(["draining", "aborted", "deleting", "marked-draining"])(
    "skips a %s runtime",
    async (kind) => {
      const { session } = await warmSession("ineligible runtime");
      const runtime = session.claudeRuntime!;
      try {
        if (kind === "draining") runtime.state = "draining";
        if (kind === "aborted") {
          const abortController = new AbortController();
          abortController.abort();
          session.claudeRuntime = { ...runtime, abortController };
        }
        if (kind === "deleting") session.deleting = true;
        if (kind === "marked-draining") session.queryControlDraining = runtime.control;
        const read = mock(async () => "unusable");
        expect(liveClaudeControls()).toEqual([]);
        expect(await readFromLiveClaude(read)).toBeUndefined();
        expect(read).not.toHaveBeenCalled();
      } finally {
        runtime.state = "open";
        session.claudeRuntime = runtime;
        session.deleting = false;
        session.queryControlDraining = undefined;
      }
    },
  );

  test.each(["timeout", "reject", "throw", "undefined"])(
    "falls through a newest runtime's %s to an older answer",
    async (kind) => {
      const { session: first } = await warmSession("older answering runtime");
      const { session: second } = await warmSession("newer failing runtime");
      first.claudeRuntime!.lastFrameAt = Date.now() - 1;
      second.claudeRuntime!.lastFrameAt = Date.now();
      let rejectLate: ((reason: Error) => void) | undefined;
      const read = mock((control) => {
        if (control === first.claudeRuntime!.control) return Promise.resolve("older answer");
        if (kind === "throw") throw new Error("closed synchronously");
        if (kind === "reject") return Promise.reject(new Error("closed"));
        if (kind === "undefined") return undefined;
        return new Promise<string>((_resolve, reject) => {
          rejectLate = reject;
        });
      });

      expect(await readFromLiveClaude(read, 5)).toBe("older answer");
      expect(read.mock.calls.map(([control]) => control)).toEqual([
        second.claudeRuntime!.control,
        first.claudeRuntime!.control,
      ]);
      // Bun fails the test on an unhandled late rejection.
      rejectLate?.(new Error("late transport rejection"));
      await Bun.sleep(0);
      await expectNoProbe();
    },
  );

  test("probes after every live initialization read times out", async () => {
    const initializationResult = mock(() => new Promise<never>(() => undefined));
    queryControlOverrides.initializationResult = initializationResult;
    await warmSession("stalled first runtime");
    await warmSession("stalled second runtime");

    jest.useFakeTimers();
    try {
      const catalog = getAvailableModelCatalog();
      expect(initializationResult).toHaveBeenCalledTimes(1);
      jest.advanceTimersByTime(LIVE_CLAUDE_READ_TIMEOUT_MS);
      await Promise.resolve();
      await Promise.resolve();
      expect(initializationResult).toHaveBeenCalledTimes(2);
      jest.advanceTimersByTime(LIVE_CLAUDE_READ_TIMEOUT_MS);
      expect((await catalog).models[0]?.id).toBe("claude-opus-mock");
    } finally {
      jest.useRealTimers();
    }
    await expectControlOnlyPrompt(await nextQueryCall());
  });

  test("the model catalogue comes from the running CLI's initialize answer", async () => {
    const initializationResult = mock(async () => ({ models: [LIVE_MODEL] }));
    queryControlOverrides.initializationResult = initializationResult;
    const { session } = await warmSession("live models");

    const catalog = await getAvailableModelCatalog();

    expect(catalog.source).toBe("sdk");
    expect(catalog.models).toEqual([
      {
        id: "claude-live",
        resolvedModel: "claude-live-20261001",
        name: "Claude Live",
        description: "Listed by the running CLI",
        supportsFastMode: false,
        supportsEffort: true,
        supportedEffortLevels: ["low", "high"],
        supportsAdaptiveThinking: true,
        supportsAutoMode: false,
      },
    ]);
    expect(initializationResult).toHaveBeenCalled();
    await expectNoProbe();
    // A read is not a frame: it leaves the CLI's idle clock alone.
    expect(session.claudeRuntime?.state).toBe("open");
  });

  test("probes when no CLI is running", async () => {
    const catalog = await getAvailableModelCatalog();
    expect(catalog.models.map((model) => model.id)).toEqual(["claude-opus-mock"]);
    await expectControlOnlyPrompt(await nextQueryCall());
  });

  test("probes past a CLI launched without user and project settings", async () => {
    queryControlOverrides.initializationResult = mock(async () => ({ models: [LIVE_MODEL] }));
    const { session } = await warmSession("coordinator-like launch");
    // A coordinator launches with no settings sources, and those settings can
    // narrow the model list a probe would report.
    session.claudeRuntime!.launch.settingSources = "[]";
    expect(liveClaudeControls()).toEqual([]);

    const catalog = await getAvailableModelCatalog();
    expect(catalog.models.map((model) => model.id)).toEqual(["claude-opus-mock"]);
    await expectControlOnlyPrompt(await nextQueryCall());
  });

  test("probes past an empty live model list", async () => {
    queryControlOverrides.initializationResult = mock(async () => ({ models: [] }));
    await warmSession("empty live list");

    const catalog = await getAvailableModelCatalog();
    expect(catalog.models.map((model) => model.id)).toEqual(["claude-opus-mock"]);
    await expectControlOnlyPrompt(await nextQueryCall());
  });

  test("a signed-in account comes from the running CLI", async () => {
    queryControlOverrides.initializationResult = mock(async () => ({
      account: { subscriptionType: "max", tokenSource: "claude.ai" },
    }));
    await warmSession("live account");

    await expect(readClaudeAuthStatus()).resolves.toMatchObject({
      state: "signed-in",
      account: { label: "max", plan: "max" },
    });
    await expectNoProbe();
  });

  test("a running CLI that launched signed out does not answer for the account", async () => {
    queryControlOverrides.initializationResult = mock(async () => ({ account: {} }));
    queryControlOverrides.accountInfo = mock(async () => ({
      subscriptionType: "pro",
      tokenSource: "claude.ai",
    }));
    await warmSession("signed out at launch");

    // A login since the CLI launched is visible only to a probe.
    await expect(readClaudeAuthStatus()).resolves.toMatchObject({ state: "signed-in" });
    await expectControlOnlyPrompt(await nextQueryCall());
  });

  test("plan usage comes from the running CLI's control channel", async () => {
    const getStructuredUsage = mock(async () => ({
      rate_limits_available: true,
      rate_limits: { five_hour: { utilization: 40 } },
    }));
    queryControlOverrides.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET =
      getStructuredUsage;
    await warmSession("live plan usage");
    getStructuredUsage.mockClear();

    await expect(readClaudePlanUsage()).resolves.toEqual([
      { window: "five_hour", label: "5-hour limit", usedPercent: 40 },
    ]);
    expect(getStructuredUsage).toHaveBeenCalledWith({ skipBehaviors: true });
    await expectNoProbe();
  });

  test("plan usage probes when the running CLI's answer fails", async () => {
    let liveControl: unknown;
    queryControlOverrides.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET = mock(
      async function (this: unknown) {
        // The running CLI's channel fails; the probe's answers.
        if (this === liveControl) throw new Error("Query closed before response received");
        return { rate_limits_available: false, rate_limits: null };
      },
    );
    const { session } = await warmSession("failing live plan usage");
    liveControl = session.claudeRuntime!.control;

    await expect(readClaudePlanUsage()).resolves.toEqual([]);
    await expectControlOnlyPrompt(await nextQueryCall());
  });
});
