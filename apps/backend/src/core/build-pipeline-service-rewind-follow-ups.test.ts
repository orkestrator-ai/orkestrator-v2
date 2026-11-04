import { CommandFailedError } from "./shell.js";
import { describe, expect, spyOn, test } from "bun:test";
import {
  isBuildPipeline,
  REVIEW_PACKAGE_SESSION_LABEL,
  type BuildPipeline,
} from "@orkestrator/protocol/build-pipeline";
import type { StructuredOutputResult } from "@orkestrator/protocol/structured-output";
import type { StructuredReviewReport } from "@orkestrator/protocol/structured-review";
import type { BuildPipelineService } from "./build-pipeline-service.js";
import type { StorageService } from "./storage.js";
import { EnvironmentMutationFence } from "./environment-replacement-fence.js";
import type { EnvironmentGit } from "./build-pipeline-code-rewind.js";
import { EnvironmentUnavailableError } from "./workspace-code-rewind.js";
import {
  TEST_ADDRESS_FINDINGS_RESULT,
  TEST_REVIEW_PREPARATION,
} from "./build-pipeline-test-fixtures.js";
import {
  cleanReview,
  mutateStored,
  pipeline,
  startInput,
  withService,
  type FakeProvider,
} from "./build-pipeline-service-test-support.js";

const advanceUntil = async (
  service: BuildPipelineService,
  storage: StorageService,
  id: string,
  done: (snapshot: BuildPipeline) => boolean,
): Promise<BuildPipeline> => {
  for (let pass = 0; pass < 60; pass += 1) {
    const snapshot = await pipeline(storage, id);
    if (done(snapshot)) return snapshot;
    await service.advanceNow(id);
  }
  const final = await pipeline(storage, id);
  throw new Error(`The pipeline did not reach the expected state: ${final.phase}`);
};

const live = (snapshot: BuildPipeline) =>
  snapshot.sessions.filter((session) => session.supersededBy === undefined);

/** A review whose one finding names the session that filed it. */
const reviewNaming = (sessionId: string): StructuredReviewReport => ({
  ...cleanReview,
  issues: [
    {
      severity: "P1",
      confidence: 90,
      category: "correctness",
      title: `Finding from ${sessionId}`,
      file: "src/app.ts",
      line: 12,
      symbol: "clamp",
      description: "The upper bound is exclusive where it should be inclusive.",
      evidence: "clamp(10) returns 9.",
      suggestion: "Use <= for the upper bound.",
      verification: "Add a boundary test for the maximum.",
    },
  ],
  verdict: { ready: "with-fixes", reasoning: "One real bug." },
  reviewSummary: "One issue found.",
});

/** Every review finds an issue and every verification fails. */
const reviewAndFailEveryRound = (provider: FakeProvider) => {
  provider.structured = async <T>(
    sessionId: string,
    requestId: string,
  ): Promise<StructuredOutputResult<T>> => {
    const phase = provider.phases.get(sessionId);
    return {
      ok: true,
      provider: "claude",
      requestId,
      value: (phase === "review"
        ? reviewNaming(sessionId)
        : phase === "build" || phase === "fix"
          ? TEST_REVIEW_PREPARATION
          : phase === "address"
            ? TEST_ADDRESS_FINDINGS_RESULT
            : { complete: false, rationale: `Still failing (${sessionId}).` }) as T,
    };
  };
};

