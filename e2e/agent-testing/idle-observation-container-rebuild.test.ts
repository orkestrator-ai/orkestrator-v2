import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  CONTAINER_OPENCODE2_DB,
  assertInspectableSessionId,
  databaseInspectionScript,
  parseDatabaseEvidence,
  rebuildRequestFailure,
  rebuildSettled,
  runContainerRebuildCase,
  type DatabaseEvidence,
  type RebuildCaseContext,
  type RebuildCaseRecord,
  type RebuildProjection,
} from "./idle-observation-container-rebuild";

describe("database inspection script", () => {
  const directories: string[] = [];
  afterEach(() => {
    for (const directory of directories.splice(0)) {
      rmSync(directory, { recursive: true, force: true });
    }
  });
  const database = () => {
    const directory = mkdtempSync(path.join(tmpdir(), "idleqa-rebuild-db-"));
    directories.push(directory);
    return path.join(directory, "opencode2.db");
  };
  /** Run the script the way `docker exec` does: `sh -c`, the id in the environment. */
  const inspect = (databasePath: string, sessionId: string) => {
    const result = spawnSync("sh", ["-c", databaseInspectionScript(databasePath)], {
      encoding: "utf8",
      env: { PATH: process.env.PATH, ORKESTRATOR_QA_SESSION: sessionId },
      timeout: 10_000,
    });
    expect(result.status).toBe(0);
    return parseDatabaseEvidence(result.stdout);
  };

  test("an absent database prints -1 and no mentions", () => {
    expect(inspect(database(), "ses_01ABC")).toEqual({ bytes: -1, sessionMentions: 0 });
  });

  test("counts the session's lines in the main file and its WAL, and the main file's size", () => {
    const file = database();
    const main = "header\x00ses_01ABC row\nother\nses_01ABC again\n";
    writeFileSync(file, main);
    writeFileSync(`${file}-wal`, "wal ses_01ABC\nses_02XYZ\n");
    expect(inspect(file, "ses_01ABC")).toEqual({
      bytes: Buffer.byteLength(main),
      sessionMentions: 3,
    });
  });

  test("a present database that never names the session prints its size and zero", () => {
    const file = database();
    writeFileSync(file, "ses_02XYZ only\n");
    expect(inspect(file, "ses_01ABC")).toEqual({ bytes: 15, sessionMentions: 0 });
  });

  test("matches the id as a fixed string, not a pattern", () => {
    const file = database();
    writeFileSync(file, "sesX01ABC\n");
    expect(inspect(file, "ses.01ABC").sessionMentions).toBe(0);
  });

  test("defaults to the container path and refuses a path that could change the script", () => {
    expect(databaseInspectionScript()).toContain(`f='${CONTAINER_OPENCODE2_DB}'`);
    for (const bad of ["relative/opencode2.db", "/tmp/a b", "/tmp/x';id;'", "/tmp/$(id)"]) {
      expect(() => databaseInspectionScript(bad)).toThrow("not one the inspection script accepts");
    }
  });
});

describe("rebuild helpers", () => {
  test("the inspection's two numbers, and nothing else", () => {
    expect(parseDatabaseEvidence("40960 3\n")).toEqual({ bytes: 40_960, sessionMentions: 3 });
    expect(parseDatabaseEvidence("-1 0")).toEqual({ bytes: -1, sessionMentions: 0 });
    expect(() => parseDatabaseEvidence("cat: no such file")).toThrow("no evidence");
  });

  test("only a plain session id reaches the inspection script", () => {
    expect(() => assertInspectableSessionId("ses_01JABCdef-9")).not.toThrow();
    for (const bad of ["", "a b", "x;rm", "$(id)", "a".repeat(129)]) {
      expect(() => assertInspectableSessionId(bad)).toThrow();
    }
  });

  test("settled only on a new runtime whose setup is ready", () => {
    const ready = { status: "running", setupPhase: "ready" };
    expect(rebuildSettled({ ...ready, containerId: "old" }, "old")).toBe(false);
    expect(rebuildSettled({ ...ready, containerId: "new" }, "old")).toBe(true);
    expect(
      rebuildSettled({ status: "running", setupPhase: "cloning", containerId: "new" }, "old"),
    ).toBe(false);
    expect(
      rebuildSettled({ status: "creating", setupPhase: "ready", containerId: "new" }, "old"),
    ).toBe(false);
    expect(rebuildSettled(null, "old")).toBe(false);
  });

  test("a client timeout is followed, a refusal is not", () => {
    expect(rebuildRequestFailure(new Error("Timeout 30000ms exceeded."))).toBeNull();
    expect(rebuildRequestFailure(new Error("recreate_environment: preservation-required"))).toBe(
      "recreate_environment: preservation-required",
    );
  });
});

type Fixture = {
  context: RebuildCaseContext;
  record: RebuildCaseRecord;
  calls: string[];
  invocations: Array<{ command: string; args?: Record<string, unknown> }>;
};

/**
 * A scripted environment: turns reply with the word the prompt asks for, the
 * rebuild moves to `new-container` after `rebuildPolls` reads, and the
 * database and the session id after the rebuild are whatever the case sets.
 */
