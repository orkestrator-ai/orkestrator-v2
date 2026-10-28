import { describe, expect, test } from "bun:test";
import {
  MAX_CODE_REWIND_COMMIT_SUBJECT_LENGTH,
  type PipelineRewind,
  type PipelineSession,
} from "@orkestrator/protocol/build-pipeline";
import {
  codeRewindBackupRef,
  codeRewindStateBlocker,
  forcePushUpstream,
  inspectCodeRewind,
  type EnvironmentGit,
} from "./build-pipeline-code-rewind.js";

const TARGET = "b".repeat(40);
const HEAD = "c".repeat(40);

describe("code rewind rules", () => {
  test("backup refs stay valid ref names whatever the pipeline ID", () => {
    expect(codeRewindBackupRef("pipe/../line .lock", "rewind-1")).toBe(
      "refs/orkestrator/build-pipeline-rewinds/pipe----line--lock/rewind-1",
    );
    expect(codeRewindBackupRef("...", "rewind-1")).toBe(
      "refs/orkestrator/build-pipeline-rewinds/pipeline/rewind-1",
    );
  });

  test("a running step, running validation or a missing start commit blocks the rewind", () => {
    const recorded = { headAtStart: TARGET };
    expect(codeRewindStateBlocker({ phase: "complete" }, recorded)).toBeUndefined();
    expect(codeRewindStateBlocker({ phase: "paused" }, recorded)).toBeUndefined();
    expect(codeRewindStateBlocker({ phase: "failed" }, {})).toContain("was not recorded");
    expect(codeRewindStateBlocker({ phase: "verifying" }, recorded)).toContain("Pause");
    expect(
      codeRewindStateBlocker(
        {
          phase: "paused",
          validationRun: { status: "running" } as never,
        },
        recorded,
      ),
    ).toContain("Validation checks are still running");
  });

  test("inspection refuses a missing or non-ancestor commit", async () => {
    const missing: EnvironmentGit = async () => {
      throw new Error("fatal: bad revision");
    };
    await expect(inspectCodeRewind(missing, "env-1", TARGET)).rejects.toThrow(
      "is no longer in the repository",
    );
    const rewritten: EnvironmentGit = async (_id, args) => (args[0] === "rev-list" ? "2\n" : "");
    await expect(inspectCodeRewind(rewritten, "env-1", TARGET)).rejects.toThrow(
      "history was rewritten",
    );
    await expect(inspectCodeRewind(rewritten, "env-1", "not-a-commit")).rejects.toThrow(
      "not a commit ID",
    );
  });

  test("inspection bounds subjects and treats a missing upstream as none", async () => {
    const long = "s".repeat(MAX_CODE_REWIND_COMMIT_SUBJECT_LENGTH + 20);
    const git: EnvironmentGit = async (_id, args) => {
      if (args[0] === "rev-list") return args[2] === `HEAD..${TARGET}` ? "0\n" : "1\n";
      if (args[0] === "log") return `${HEAD}\u001f${long}\nnot-a-commit\u001fjunk\n`;
      throw new Error("fatal: no upstream configured for branch");
    };
    const inspection = await inspectCodeRewind(git, "env-1", TARGET);
    expect(inspection.commitCount).toBe(1);
    expect(inspection.upstream).toBeUndefined();
    expect(inspection.commits).toHaveLength(1);
    expect(inspection.commits[0]!.subject).toHaveLength(MAX_CODE_REWIND_COMMIT_SUBJECT_LENGTH);
    expect(inspection.commits[0]!.subject.endsWith("…")).toBe(true);
  });

  test("Ship force-pushes until a live Ship completes after the rewind", () => {
    const rewind: PipelineRewind = {
      id: "rewind-1",
      at: "2026-10-28T10:00:00.000Z",
      fromPhase: "complete",
      fromIteration: 0,
      iteration: 0,
      step: { kind: "session", phase: "build" },
      supersededSessions: 5,
      code: {
        from: HEAD,
        to: TARGET,
        droppedCommits: 3,
        backupRef: "refs/orkestrator/build-pipeline-rewinds/p/rewind-1",
        upstream: "origin/build",
        upstreamCommitsDropped: 2,
      },
    };
    const ship = (overrides: Partial<PipelineSession>): PipelineSession => ({
      phase: "pr",
      iteration: 0,
      sessionKey: "ship",
      sdkSessionId: "ship",
      status: "idle",
      startedAt: "2026-10-28T11:00:00.000Z",
      label: "Ship",
      ...overrides,
    });
    expect(forcePushUpstream({ rewinds: [rewind], sessions: [] })).toBe("origin/build");
    // An older Ship, a superseded one and a failed one do not count.
    expect(
      forcePushUpstream({
        rewinds: [rewind],
        sessions: [
          ship({ startedAt: "2026-10-28T09:00:00.000Z" }),
          ship({ supersededBy: "rewind-2" }),
          ship({ status: "error" }),
        ],
      }),
    ).toBe("origin/build");
    expect(forcePushUpstream({ rewinds: [rewind], sessions: [ship({})] })).toBeUndefined();
    expect(
      forcePushUpstream({
        rewinds: [{ ...rewind, code: { ...rewind.code!, upstreamCommitsDropped: 0 } }],
        sessions: [],
      }),
    ).toBeUndefined();
  });
});
