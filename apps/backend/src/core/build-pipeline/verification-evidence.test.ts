import { describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type {
  BuildPipeline,
  PipelineSession,
  PipelineSessionPhase,
} from "@orkestrator/protocol/build-pipeline";
import { BuildPipelineContext } from "./context.js";
import { BuildPipelineAgents } from "./service-agents.js";
import { BuildPipelineRecovery } from "./service-recovery.js";
import { BuildPipelineInteractions } from "./service-interactions.js";
import { BuildPipelineSupervisor } from "./service-supervisor.js";
import { StorageService } from "../storage.js";
import { ADDRESS_FINDINGS_RESULT_FRAME_OPEN } from "@orkestrator/protocol/review-evidence-frames";

function session(phase: PipelineSessionPhase, key: string, iteration = 0): PipelineSession {
  return {
    phase,
    iteration,
    sessionKey: key,
    sdkSessionId: key,
    status: "idle",
    startedAt: new Date(0).toISOString(),
    label: phase,
  };
}

/** A typed Address session; with a summary, its accepted result. */
function typed(key: string, summary?: string): PipelineSession {
  return {
    ...session("address-findings", key),
    addressFindingsReportKind: "address-findings-result",
    ...(summary
      ? {
          addressFindingsResult: {
            complete: true,
            summary,
            filesChanged: ["src/app.ts"],
            commandsRun: [],
            notes: [],
            limitations: [],
          },
        }
      : {}),
  };
}

function assistant(text: string) {
  return { role: "assistant", parts: [{ type: "text", content: text }] };
}

async function withSupervisor(
  run: (
    supervisor: BuildPipelineSupervisor,
    ctx: BuildPipelineContext,
    value: BuildPipeline,
  ) => Promise<void>,
  invoke: (command: string, args?: Record<string, unknown>) => Promise<unknown> = async () => {
    throw new Error("Unexpected command");
  },
) {
  const dataDir = await fs.mkdtemp(path.join(tmpdir(), "pipeline-verification-evidence-"));
  const storage = new StorageService(dataDir);
  await storage.init();
  const ctx = new BuildPipelineContext(
    storage,
    invoke as <T>(command: string, args?: Record<string, unknown>) => Promise<T>,
    { autoAdvance: false },
  );
  const agents = new BuildPipelineAgents(ctx);
  const recovery = new BuildPipelineRecovery(ctx, {
    startStage: (...args) => supervisor.startStage(...args),
    dispatchPending: (...args) => supervisor.dispatchPending(...args),
    assertValidationWorktreeUnchanged: (...args) =>
      supervisor.assertValidationWorktreeUnchanged(...args),
    remindMissingStageResult: (...args) => supervisor.remindMissingStageResult(...args),
    probeWorktreeOnce: (...args) => supervisor.probeWorktreeOnce(...args),
  });
  const supervisor = new BuildPipelineSupervisor(
    ctx,
    agents,
    recovery,
    new BuildPipelineInteractions(ctx, agents, recovery),
  );
  const value: BuildPipeline = {
    id: "pipeline-evidence",
    taskId: "task",
    projectId: "project",
    environmentId: "env",
    environmentType: "local",
    agentType: "claude",
    phase: "verifying",
    sessions: [],
    currentSessionIndex: -1,
    iteration: 0,
    maxIterations: 3,
    createdAt: new Date(0).toISOString(),
    taskTitle: "Verify evidence",
    taskSnapshot: {
      title: "Verify evidence",
      description: "",
      acceptanceCriteria: "Fix the branch",
      comments: [],
      images: [],
    },
    backendRevision: 1,
    controller: "backend",
  };
  try {
    await run(supervisor, ctx, value);
  } finally {
    await fs.rm(dataDir, { recursive: true, force: true });
  }
}

describe("verification address-report boundaries", () => {
  test("uses the latest address retry after the matching review", async () => {
    await withSupervisor(async (supervisor, _ctx, value) => {
      value.sessions = [
        session("review", "review"),
        typed("first", "OBSOLETE REPORT"),
        typed("retry", "CURRENT RETRY REPORT"),
      ];
      const { prompt } = await supervisor.promptFor(value, "verify", "claude");
      expect(prompt).toContain("CURRENT RETRY REPORT");
      expect(prompt).not.toContain("OBSOLETE REPORT");
    });
  });

  test("a newer review with no address stage excludes the earlier report", async () => {
    await withSupervisor(async (supervisor, _ctx, value) => {
      value.sessions = [
        session("review", "review-0"),
        typed("old", "STALE REPORT"),
        session("review", "review-1"),
      ];
      const { prompt } = await supervisor.promptFor(value, "verify", "claude");
      expect(prompt).toContain("**Address Findings report**: none.");
      expect(prompt).not.toContain("STALE REPORT");
    });
  });

  test("a later fix iteration without a new review excludes the previous round", async () => {
    await withSupervisor(async (supervisor, _ctx, value) => {
      value.iteration = 1;
      value.sessions = [
        session("review", "review-0"),
        typed("old", "ITERATION ZERO REPORT"),
        session("verify", "verify-0"),
        session("rework", "fix-1", 1),
      ];
      const { prompt } = await supervisor.promptFor(value, "verify", "claude");
      expect(prompt).toContain("**Address Findings report**: none.");
      expect(prompt).not.toContain("ITERATION ZERO REPORT");
    });
  });

  test("an address session without a matching review is not used", async () => {
    await withSupervisor(async (supervisor, _ctx, value) => {
      value.sessions = [session("review", "old-review", -1), typed("orphan", "ORPHAN REPORT")];
      const { prompt } = await supervisor.promptFor(value, "verify", "claude");
      expect(prompt).toContain("**Address Findings report**: none.");
      expect(prompt).not.toContain("ORPHAN REPORT");
    });
  });

  test("a latest attempt with no accepted result does not fall back to a previous attempt", async () => {
    await withSupervisor(async (supervisor, _ctx, value) => {
      value.sessions = [session("review", "review"), typed("old", "OLD ATTEMPT"), typed("latest")];
      const { prompt } = await supervisor.promptFor(value, "verify", "claude");
      expect(prompt).toContain("**Address Findings report**: none.");
      expect(prompt).not.toContain("OLD ATTEMPT");
    });
  });

  test("a typed address session hands Verify its accepted result, never its text", async () => {
    await withSupervisor(async (supervisor, ctx, value) => {
      const address = typed("typed", "TYPED SUMMARY");
      value.sessions = [session("review", "review"), address];
      ctx.transcriptCheckpoints.observe(address, [assistant("TRANSCRIPT TEXT")]);
      const { prompt } = await supervisor.promptFor(value, "verify", "claude");
      expect(prompt).toContain("TYPED SUMMARY");
      expect(prompt).toContain(ADDRESS_FINDINGS_RESULT_FRAME_OPEN);
      expect(prompt).not.toContain("TRANSCRIPT TEXT");
    });
  });

  test("a typed address session with no accepted result has no report", async () => {
    await withSupervisor(async (supervisor, ctx, value) => {
      const skipped = {
        ...session("address-findings", "skipped"),
        addressFindingsReportKind: "address-findings-result" as const,
        skipped: true,
      };
      value.sessions = [session("review", "review"), skipped];
      ctx.transcriptCheckpoints.observe(skipped, [assistant("PARTIAL TEXT")]);
      const { prompt } = await supervisor.promptFor(value, "verify", "claude");
      expect(prompt).toContain("**Address Findings report**: none.");
      expect(prompt).not.toContain("PARTIAL TEXT");
    });
  });

  test("a superseded address session is not this round's report", async () => {
    await withSupervisor(async (supervisor, _ctx, value) => {
      const superseded = { ...typed("superseded", "SUPERSEDED REPORT"), supersededBy: "rewind-1" };
      value.sessions = [session("review", "review"), typed("live", "LIVE REPORT"), superseded];
      const { prompt } = await supervisor.promptFor(value, "verify", "claude");
      expect(prompt).toContain("LIVE REPORT");
      expect(prompt).not.toContain("SUPERSEDED REPORT");
    });
  });

  test("an address session from before the typed handoff has no report", async () => {
    await withSupervisor(async (supervisor, ctx, value) => {
      const legacy = session("address-findings", "legacy");
      value.sessions = [session("review", "review"), legacy];
      ctx.transcriptCheckpoints.observe(legacy, [assistant("LEGACY REPORT")]);
      const { prompt } = await supervisor.promptFor(value, "verify", "claude");
      expect(prompt).toContain("**Address Findings report**: none.");
      expect(prompt).not.toContain("LEGACY REPORT");
    });
  });
});

describe("verification ancestry of the validated commit", () => {
  const validated = "a".repeat(40);
  const captured = "b".repeat(40);
  const withPackage = (value: BuildPipeline) => {
    value.reviewPackage = {
      format: 2,
      id: "package-1",
      round: 1,
      preparedAt: new Date(0).toISOString(),
      targetBranch: "main",
      baseRef: "c".repeat(40),
      headRef: validated,
      commit: null,
      diffCommand: "git diff",
      changedFiles: [],
      validation: [],
      uncommittedFiles: [],
      limitations: [],
    } as unknown as BuildPipeline["reviewPackage"];
  };

  test("states the backend's answer about the captured HEAD", async () => {
    for (const isAncestor of [true, false]) {
      const calls: unknown[] = [];
      await withSupervisor(
        async (supervisor, _ctx, value) => {
          withPackage(value);
          const { prompt } = await supervisor.promptFor(value, "verify", "claude", {
            status: "clean",
            head: captured,
          });
          expect(prompt).toContain(
            isAncestor ? "**Validated commit in history**" : "**Validated commit not in history**",
          );
        },
        async (command, args) => {
          calls.push({ command, args });
          return { isAncestor };
        },
      );
      // Asked about the HEAD the baseline names, not whatever HEAD is live now.
      expect(calls).toEqual([
        {
          command: "get_environment_commit_ancestry",
          args: { environmentId: "env", ancestor: validated, descendant: captured },
        },
      ]);
    }
  });

  test("needs no Git call when Verify starts at the validated commit", async () => {
    await withSupervisor(async (supervisor, _ctx, value) => {
      withPackage(value);
      const { prompt } = await supervisor.promptFor(value, "verify", "claude", {
        status: "clean",
        head: validated,
      });
      expect(prompt).toContain("**Validated commit in history**");
    });
  });

  test("leaves the check to the verifier when Git cannot answer", async () => {
    for (const invoke of [
      async () => ({ isAncestor: null }),
      async () => {
        throw new Error("container gone");
      },
    ]) {
      await withSupervisor(async (supervisor, _ctx, value) => {
        withPackage(value);
        const { prompt } = await supervisor.promptFor(value, "verify", "claude", {
          status: "clean",
          head: captured,
        });
        expect(prompt).not.toContain("**Validated commit");
        expect(prompt).toContain("git merge-base --is-ancestor <headRef> HEAD");
      }, invoke);
    }
  });
});