function fixture(
  options: {
    afterSessionId?: string;
    keepRows?: boolean;
    evidence?: (containerId: string) => DatabaseEvidence;
    refuse?: string;
    rebuildPolls?: number;
  } = {},
): Fixture {
  const calls: string[] = [];
  const invocations: Fixture["invocations"] = [];
  let rows: RebuildProjection["messages"] = [{ id: "m0", role: "assistant", content: "warm" }];
  let sessionId = "ses_before";
  let rebuilt = false;
  let polls = 0;
  const record: RebuildCaseRecord = { status: "passed", notes: [], timings: {} };
  const invoke = async <T>(command: string, args?: Record<string, unknown>): Promise<T> => {
    invocations.push({ command, args });
    if (command === "recreate_environment") {
      if (options.refuse) throw new Error(options.refuse);
      return undefined as T;
    }
    if (command === "get_environment") {
      polls += 1;
      if (polls >= (options.rebuildPolls ?? 2)) {
        if (!rebuilt) {
          rebuilt = true;
          if (options.afterSessionId) sessionId = options.afterSessionId;
          if (options.keepRows === false) rows = [];
        }
        return { containerId: "new-container", status: "running", setupPhase: "ready" } as T;
      }
      return { containerId: "old-container", status: "running", setupPhase: "ready" } as T;
    }
    throw new Error(`unexpected ${command}`);
  };
  let next = 0;
  const context: RebuildCaseContext = {
    environmentId: "env-1",
    containerId: "old-container",
    invoke: () => invoke,
    projection: async () => ({ sessionId, turn: { phase: "idle" }, messages: [...rows] }),
    sendFromBackend: async (prompt) => {
      calls.push(`send ${prompt}`);
      const word = /: (\S+)\./.exec(prompt)![1]!.toUpperCase();
      next += 1;
      rows.push({ id: `u${next}`, role: "user", content: prompt });
      rows.push({ id: `a${next}`, role: "assistant", content: word });
    },
    waitForReply: async (previous, word) => {
      calls.push(`wait ${word}`);
      if (!rows.some((row) => !previous.has(row.id) && String(row.content).includes(word))) {
        throw new Error(`no reply ${word}`);
      }
    },
    stopFake: async () => {
      calls.push("stop fake");
    },
    installFake: async (containerId) => {
      calls.push(`install fake ${containerId}`);
    },
    reopenAndShow: async (words) => {
      calls.push(`show ${words.length}`);
    },
    inspectDatabase: (containerId, id) => {
      calls.push(`inspect ${containerId} ${id}`);
      return options.evidence?.(containerId) ?? { bytes: 8_192, sessionMentions: 2 };
    },
    replyPrompt: (word) => `Reply with exactly: ${word.toLowerCase()}. Do not use any tools.`,
    nonce: () => "123456",
    progress: () => undefined,
    sleep: async () => undefined,
  };
  return { context, record, calls, invocations };
}

describe("the rebuild case", () => {
  test("follows the conversation across a preserving rebuild", async () => {
    const { context, record, calls, invocations } = fixture();
    await expect(runContainerRebuildCase(context, record)).resolves.toBe("new-container");
    expect(invocations.find((call) => call.command === "recreate_environment")?.args).toEqual({
      environmentId: "env-1",
      intent: "preserve",
      expectedContainerId: "old-container",
    });
    // The fake is stopped before the rebuild and served again in the new runtime,
    // and the database is checked on both runtimes.
    const order = calls.filter((call) => !call.startsWith("send") && !call.startsWith("wait"));
    expect(order).toEqual([
      "inspect old-container ses_before",
      "stop fake",
      "install fake new-container",
      "inspect new-container ses_before",
      "show 2",
    ]);
    expect(record.timings.databaseBytesAfter).toBe(8_192);
    expect(record.timings.rebuildMs).toBeGreaterThanOrEqual(0);
  });

  test("a new session after the rebuild fails the case", async () => {
    const { context, record } = fixture({ afterSessionId: "ses_new" });
    await expect(runContainerRebuildCase(context, record)).rejects.toThrow("different session");
  });

  test("lost rows fail the case", async () => {
    const { context, record } = fixture({ keepRows: false });
    await expect(runContainerRebuildCase(context, record)).rejects.toThrow("is gone");
  });

  test("a database missing from the new runtime fails the case", async () => {
    const { context, record } = fixture({
      evidence: (id) =>
        id === "new-container"
          ? { bytes: -1, sessionMentions: 0 }
          : { bytes: 1, sessionMentions: 1 },
    });
    await expect(runContainerRebuildCase(context, record)).rejects.toThrow("new runtime");
  });

  test("a database that never named the session fails before anything is rebuilt", async () => {
    const { context, record, invocations } = fixture({
      evidence: () => ({ bytes: 4_096, sessionMentions: 0 }),
    });
    await expect(runContainerRebuildCase(context, record)).rejects.toThrow("does not name");
    expect(invocations.some((call) => call.command === "recreate_environment")).toBe(false);
  });

  test("a refused rebuild fails the case with the refusal", async () => {
    const { context, record } = fixture({ refuse: "preservation-required", rebuildPolls: 1_000 });
    await expect(runContainerRebuildCase(context, record)).rejects.toThrow(
      "refused: preservation-required",
    );
  });

  test("a rebuild that never produces a new runtime times out", async () => {
    const { context, record } = fixture({ rebuildPolls: Number.POSITIVE_INFINITY });
    context.rebuildTimeoutMs = 0;
    await expect(runContainerRebuildCase(context, record)).rejects.toThrow("did not settle");
  });
});
