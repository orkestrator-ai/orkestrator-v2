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
  resetWorktreeToCommit,
  type EnvironmentGit,
} from "./build-pipeline-code-rewind.js";
import { EnvironmentUnavailableError } from "./workspace-code-rewind.js";

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
    expect(codeRewindStateBlocker({ phase: "complete", sessions: [] }, recorded)).toBeUndefined();
    expect(codeRewindStateBlocker({ phase: "paused", sessions: [] }, recorded)).toBeUndefined();
    expect(codeRewindStateBlocker({ phase: "failed", sessions: [] }, {})).toContain(
      "was not recorded",
    );
    expect(codeRewindStateBlocker({ phase: "verifying", sessions: [] }, recorded)).toContain(
      "Pause",
    );
    expect(
      codeRewindStateBlocker(
        {
          phase: "paused",
          sessions: [],
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

  test("a container that cannot run Git is never read as a Git answer", async () => {
    const paused = () => new EnvironmentUnavailableError("The environment's container is paused.");
    // Not "the commit is gone".
    const atAncestry: EnvironmentGit = async () => {
      throw paused();
    };
    await expect(inspectCodeRewind(atAncestry, "env-1", TARGET)).rejects.toBeInstanceOf(
      EnvironmentUnavailableError,
    );
    // Not "no upstream", which would let the next Ship push without lease.
    const atUpstream: EnvironmentGit = async (_id, args) => {
      if (args[0] === "rev-list") return "0\n";
      if (args[0] === "log") return "";
      throw paused();
    };
    await expect(inspectCodeRewind(atUpstream, "env-1", TARGET)).rejects.toThrow(
      "The environment's container is paused.",
    );

    // Not "no backup yet": nothing is written.
    const calls: string[][] = [];
    const atBackup: EnvironmentGit = async (_id, args) => {
      calls.push(args);
      if (args[0] === "rev-parse" && args[1] === "HEAD") return `${HEAD}\n`;
      if (args[0] === "status") return "";
      throw paused();
    };
    const reset = { from: HEAD, to: TARGET, backupRef: "refs/orkestrator/x/y" };
    await expect(resetWorktreeToCommit(atBackup, "env-1", reset)).rejects.toBeInstanceOf(
      EnvironmentUnavailableError,
    );
    expect(calls.map((call) => call[0])).toEqual(["rev-parse", "status", "rev-parse"]);

    // An applied reset whose backup ref is missing says so, not Git's text.
    let unavailable = false;
    const applied: EnvironmentGit = async (_id, args) => {
      if (args[0] === "rev-parse" && args[1] === "HEAD") return `${TARGET}\n`;
      if (args[0] === "status") return "";
      if (unavailable) throw paused();
      throw new Error("fatal: ambiguous argument 'refs/orkestrator/x/y': unknown revision");
    };
    await expect(resetWorktreeToCommit(applied, "env-1", reset)).rejects.toThrow(
      "The pending rewind's backup ref is missing.",
    );
    unavailable = true;
    await expect(resetWorktreeToCommit(applied, "env-1", reset)).rejects.toBeInstanceOf(
      EnvironmentUnavailableError,
    );
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