describe("restarting an earlier round's Address", () => {
  test("reruns Address alone on that round's own report", async () => {
    await withService(async (service, storage, provider) => {
      reviewAndFailEveryRound(provider);
      const started = await service.start(startInput({ maxIterations: 2 }));
      const failed = await advanceUntil(
        service,
        storage,
        started.id,
        (snapshot) => snapshot.phase === "failed",
      );
      // One copy per round; the live report is the last round's.
      expect(failed.roundReviewReports?.map((entry) => entry.iteration)).toEqual([0, 1, 2]);
      const firstReview = failed.sessions.find(
        (session) => session.phase === "review" && session.iteration === 0,
      )!;
      const firstAddressFindings = failed.sessions.find(
        (session) => session.phase === "address" && session.iteration === 0,
      )!;
      expect(failed.structuredReview?.issues[0]?.title).not.toContain(firstReview.sdkSessionId);
      const created = provider.created.length;

      const restarted = await service.restartStep(started.id, firstAddressFindings.sessionKey);

      expect(restarted).toMatchObject({ phase: "addressing", iteration: 0 });
      expect(restarted.structuredReview?.issues[0]?.title).toBe(
        `Finding from ${firstReview.sdkSessionId}`,
      );
      // Only Address started: no review package preparation, no review.
      expect(provider.created.slice(created).map((entry) => entry.phase)).toEqual(["address"]);
      expect(provider.sent.at(-1)?.prompt).toContain(`Finding from ${firstReview.sdkSessionId}`);
      expect(restarted.rewinds?.at(-1)?.step).toEqual({ kind: "session", phase: "address" });
      // Later rounds' copies went with their superseded reviews.
      expect(restarted.roundReviewReports?.map((entry) => entry.iteration)).toEqual([0]);
      expect(isBuildPipeline(restarted)).toBe(true);

      const refailed = await advanceUntil(
        service,
        storage,
        started.id,
        (snapshot) => snapshot.phase === "failed",
      );
      expect(live(refailed).map((session) => `${session.phase}:${session.iteration}`)).toEqual([
        "build:0",
        "review:0",
        "address:0",
        "verify:0",
        "fix:1",
        "review:1",
        "address:1",
        "verify:1",
        "fix:2",
        "review:2",
        "address:2",
        "verify:2",
      ]);
    });
  });

  test("reviews again when the round's copy is gone", async () => {
    await withService(async (service, storage, provider) => {
      reviewAndFailEveryRound(provider);
      const started = await service.start(startInput({ maxIterations: 1 }));
      const failed = await advanceUntil(
        service,
        storage,
        started.id,
        (snapshot) => snapshot.phase === "failed",
      );
      await mutateStored(storage, started.id, (snapshot) => {
        delete snapshot.roundReviewReports;
      });
      const firstAddressFindings = failed.sessions.find(
        (session) => session.phase === "address" && session.iteration === 0,
      )!;
      const restarted = await service.restartStep(started.id, firstAddressFindings.sessionKey);
      expect(restarted.iteration).toBe(0);
      expect(restarted.structuredReview).toBeUndefined();
      expect(restarted.sessions.at(-1)?.label).toBe(REVIEW_PACKAGE_SESSION_LABEL);
    });
  });

  test("ignores a copy a later review attempt of the same round replaced", async () => {
    await withService(async (service, storage, provider) => {
      reviewAndFailEveryRound(provider);
      const started = await service.start(startInput({ maxIterations: 1 }));
      const failed = await advanceUntil(
        service,
        storage,
        started.id,
        (snapshot) => snapshot.phase === "failed",
      );
      const firstReview = failed.sessions.find(
        (session) => session.phase === "review" && session.iteration === 0,
      )!;
      await mutateStored(storage, started.id, (snapshot) => {
        // A retried review of round 0 started and has no report yet.
        snapshot.sessions.push({
          ...firstReview,
          sessionKey: "retried-review",
          sdkSessionId: "retried-review",
          startedAt: new Date().toISOString(),
        });
      });
      const firstAddressFindings = failed.sessions.find(
        (session) => session.phase === "address" && session.iteration === 0,
      )!;
      const restarted = await service.restartStep(started.id, firstAddressFindings.sessionKey);
      expect(restarted.structuredReview).toBeUndefined();
      expect(restarted.sessions.at(-1)?.label).toBe(REVIEW_PACKAGE_SESSION_LABEL);
    });
  });
});

describe("package-only restart on the single-review path", () => {
  test("prepares the package again and keeps the build that wrote the plan", async () => {
    await withService(async (service, storage, provider) => {
      const started = await service.start(startInput());
      const completed = await advanceUntil(
        service,
        storage,
        started.id,
        (snapshot) => snapshot.phase === "complete",
      );
      const build = completed.sessions.find((session) => session.phase === "build")!;
      expect(build.producedReviewPackagePlan).toBe(true);
      const created = provider.created.length;

      const restarted = await service.restartStep(started.id, `review-package:${build.sessionKey}`);

      expect(restarted.phase).toBe("fixing");
      expect(restarted.sessions.find((s) => s.sessionKey === build.sessionKey)?.supersededBy).toBe(
        undefined,
      );
      expect(restarted.rewinds?.at(-1)).toMatchObject({
        step: { kind: "review-package", implementationPhase: "build" },
        sessionKey: build.sessionKey,
      });
      expect(provider.created.slice(created).map((entry) => entry.label)).toEqual([
        REVIEW_PACKAGE_SESSION_LABEL,
      ]);
      // Every step after the plan is history: review, verify and Ship.
      expect(live(restarted).map((session) => session.phase)).toEqual(["build", "fix"]);

      // A repeat of the same request while preparation runs is a no-op.
      provider.runningPhases.add("fix");
      await service.advanceNow(started.id);
      const repeated = await service.restartStep(started.id, `review-package:${build.sessionKey}`);
      expect(repeated.rewinds).toHaveLength(restarted.rewinds!.length);
      expect(provider.created.length).toBe(created + 1);
      provider.runningPhases.delete("fix");

      const finished = await advanceUntil(
        service,
        storage,
        started.id,
        (snapshot) => snapshot.phase === "complete",
      );
      expect(live(finished).map((session) => session.phase)).toEqual([
        "build",
        "fix",
        "review",
        "verify",
        "pr",
      ]);
    });
  });

  test("refuses a step that did not prepare the package", async () => {
    await withService(async (service, storage) => {
      const started = await service.start(startInput());
      const completed = await advanceUntil(
        service,
        storage,
        started.id,
        (snapshot) => snapshot.phase === "complete",
      );
      const verify = completed.sessions.find((session) => session.phase === "verify")!;
      await expect(
        service.restartStep(started.id, `review-package:${verify.sessionKey}`),
      ).rejects.toThrow("did not prepare the review package");
    });
  });
});

