import { mkdtemp, writeFile, chmod, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import config from "../routes/config.js";
import { describe, expect, jest, mock, test } from "bun:test";
import {
  createSession,
  mockQuery,
  nextQueryCall,
  queryControlOverrides,
  sendPrompt,
  track,
  waitFor,
} from "./session-manager-test-harness.js";
import {
  CLAUDE_MODEL_CACHE_TTL_MS,
  CLAUDE_MODEL_PROBE_TIMEOUT_MS,
  getAvailableModelCatalog,
} from "./claude-model-catalog.js";
import { readClaudeAuthStatus } from "./claude-sign-in.js";
import { refreshClaudeCatalogs } from "./session-manager.js";

// Without a running CLI a catalogue read costs a process, and the backend
// re-reads every 5 minutes. These cover what may reuse the last answer and what
// must not.

const SIGNED_IN = { apiProvider: "firstParty", subscriptionType: "max", organization: "Acme" };
const OTHER_ACCOUNT = { apiProvider: "firstParty", subscriptionType: "pro", organization: "Beta" };

const MODEL = (value: string) => ({
  value,
  resolvedModel: `${value}-20261001`,
  displayName: value,
  description: value,
  supportsFastMode: false,
  supportsEffort: true,
  supportedEffortLevels: ["low", "high"],
  supportsAdaptiveThinking: true,
  supportsAutoMode: false,
});

/** Every probe answers for `account`. */
function probesAnswerFor(account: object) {
  queryControlOverrides.accountInfo = async () => account;
}

function probesSoFar(): number {
  return mockQuery.mock.calls.length;
}

async function modelIds(): Promise<string[]> {
  return (await getAvailableModelCatalog()).models.map((model) => model.id);
}

/** A session whose CLI stays open after one turn, as between real turns. */
async function warmSession(name: string) {
  const session = createSession(name);
  track(session.id);
  // An earlier probe's query is still queued ahead of this turn's.
  for (let queued = probesSoFar(); queued > 0; queued -= 1) {
    await nextQueryCall(1).catch(() => undefined);
  }
  const prompt = sendPrompt(session.id, "hello", { includeLocalSettings: true });
  const call = await nextQueryCall();
  call.push({ type: "result", subtype: "success" });
  await prompt;
  await waitFor(() => session.status === "idle");
  return session;
}

describe("the model catalogue without a running CLI", () => {
  test("a second read reuses the probe's answer", async () => {
    probesAnswerFor(SIGNED_IN);
    expect(await modelIds()).toEqual(["claude-opus-mock"]);
    expect(await modelIds()).toEqual(["claude-opus-mock"]);
    expect(probesSoFar()).toBe(1);
    expect((await getAvailableModelCatalog()).source).toBe("sdk");
  });

  test("reads waiting at the same time share one probe", async () => {
    probesAnswerFor(SIGNED_IN);
    const reads = await Promise.all([modelIds(), modelIds(), modelIds()]);
    expect(reads).toEqual([["claude-opus-mock"], ["claude-opus-mock"], ["claude-opus-mock"]]);
    expect(probesSoFar()).toBe(1);
  });

  test("a signed-out answer is not kept", async () => {
    probesAnswerFor({ apiProvider: "firstParty" });
    await modelIds();
    await modelIds();
    expect(probesSoFar()).toBe(2);
  });

  test("an answer that names no account is not kept", async () => {
    await modelIds();
    await modelIds();
    expect(probesSoFar()).toBe(2);
  });

  test("an empty list is not kept", async () => {
    probesAnswerFor(SIGNED_IN);
    queryControlOverrides.supportedModels = async () => [];
    await modelIds();
    await modelIds();
    expect(probesSoFar()).toBe(2);
  });

  test("the static catalogue is reported as fallback, and never kept", async () => {
    probesAnswerFor(SIGNED_IN);
    mockQuery.mockImplementationOnce(() => {
      throw new Error("SDK unavailable");
    });
    expect((await getAvailableModelCatalog()).source).toBe("fallback");
    expect((await getAvailableModelCatalog()).source).toBe("sdk");
    expect(probesSoFar()).toBe(2);
  });

  test("a wedged probe answers from the static catalogue and holds no later read", async () => {
    probesAnswerFor(SIGNED_IN);
    queryControlOverrides.supportedModels = () => new Promise(() => undefined);
    jest.useFakeTimers();
    try {
      const wedged = getAvailableModelCatalog();
      await waitForTimerArmed();
      jest.advanceTimersByTime(CLAUDE_MODEL_PROBE_TIMEOUT_MS);
      expect((await wedged).source).toBe("fallback");
    } finally {
      jest.useRealTimers();
    }
    delete queryControlOverrides.supportedModels;
    expect((await getAvailableModelCatalog()).source).toBe("sdk");
    expect(probesSoFar()).toBe(2);
  });

  test("an account read that finds another account drops the answer", async () => {
    probesAnswerFor(SIGNED_IN);
    await modelIds();
    expect(probesSoFar()).toBe(1);
    probesAnswerFor(OTHER_ACCOUNT);
    await readClaudeAuthStatus();
    const beforeRead = probesSoFar();
    await modelIds();
    expect(probesSoFar()).toBe(beforeRead + 1);
    // Kept for the new account from here.
    await modelIds();
    expect(probesSoFar()).toBe(beforeRead + 1);
  });

  test("an account read that agrees keeps the answer", async () => {
    probesAnswerFor(SIGNED_IN);
    await modelIds();
    await readClaudeAuthStatus();
    const beforeRead = probesSoFar();
    await modelIds();
    expect(probesSoFar()).toBe(beforeRead);
  });

  test("a failed account read says nothing about the answer", async () => {
    probesAnswerFor(SIGNED_IN);
    await modelIds();
    queryControlOverrides.accountInfo = async () => {
      throw new Error("probe failed");
    };
    expect((await readClaudeAuthStatus()).state).toBe("unknown");
    const beforeRead = probesSoFar();
    await modelIds();
    expect(probesSoFar()).toBe(beforeRead);
  });

  test("an explicit catalogue refresh drops the answer", async () => {
    probesAnswerFor(SIGNED_IN);
    await modelIds();
    await refreshClaudeCatalogs();
    await modelIds();
    expect(probesSoFar()).toBe(2);
  });

  test("a probe started before a refresh answers its read but is not kept", async () => {
    probesAnswerFor(SIGNED_IN);
    let answer!: (models: unknown[]) => void;
    queryControlOverrides.supportedModels = () =>
      new Promise((resolve) => {
        answer = resolve;
      });
    const before = getAvailableModelCatalog();
    await waitFor(() => answer !== undefined);
    await refreshClaudeCatalogs();
    answer([MODEL("claude-old")]);
    expect((await before).models.map((model) => model.id)).toEqual(["claude-old"]);
    delete queryControlOverrides.supportedModels;
    expect(await modelIds()).toEqual(["claude-opus-mock"]);
  });

  test("a replaced CLI binary drops the answer", async () => {
    const previous = process.env.CLAUDE_CLI_PATH;
    probesAnswerFor(SIGNED_IN);
    try {
      process.env.CLAUDE_CLI_PATH = "/managed/toolchain/2.1.314/claude";
      await modelIds();
      await modelIds();
      expect(probesSoFar()).toBe(1);
      process.env.CLAUDE_CLI_PATH = "/managed/toolchain/2.1.315/claude";
      await modelIds();
      expect(probesSoFar()).toBe(2);
    } finally {
      if (previous === undefined) delete process.env.CLAUDE_CLI_PATH;
      else process.env.CLAUDE_CLI_PATH = previous;
    }
  });

  test("a forced route read bypasses remembered models", async () => {
    probesAnswerFor(SIGNED_IN);
    await modelIds();
    queryControlOverrides.supportedModels = async () => [MODEL("fresh")];
    const response = await config.request("/models?forceRefresh=true");
    expect((await response.json()).models[0].id).toBe("fresh");
    expect(probesSoFar()).toBe(2);
  });

  test("PATH executable replacement and settings edits invalidate the answer", async () => {
    const root = await mkdtemp(join(tmpdir(), "catalog-identity-"));
    const previous = {
      PATH: process.env.PATH,
      CLAUDE_CLI_PATH: process.env.CLAUDE_CLI_PATH,
      CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR,
    };
    try {
      const executable = join(root, "claude");
      await writeFile(executable, "#!/bin/sh\n");
      await chmod(executable, 0o755);
      process.env.PATH = root;
      process.env.CLAUDE_CLI_PATH = "claude";
      process.env.CLAUDE_CONFIG_DIR = root;
      probesAnswerFor(SIGNED_IN);
      await modelIds();
      await modelIds();
      expect(probesSoFar()).toBe(1);
      await writeFile(executable, "#!/bin/sh\nexit 0\n");
      await modelIds();
      expect(probesSoFar()).toBe(2);
      await writeFile(join(root, "settings.json"), '{"availableModels":["haiku"]}');
      await modelIds();
      expect(probesSoFar()).toBe(3);
    } finally {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      await rm(root, { recursive: true, force: true });
    }
  });

  test("a rejected model read after timeout stays handled and closes the query", async () => {
    let reject!: (error: Error) => void;
    const close = mock(async () => ({ done: true, value: undefined }));
    queryControlOverrides.return = close;
    queryControlOverrides.supportedModels = () =>
      new Promise((_, fail) => {
        reject = fail;
      });
    jest.useFakeTimers();
    try {
      const read = getAvailableModelCatalog();
      await waitForTimerArmed();
      jest.advanceTimersByTime(CLAUDE_MODEL_PROBE_TIMEOUT_MS);
      expect((await read).source).toBe("fallback");
      expect(close).toHaveBeenCalledTimes(1);
      reject(new Error("closed after timeout"));
      await Promise.resolve();
    } finally {
      jest.useRealTimers();
    }
    delete queryControlOverrides.supportedModels;
    expect((await getAvailableModelCatalog()).source).toBe("sdk");
  });

  test("the answer expires, as a backstop for a change nothing reported", async () => {
    probesAnswerFor(SIGNED_IN);
    await modelIds();
    const now = Date.now();
    const clock = jest.spyOn(Date, "now").mockReturnValue(now + CLAUDE_MODEL_CACHE_TTL_MS - 1);
    try {
      await modelIds();
      expect(probesSoFar()).toBe(1);
      clock.mockReturnValue(now + CLAUDE_MODEL_CACHE_TTL_MS + 60_000);
      await modelIds();
      expect(probesSoFar()).toBe(2);
    } finally {
      clock.mockRestore();
    }
  });
});

describe("the model catalogue with a running CLI", () => {
  test("a running CLI answers ahead of what was kept", async () => {
    probesAnswerFor(SIGNED_IN);
    await modelIds();
    const initializationResult = mock(async () => ({
      models: [MODEL("claude-live")],
      account: SIGNED_IN,
    }));
    queryControlOverrides.initializationResult = initializationResult;
    await warmSession("live over cache");
    expect(await modelIds()).toEqual(["claude-live"]);
    expect(initializationResult).toHaveBeenCalled();
  });

  test("refresh fences an old live answer even after runtime release", async () => {
    queryControlOverrides.initializationResult = async () => ({
      models: [MODEL("old")],
      account: SIGNED_IN,
    });
    const session = await warmSession("refresh old runtime");
    expect(await modelIds()).toEqual(["old"]);
    probesAnswerFor(SIGNED_IN);
    queryControlOverrides.supportedModels = async () => [MODEL("new")];
    await refreshClaudeCatalogs();
    expect(await modelIds()).toEqual(["new"]);
    session.claudeRuntime!.state = "ended";
    expect(await modelIds()).toEqual(["new"]);
  });

  test("its answer serves the reads after it is released", async () => {
    queryControlOverrides.initializationResult = async () => ({
      models: [MODEL("claude-live")],
      account: SIGNED_IN,
    });
    const session = await warmSession("released");
    expect(await modelIds()).toEqual(["claude-live"]);
    const launches = probesSoFar();
    session.claudeRuntime!.state = "ended";
    expect(await modelIds()).toEqual(["claude-live"]);
    expect(probesSoFar()).toBe(launches);
  });

  test("a CLI launched under another account than the last read saw is passed over", async () => {
    probesAnswerFor(SIGNED_IN);
    await readClaudeAuthStatus();
    queryControlOverrides.initializationResult = async () => ({
      models: [MODEL("claude-before-sign-in")],
      account: OTHER_ACCOUNT,
    });
    await warmSession("launched before a sign-in");
    expect(await modelIds()).toEqual(["claude-opus-mock"]);
  });

  test("a CLI launched signed out does not answer once a login is seen", async () => {
    probesAnswerFor(SIGNED_IN);
    await readClaudeAuthStatus();
    queryControlOverrides.initializationResult = async () => ({
      models: [MODEL("claude-signed-out")],
      account: { apiProvider: "firstParty" },
    });
    await warmSession("launched signed out");
    expect(await modelIds()).toEqual(["claude-opus-mock"]);
  });

  test("an answer that does not name its account still answers, but is not kept", async () => {
    queryControlOverrides.initializationResult = async () => ({ models: [MODEL("claude-live")] });
    const session = await warmSession("no account in the answer");
    expect(await modelIds()).toEqual(["claude-live"]);
    session.claudeRuntime!.state = "ended";
    expect(await modelIds()).toEqual(["claude-opus-mock"]);
  });
});

/** Let the read reach the probe's own timer under fake timers. */
async function waitForTimerArmed(): Promise<void> {
  for (let turn = 0; turn < 200 && jest.getTimerCount() === 0; turn += 1) {
    await new Promise<void>((resolve) => queueMicrotask(resolve));
  }
}