const C0 = "a0".repeat(20);
const C1 = "a1".repeat(20);
const C2 = "a2".repeat(20);
const C3 = "a3".repeat(20);

/**
 * A linear history C0 → C3 with HEAD on C3 and the upstream on C2, enough to
 * answer the commands a code rewind runs.
 */
function fakeGit() {
  /** The service harness's controls, attached once the harness exists. */
  const worktree: { controls?: { currentHead: string; uncommittedPaths?: string[] } } = {};
  const history = [C0, C1, C2, C3];
  const calls: string[][] = [];
  let upstream: string | null = C2;
  const refs = new Map<string, string>();
  const index = (ref: string) => {
    const commit =
      ref === "HEAD" ? worktree.controls!.currentHead : ref === "@{upstream}" ? upstream : ref;
    const position = history.indexOf(commit ?? "");
    if (position < 0) throw new Error(`fatal: bad revision '${ref}'`);
    return position;
  };
  const git: EnvironmentGit = async (_environmentId, args) => {
    calls.push(args);
    const [command, ...rest] = args;
    if (command === "rev-list" && rest[0] === "--count") {
      const [from, to] = rest[1]!.split("..");
      return `${Math.max(0, index(to!) - index(from!))}\n`;
    }
    if (command === "log") {
      const [from, to] = rest.at(-1)!.split("..");
      return history
        .slice(index(from!) + 1, index(to!) + 1)
        .reverse()
        .map((sha, position) => `${sha}\u001fcommit ${history.indexOf(sha)} (${position})`)
        .join("\n");
    }
    if (command === "status")
      return (worktree.controls?.uncommittedPaths ?? []).map((p) => `?? ${p}`).join("\n");
    if (command === "rev-parse") {
      if (rest[0] === "HEAD") return worktree.controls!.currentHead;
      if (rest[0]?.startsWith("refs/")) {
        const sha = refs.get(rest[0]);
        if (!sha) throw new Error("Missing ref");
        return sha;
      }
      if (!upstream) throw new Error("fatal: no upstream configured");
      return "origin/build\n";
    }
    if (command === "update-ref") {
      refs.set(rest[0]!, rest[1]!);
      return "";
    }
    if (command === "reset") {
      worktree.controls!.currentHead = rest.at(-1)!;
      return "";
    }
    throw new Error(`Unexpected git ${args.join(" ")}`);
  };
  return {
    git,
    worktree,
    calls,
    refs,
    clearUpstream: () => {
      upstream = null;
    },
  };
}

/** A completed pipeline whose Build started on C0 and whose HEAD is now C3. */
async function completedOnC3(
  service: BuildPipelineService,
  storage: StorageService,
  controls: { currentHead: string },
) {
  controls.currentHead = C0;
  const started = await service.start(startInput());
  const completed = await advanceUntil(
    service,
    storage,
    started.id,
    (snapshot) => snapshot.phase === "complete",
  );
  controls.currentHead = C3;
  return { started, completed, build: completed.sessions.find((s) => s.phase === "build")! };
}

describe("rewinding the code to a step", () => {
  test("every agent stage records the commit it started from", async () => {
    await withService(async (service, storage, _provider, _invocations, controls) => {
      controls.currentHead = C0;
      const started = await service.start(startInput());
      await advanceUntil(service, storage, started.id, (p) => p.sessions.length > 0);
      controls.currentHead = C1;
      const completed = await advanceUntil(
        service,
        storage,
        started.id,
        (p) => p.phase === "complete",
      );
      expect(completed.sessions[0]?.headAtStart).toBe(C0);
      expect(completed.sessions.slice(1).every((session) => session.headAtStart === C1)).toBe(true);
      expect(isBuildPipeline(completed)).toBe(true);
    });
  });

  test("the preview names the dropped commits, the upstream and the pull request", async () => {
    const { git, worktree } = fakeGit();
    await withService(
      async (service, storage, _provider, _invocations, controls) => {
        worktree.controls = controls;
        const { started, build } = await completedOnC3(service, storage, controls);
        await storage.updateEnvironment("env-1", {
          prUrl: "https://github.com/acme/repo/pull/1",
          prState: "open",
        });
        const preview = await service.previewCodeRewind(started.id, build.sdkSessionId);
        expect(preview).toEqual({
          pipelineId: started.id,
          sessionKey: build.sessionKey,
          iteration: 0,
          targetCommit: C0,
          head: C3,
          commits: [
            { sha: C3, subject: "commit 3 (0)" },
            { sha: C2, subject: "commit 2 (1)" },
            { sha: C1, subject: "commit 1 (2)" },
          ],
          commitCount: 3,
          upstream: { ref: "origin/build", droppedCommits: 2 },
          pullRequest: { url: "https://github.com/acme/repo/pull/1", state: "open" },
        });
      },
      { environmentGit: git },
    );
  });

  test("the preview is blocked on a running pipeline and on uncommitted changes", async () => {
    const { git, worktree } = fakeGit();
    await withService(
      async (service, storage, provider, _invocations, controls) => {
        worktree.controls = controls;
        controls.currentHead = C0;
        const started = await service.start(startInput());
        provider.runningPhases.add("review");
        await advanceUntil(service, storage, started.id, (snapshot) =>
          snapshot.sessions.some((session) => session.phase === "review"),
        );
        const build = (await pipeline(storage, started.id)).sessions[0]!;
        controls.currentHead = C3;
        const running = await service.previewCodeRewind(started.id, build.sessionKey);
        expect(running.blocked).toContain("Pause the pipeline first");
        // The commits are still listed so the user can see what it would do.
        expect(running.commitCount).toBe(3);

        await service.pause(started.id);
        controls.uncommittedPaths = ["src/app.ts"];
        const dirty = await service.previewCodeRewind(started.id, build.sessionKey);
        expect(dirty.blocked).toContain("uncommitted changes");
        expect(dirty.uncommittedPaths).toEqual(["src/app.ts"]);
      },
      { environmentGit: git },
    );
  });

  test("the preview says the action is unavailable without git", async () => {
    await withService(async (service, storage, _provider, _invocations, controls) => {
      const { started, build } = await completedOnC3(service, storage, controls);
      const preview = await service.previewCodeRewind(started.id, build.sessionKey);
      expect(preview.blocked).toBe("Rewinding code is not available on this backend.");
      await expect(service.rewindCode(started.id, build.sessionKey, C3)).rejects.toThrow(
        "not available",
      );
    });
  });

  test("a confirmed rewind resets the branch, keeps a backup ref and restarts the step", async () => {
    const fake = fakeGit();
    const worktree = fake.worktree;
    await withService(
      async (service, storage, provider, _invocations, controls) => {
        worktree.controls = controls;
        const { started, completed, build } = await completedOnC3(service, storage, controls);
        const created = provider.created.length;

        const rewound = await service.rewindCode(started.id, build.sessionKey, C3);

        expect(controls.currentHead).toBe(C0);
        const rewind = rewound.rewinds!.at(-1)!;
        expect(rewind).toMatchObject({
          fromPhase: "complete",
          iteration: 0,
          step: { kind: "session", phase: "build" },
          sessionKey: build.sessionKey,
          supersededSessions: completed.sessions.length,
          code: {
            from: C3,
            to: C0,
            droppedCommits: 3,
            upstream: "origin/build",
            upstreamCommitsDropped: 2,
          },
        });
        expect(rewind.code!.backupRef).toStartWith("refs/orkestrator/build-pipeline-rewinds/");
        expect(fake.refs.get(rewind.code!.backupRef)).toBe(C3);
        expect(fake.calls.at(-1)).toEqual(["reset", "--hard", C0]);
        expect(provider.created.slice(created).map((entry) => entry.phase)).toEqual(["build"]);
        expect(rewound.sessions.at(-1)?.headAtStart).toBe(C0);
        expect(isBuildPipeline(rewound)).toBe(true);

        // A double click on the confirmation is the same request: a no-op.
        const repeated = await service.rewindCode(started.id, build.sessionKey, C3);
        expect(repeated.rewinds).toHaveLength(1);
        expect(fake.calls.filter((call) => call[0] === "reset")).toHaveLength(1);

        // The rewound branch dropped pushed commits, so Ship force-pushes.
        const finished = await advanceUntil(
          service,
          storage,
          started.id,
          (snapshot) => snapshot.phase === "complete",
        );
        const ship = finished.sessions.at(-1)!;
        expect(ship.phase).toBe("pr");
        const shipPrompt = provider.sent.find((entry) => entry.sessionId === ship.sdkSessionId);
        expect(shipPrompt?.prompt).toContain("git push --force-with-lease");
        expect(shipPrompt?.prompt).toContain("`origin/build`");
      },
      { environmentGit: fake.git },
    );
  });

  test("a plain restart invalidates an older code-rewind confirmation", async () => {
    const fake = fakeGit();
    await withService(
      async (service, storage, _provider, _invocations, controls) => {
        fake.worktree.controls = controls;
        const { started, build } = await completedOnC3(service, storage, controls);
        await service.previewCodeRewind(started.id, build.sessionKey);
        await service.restartStep(started.id, build.sessionKey);
        await expect(service.rewindCode(started.id, build.sessionKey, C3)).rejects.toThrow(
          "previous attempt",
        );
        expect(fake.calls.some((call) => ["reset", "update-ref"].includes(call[0]!))).toBe(false);
        expect(controls.currentHead).toBe(C3);
      },
      { environmentGit: fake.git },
    );
  });

  test("an unconfirmed pause abort prevents a reset", async () => {
    const fake = fakeGit();
    await withService(
      async (service, storage, provider, _invocations, controls) => {
        fake.worktree.controls = controls;
        controls.currentHead = C0;
        provider.runningPhases.add("build");
        const started = await service.start(startInput());
        const running = await advanceUntil(
          service,
          storage,
          started.id,
          (p) => p.sessions.length > 0,
        );
        provider.abort = async () => {
          throw new Error("abort failed");
        };
        await expect(service.pause(started.id)).rejects.toThrow("abort failed");
        expect((await pipeline(storage, started.id)).sessions[0]?.status).toBe("running");
        await expect(
          service.rewindCode(started.id, running.sessions[0]!.sessionKey, C0),
        ).rejects.toThrow("confirmed");
        expect(fake.calls).toHaveLength(0);
      },
      { environmentGit: fake.git },
    );
  });

  for (const disagreement of [
    "head",
    "dirty",
    "late-head",
    "late-dirty",
    "missing-target",
    "rewritten-target",
  ] as const) {
    test(`refuses a reset on ${disagreement} from the reset runner`, async () => {
      const fake = fakeGit();
      let confirming = false;
      const git: EnvironmentGit = async (id, args) => {
        if (confirming && args[0] === "rev-parse" && args[1] === "HEAD" && disagreement === "head")
          return C2;
        if (confirming && args[0] === "status" && disagreement === "dirty") return "?? new-file";
        if (confirming && args[0] === "rev-list" && args[2] === `HEAD..${C0}`) {
          if (disagreement === "missing-target") throw new Error("missing commit");
          if (disagreement === "rewritten-target") return "1";
        }
        const result = await fake.git(id, args);
        if (confirming && args[0] === "update-ref") {
          if (disagreement === "late-head") fake.worktree.controls!.currentHead = C2;
          if (disagreement === "late-dirty")
            fake.worktree.controls!.uncommittedPaths = ["new-file"];
        }
        return result;
      };
      await withService(
        async (service, storage, _provider, _invocations, controls) => {
          fake.worktree.controls = controls;
          const { started, build } = await completedOnC3(service, storage, controls);
          expect(
            (await service.previewCodeRewind(started.id, build.sessionKey)).blocked,
          ).toBeUndefined();
          confirming = true;
          await expect(service.rewindCode(started.id, build.sessionKey, C3)).rejects.toThrow();
          expect(fake.calls.some((call) => call[0] === "reset")).toBe(false);
          if (disagreement === "late-head") expect(controls.currentHead).toBe(C2);
          if (disagreement === "late-dirty")
            expect(controls.uncommittedPaths).toEqual(["new-file"]);
        },
        { environmentGit: git },
      );
    });
  }

  for (const fault of [
    "before-intent-save",
    "after-intent-save",
    "before-final-save",
    "after-final-save",
  ] as const) {
    test(`recovers exactly once after ${fault}`, async () => {
      const fake = fakeGit();
      await withService(
        async (service, storage, provider, _invocations, controls) => {
          fake.worktree.controls = controls;
          const { started, build } = await completedOnC3(service, storage, controls);
          const created = provider.created.length;
          let fired = false;
          storage.setBuildPipelineTranscriptFaults({
            at: async (stage) => {
              const reset = fake.calls.some((call) => call[0] === "reset");
              const final = fault.includes("final");
              const after = fault.startsWith("after");
              if (
                !fired &&
                reset === final &&
                stage === (after ? "after-control-save" : "before-control-save")
              ) {
                fired = true;
                throw new Error(fault);
              }
            },
          });
          await expect(service.rewindCode(started.id, build.sessionKey, C3)).rejects.toThrow(fault);
          expect(fired).toBe(true);
          expect(provider.created.length).toBe(created);
          if (fault === "before-intent-save") {
            expect(controls.currentHead).toBe(C3);
            expect((await pipeline(storage, started.id)).rewinds).toBeUndefined();
          } else {
            const pending = await pipeline(storage, started.id);
            expect(pending.rewinds?.at(-1)?.code).toMatchObject({ from: C3, to: C0 });
            // Startup reconciles the same persisted intent even with auto advance disabled.
            await service.init();
          }
          storage.setBuildPipelineTranscriptFaults(null);
          const recovered = await service.rewindCode(started.id, build.sessionKey, C3);
          expect(recovered.rewinds).toHaveLength(1);
          expect(recovered.rewinds![0]!.code?.pending).toBeUndefined();
          expect(fake.calls.filter((call) => call[0] === "reset")).toHaveLength(1);
          expect(controls.currentHead).toBe(C0);
          expect(provider.created.length).toBe(created + 1);
        },
        { environmentGit: fake.git },
      );
    });
  }

  test("a journaled reset the container cannot run yet says so, logs once and finishes later", async () => {
    const fake = fakeGit();
    let unavailable = false;
    let commandFailure = false;
    const git: EnvironmentGit = async (id, args) => {
      if (unavailable && commandFailure && args[0] === "reset") {
        throw new CommandFailedError(
          "Permission denied PRIVATE-GIT-REWIND password=credential-rewind-marker",
          { exitCode: 128 },
        );
      }
      if (unavailable && !commandFailure && args[0] === "update-ref") {
        throw new EnvironmentUnavailableError(
          "The environment's container is not running. Start the environment, then try again.",
        );
      }
      return fake.git(id, args);
    };
    const warn = spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      await withService(
        async (service, storage, provider, _invocations, controls) => {
          fake.worktree.controls = controls;
          const { started, build } = await completedOnC3(service, storage, controls);
          const created = provider.created.length;
          unavailable = true;
          const waiting = `The code rewind to ${C0.slice(0, 12)} has not finished, so this build cannot continue yet. The environment's container is not running.`;
          await expect(service.rewindCode(started.id, build.sessionKey, C3)).rejects.toThrow(
            waiting,
          );
          expect((await pipeline(storage, started.id)).rewinds?.at(-1)?.code?.pending).toBe(true);
          await expect(service.pause(started.id)).rejects.toThrow(waiting);
          for (let pass = 0; pass < 3; pass += 1) await service.advanceNow(started.id);
          const logged = () =>
            warn.mock.calls.filter((call) => String(call[0]).includes("rewind.pending"));
          expect(logged()).toHaveLength(1);
          expect(String(logged()[0]![0])).toContain("reason=unclassified");
          expect(String(logged()[0]![0])).not.toContain(waiting);
          expect(provider.created.length).toBe(created);
          expect(controls.currentHead).toBe(C3);

          commandFailure = true;
          await service.advanceNow(started.id);
          const safeLog = String(logged().at(-1)![0]);
          expect(safeLog).toContain("reason=permission-denied");
          expect(safeLog).toContain("exitCode=128");
          expect(safeLog).toContain(started.id);
          expect(safeLog).not.toContain("PRIVATE-GIT-REWIND");
          expect(safeLog).not.toContain("credential-rewind-marker");

          unavailable = false;
          await service.advanceNow(started.id);
          expect(controls.currentHead).toBe(C0);
          expect(fake.refs.size).toBe(1);
          await service.advanceNow(started.id);
          expect(provider.created.slice(created).map((entry) => entry.phase)).toEqual(["build"]);
          expect(logged()).toHaveLength(2);
        },
        { environmentGit: git },
      );
    } finally {
      warn.mockRestore();
    }
  });

  test.each(["in-progress", "review", "update-fails"] as const)(
    "a pending-reset Kanban pipeline can be deleted (%s)",
    async (ticketState) => {
      const fake = fakeGit();
      let unavailable = false;
      const git: EnvironmentGit = async (id, args) => {
        if (unavailable && args[0] === "update-ref") {
          throw new EnvironmentUnavailableError("The environment's container is not running.");
        }
        return fake.git(id, args);
      };
      const warn = spyOn(console, "warn").mockImplementation(() => undefined);
      try {
        await withService(
          async (service, storage, provider, invocations, controls) => {
            fake.worktree.controls = controls;
            const { started, build } = await completedOnC3(service, storage, controls);
            const taskId = "pending-rewind-ticket";
            controls.kanbanTasks.set(taskId, {
              id: taskId,
              status: ticketState === "update-fails" ? "review" : ticketState,
              comments: [{ text: "Existing lifecycle comment" }],
            });
            await mutateStored(storage, started.id, (snapshot) => {
              snapshot.source = { type: "kanban", taskId };
            });
            const created = provider.created.length;
            unavailable = true;
            await expect(service.rewindCode(started.id, build.sessionKey, C3)).rejects.toThrow(
              "has not finished",
            );
            // The workspace came back on another commit: the reset now refuses
            // for good, so the supervisor can never finish it.
            unavailable = false;
            controls.currentHead = C1;
            await service.advanceNow(started.id);
            const stuck = await pipeline(storage, started.id);
            expect(stuck.rewinds?.at(-1)?.code?.pending).toBe(true);
            expect(stuck.phase).toBe("building");
            // Pause and cancel still wait for the confirmed reset.
            await expect(service.pause(started.id)).rejects.toThrow("The branch moved");
            await expect(service.cancel(started.id)).rejects.toThrow("The branch moved");

            if (ticketState === "update-fails") controls.failCommands.add("update_kanban_task");
            const invocationCount = invocations.length;
            await service.remove(started.id);
            const task = controls.kanbanTasks.get(taskId)!;
            expect(task.status).toBe(ticketState === "update-fails" ? "review" : "backlog");
            expect(task.comments).toEqual([{ text: "Existing lifecycle comment" }]);
            expect(
              invocations
                .slice(invocationCount)
                .filter((call) => call.command === "update_kanban_task")
                .map((call) => call.args),
            ).toEqual([{ taskId, status: "backlog" }]);
            expect(
              invocations
                .slice(invocationCount)
                .some((call) => call.command === "add_kanban_comment"),
            ).toBe(false);

            expect(await storage.getBuildPipeline(started.id)).toBeNull();
            await service.advanceNow(started.id);
            expect(fake.calls.some((call) => call[0] === "reset")).toBe(false);
            expect(controls.currentHead).toBe(C1);
            expect(provider.created.length).toBe(created);
          },
          { environmentGit: git },
        );
      } finally {
        warn.mockRestore();
      }
    },
  );

  test("a delete waits for a reset already under way, then removes the pipeline as usual", async () => {
    const fake = fakeGit();
    let unavailable = false;
    let holdReset: Promise<void> | undefined;
    let resetEntered: () => void = () => undefined;
    const git: EnvironmentGit = async (id, args) => {
      if (args[0] === "update-ref") {
        if (unavailable) {
          throw new EnvironmentUnavailableError("The environment's container is not running.");
        }
        if (holdReset) {
          resetEntered();
          await holdReset;
        }
      }
      return fake.git(id, args);
    };
    const warn = spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      await withService(
        async (service, storage, _provider, _invocations, controls) => {
          fake.worktree.controls = controls;
          const { started, build } = await completedOnC3(service, storage, controls);
          unavailable = true;
          await expect(service.rewindCode(started.id, build.sessionKey, C3)).rejects.toThrow(
            "has not finished",
          );
          unavailable = false;
          let release: () => void = () => undefined;
          holdReset = new Promise((resolve) => (release = resolve));
          const entered = new Promise<void>((resolve) => (resetEntered = resolve));
          const pass = service.advanceNow(started.id);
          await entered;

          const deletePipeline = storage.deleteBuildPipeline.bind(storage);
          const deletion = spyOn(storage, "deleteBuildPipeline").mockImplementation(async (id) => {
            // Observe the persisted state before removal: waiting for the reset
            // alone is insufficient; the ordinary path must cancel first.
            const cancelled = await pipeline(storage, id);
            expect(cancelled.rewinds?.at(-1)?.code?.pending).not.toBe(true);
            expect(cancelled.phase).toBe("failed");
            expect(cancelled.error).toBe("Build cancelled");
            await deletePipeline(id);
          });
          try {
            const removal = service.remove(started.id);
            for (let turn = 0; turn < 10; turn += 1) await Promise.resolve();
            // The supervisor holds the lock mid-reset, so the record is still there.
            expect(await storage.getBuildPipeline(started.id)).not.toBeNull();

            release();
            await pass;
            await removal;
            expect(controls.currentHead).toBe(C0);
            expect(fake.calls.filter((call) => call[0] === "reset")).toHaveLength(1);
            expect(deletion).toHaveBeenCalledTimes(1);
            expect(deletion).toHaveBeenCalledWith(started.id);
            expect(await storage.getBuildPipeline(started.id)).toBeNull();
          } finally {
            release();
            deletion.mockRestore();
          }
        },
        { environmentGit: git },
      );
    } finally {
      warn.mockRestore();
    }
  });

  test("workflow closure failure happens before any Git mutation", async () => {
    const fake = fakeGit();
    await withService(
      async (service, storage, _provider, _invocations, controls) => {
        fake.worktree.controls = controls;
        const { started, build } = await completedOnC3(service, storage, controls);
        await mutateStored(storage, started.id, (snapshot) => {
          snapshot.sessions[0]!.resultTransport = "tool-v1";
          snapshot.sessions[0]!.structuredRequestId = "test-close-key";
        });
        const close = controls.workflowResults!.close.bind(controls.workflowResults);
        controls.workflowResults!.close = async () => {
          throw new Error("close failed");
        };
        await expect(service.rewindCode(started.id, build.sessionKey, C3)).rejects.toThrow(
          "close failed",
        );
        expect(fake.calls.some((call) => ["reset", "update-ref"].includes(call[0]!))).toBe(false);
        expect((await pipeline(storage, started.id)).rewinds).toBeUndefined();
        expect(controls.currentHead).toBe(C3);
        controls.workflowResults!.close = close;
        await service.rewindCode(started.id, build.sessionKey, C3);
        expect(controls.currentHead).toBe(C0);
      },
      { environmentGit: fake.git, workflowResultsWithoutTools: true },
    );
  });

  test("holds the shared reservation through backup, reset and the restart commit", async () => {
    const fake = fakeGit();
    const fence = new EnvironmentMutationFence();
    let ready!: () => void;
    let release!: () => void;
    const backedUp = new Promise<void>((resolve) => {
      ready = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const git: EnvironmentGit = async (id, args) => {
      const done = fence.beginMutation(id);
      try {
        const output = await fake.git(id, args);
        if (args[0] === "update-ref") {
          ready();
          await gate;
        }
        return output;
      } finally {
        done();
      }
    };
    let admissionChecks = 0;
    await withService(
      async (service, storage, _provider, _invocations, controls) => {
        fake.worktree.controls = controls;
        const { started, build } = await completedOnC3(service, storage, controls);
        let finalSaveChecked = false;
        storage.setBuildPipelineTranscriptFaults({
          at: async (stage) => {
            if (
              !finalSaveChecked &&
              stage === "before-control-save" &&
              fake.calls.some((args) => args[0] === "reset")
            ) {
              finalSaveChecked = true;
              // The final save still runs while the environment is reserved.
              expect(fence.isBeingMoved("env-1")).toBe(true);
            }
          },
        });
        const rewind = service.rewindCode(started.id, build.sessionKey, C3);
        try {
          await backedUp;
          expect(() => fence.beginMutation("env-1")).toThrow();
          expect(() => fence.beginAgentWork("env-1")).toThrow();
          expect(() => fence.beginWorktreeMutation("/tmp/build/new-file")).toThrow();
          expect(controls.currentHead).toBe(C3);
        } finally {
          release();
        }
        await rewind;
        expect(finalSaveChecked).toBe(true);
        expect(fence.isBeingMoved("env-1")).toBe(false);
        const admitted = admissionChecks;
        await service.rewindCode(started.id, build.sessionKey, C3);
        expect(admissionChecks).toBe(admitted); // A duplicate need not stop its own replacement.
        await expect(service.rewindCode(started.id, build.sessionKey, C2)).rejects.toThrow(
          "previous attempt",
        );
      },
      {
        environmentGit: git,
        environmentFence: fence,
        assertEnvironmentQuiescent: async () => {
          admissionChecks += 1;
        },
      },
    );
  });

  test("a sibling pipeline with a live writer prevents rewind", async () => {
    const fake = fakeGit();
    await withService(
      async (service, storage, provider, _invocations, controls) => {
        fake.worktree.controls = controls;
        const { started, build } = await completedOnC3(service, storage, controls);
        provider.runningPhases.add("build");
        await service.start(startInput({ taskId: "sibling" }));
        await expect(service.rewindCode(started.id, build.sessionKey, C3)).rejects.toThrow(
          "Another pipeline",
        );
        expect(fake.calls).toHaveLength(0);
        expect(controls.currentHead).toBe(C3);
      },
      { environmentGit: fake.git },
    );
  });

  test("a rewind that drops no pushed commits ships with a plain push", async () => {
    const fake = fakeGit();
    const worktree = fake.worktree;
    fake.clearUpstream();
    await withService(
      async (service, storage, provider, _invocations, controls) => {
        worktree.controls = controls;
        const { started, build } = await completedOnC3(service, storage, controls);
        const rewound = await service.rewindCode(started.id, build.sessionKey, C3);
        expect(rewound.rewinds!.at(-1)!.code).not.toHaveProperty("upstream");
        const finished = await advanceUntil(
          service,
          storage,
          started.id,
          (snapshot) => snapshot.phase === "complete",
        );
        const ship = finished.sessions.at(-1)!;
        const shipPrompt = provider.sent.find((entry) => entry.sessionId === ship.sdkSessionId);
        expect(shipPrompt?.prompt).toContain("Push the current branch to origin.");
        expect(shipPrompt?.prompt).not.toContain("force-with-lease");
      },
      { environmentGit: fake.git },
    );
  });

  test("refuses, changing nothing, when the branch moved since the preview", async () => {
    const fake = fakeGit();
    const worktree = fake.worktree;
    await withService(
      async (service, storage, _provider, _invocations, controls) => {
        worktree.controls = controls;
        const { started, completed, build } = await completedOnC3(service, storage, controls);
        await expect(service.rewindCode(started.id, build.sessionKey, C2)).rejects.toThrow(
          "The branch moved since the rewind was previewed",
        );
        controls.uncommittedPaths = ["src/app.ts"];
        await expect(service.rewindCode(started.id, build.sessionKey, C3)).rejects.toThrow(
          "uncommitted changes",
        );
        const after = await pipeline(storage, started.id);
        expect(after.rewinds).toBeUndefined();
        expect(after.phase).toBe("complete");
        expect(after.sessions).toHaveLength(completed.sessions.length);
        expect(fake.calls.some((call) => call[0] === "reset" || call[0] === "update-ref")).toBe(
          false,
        );
      },
      { environmentGit: fake.git },
    );
  });

  test("refuses on a merged pull request and on a running pipeline", async () => {
    const fake = fakeGit();
    const worktree = fake.worktree;
    await withService(
      async (service, storage, provider, _invocations, controls) => {
        worktree.controls = controls;
        const { started, build } = await completedOnC3(service, storage, controls);
        await storage.updateEnvironment("env-1", { prState: "merged" });
        await expect(service.rewindCode(started.id, build.sessionKey, C3)).rejects.toThrow(
          "has been merged",
        );
        expect((await service.previewCodeRewind(started.id, build.sessionKey)).blocked).toContain(
          "has been merged",
        );
        await storage.updateEnvironment("env-1", { prState: "open" });

        const second = await service.start(startInput({ taskId: "task-2" }));
        provider.runningPhases.add("build");
        await advanceUntil(
          service,
          storage,
          second.id,
          (snapshot) => snapshot.phase === "building",
        );
        const running = (await pipeline(storage, second.id)).sessions[0]!;
        await expect(service.rewindCode(second.id, running.sessionKey, C3)).rejects.toThrow(
          "Pause the pipeline first",
        );
        expect(fake.calls.some((call) => call[0] === "reset")).toBe(false);
      },
      { environmentGit: fake.git },
    );
  });
});
