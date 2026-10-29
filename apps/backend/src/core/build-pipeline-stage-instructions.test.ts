import { describe, expect, test } from "bun:test";
import type {
  BuildPipeline,
  BuildStepConfig,
  BuildStepConfigs,
  PipelineSessionPhase,
} from "@orkestrator/protocol/build-pipeline";
import { REVIEW_PACKAGE_SESSION_LABEL } from "@orkestrator/protocol/build-pipeline";
import {
  BUILD_STEP_INSTRUCTIONS_FRAME_CLOSE,
  BUILD_STEP_INSTRUCTIONS_FRAME_OPEN,
  BUILD_STEP_INSTRUCTIONS_HEADING,
} from "@orkestrator/protocol/build-pipeline-stage-instructions";
import type { StructuredOutputResult } from "@orkestrator/protocol/structured-output";
import type { BuildPipelineService } from "./build-pipeline-service.js";
import {
  type FakeProvider,
  pipeline,
  startInput,
  withService,
} from "./build-pipeline-service-test-support.js";
import {
  advanceUntil as advanceFanoutUntil,
  reportFor,
  startInput as fanoutStartInput,
  withPipeline,
} from "./build-pipeline-review-fanout-test-support.js";
import { TEST_FIX_RESULT, TEST_REVIEW_PREPARATION } from "./build-pipeline-test-fixtures.js";
import type { StorageService } from "./storage.js";
import { UNATTENDED_POLICY_INSTRUCTION } from "./build-pipeline-service-helpers.js";

/** The rendered frame around one step's text, as a stage prompt carries it. */
function framed(text: string): string {
  return `${BUILD_STEP_INSTRUCTIONS_FRAME_OPEN}\n${text}\n${BUILD_STEP_INSTRUCTIONS_FRAME_CLOSE}`;
}

const STEP_RULES = {
  build: "BUILD-RULES: write the failing test first.",
  review: "REVIEW-RULES: look hard at error handling.",
  address: "ADDRESS-RULES: fix every nit.",
  verify: "VERIFY-RULES: check the CLI help text.",
  pr: "PR-RULES: title the pull request in English.",
  "resolve-conflicts": "RESOLVE-RULES: keep the target branch's lockfile.",
} as const;

function instructedSteps(): BuildStepConfigs {
  return Object.fromEntries(
    Object.entries(STEP_RULES).map(([key, instructions]) => [
      key,
      { agent: "claude", instructions } satisfies BuildStepConfig,
    ]),
  );
}

const ALL_RULES = Object.values(STEP_RULES);

/**
 * Review finds an issue (so Address runs), the first Verify fails (so Fix runs)
 * and every later one passes.
 */
function scriptRound(provider: FakeProvider): void {
  let verifications = 0;
  provider.structured = async <T>(
    sessionId: string,
    requestId: string,
  ): Promise<StructuredOutputResult<T>> => {
    const phase = provider.phases.get(sessionId);
    const value =
      phase === "review"
        ? reportFor("One finding.", "Inverted branch")
        : phase === "build" || phase === "fix"
          ? TEST_REVIEW_PREPARATION
          : phase === "address"
            ? TEST_FIX_RESULT
            : phase === "verify"
              ? (verifications += 1) === 1
                ? { complete: false, rationale: "The CLI help is missing." }
                : { complete: true, rationale: "All criteria pass." }
              : { complete: true, rationale: "Done." };
    return { ok: true, provider: "claude", requestId, value: value as T };
  };
}

async function advanceUntil(
  service: BuildPipelineService,
  storage: StorageService,
  id: string,
  done: (snapshot: BuildPipeline) => boolean,
): Promise<BuildPipeline> {
  for (let pass = 0; pass < 80; pass += 1) {
    const snapshot = await pipeline(storage, id);
    if (done(snapshot)) return snapshot;
    await service.advanceNow(id);
  }
  const final = await pipeline(storage, id);
  throw new Error(`The pipeline stopped at ${final.phase}: ${final.error ?? "no error"}`);
}

/** Every prompt sent to sessions of one phase, in order. */
function promptsFor(provider: FakeProvider, phase: PipelineSessionPhase): string[] {
  return provider.sent
    .filter((entry) => provider.phases.get(entry.sessionId) === phase)
    .map((entry) => entry.prompt);
}

/** The first prompt of each session of one phase: the one the stage opened with. */
function openingPromptsFor(provider: FakeProvider, phase: PipelineSessionPhase): string[] {
  const seen = new Set<string>();
  return provider.sent
    .filter((entry) => {
      if (provider.phases.get(entry.sessionId) !== phase || seen.has(entry.sessionId)) return false;
      seen.add(entry.sessionId);
      return true;
    })
    .map((entry) => entry.prompt);
}

function expectOnlyRules(prompt: string, rules: string): void {
  expect(prompt).toContain(framed(rules));
  expect(prompt.split(BUILD_STEP_INSTRUCTIONS_FRAME_OPEN)).toHaveLength(2);
  for (const other of ALL_RULES) {
    if (other !== rules) expect(prompt).not.toContain(other);
  }
}

/** Runs one whole single-reviewer pipeline: Build, Review, Address, Verify, Fix, Ship, conflicts. */
async function runWholePipeline(
  service: BuildPipelineService,
  storage: StorageService,
  provider: FakeProvider,
  controls: { detection: { hasMergeConflicts: boolean | null } | null },
  steps?: BuildStepConfigs,
): Promise<BuildPipeline> {
  scriptRound(provider);
  controls.detection!.hasMergeConflicts = true;
  const started = await service.start(startInput(steps ? { steps } : {}));
  await advanceUntil(
    service,
    storage,
    started.id,
    (snapshot) => snapshot.phase === "resolving-conflicts" || snapshot.phase === "failed",
  );
  controls.detection!.hasMergeConflicts = false;
  return advanceUntil(
    service,
    storage,
    started.id,
    (snapshot) => snapshot.phase === "complete" || snapshot.phase === "failed",
  );
}

describe("per-stage instructions in the stage prompts", () => {
  test("each stage's opening prompt carries its own step's frame, after the contract", async () => {
    await withService(async (service, storage, provider, _invocations, controls) => {
      const completed = await runWholePipeline(
        service,
        storage,
        provider,
        controls,
        instructedSteps(),
      );
      expect(completed.phase).toBe("complete");
      const phases = completed.sessions.map((session) => session.phase);
      expect(phases).toEqual([
        "build",
        "review",
        "address",
        "verify",
        "fix",
        "review",
        "address",
        "verify",
        "pr",
        "resolve-conflicts",
      ]);

      const expected: Array<[PipelineSessionPhase, string]> = [
        ["build", STEP_RULES.build],
        // Fix runs on the Build step, so it reads Build's instructions.
        ["fix", STEP_RULES.build],
        ["review", STEP_RULES.review],
        ["address", STEP_RULES.address],
        ["verify", STEP_RULES.verify],
        ["pr", STEP_RULES.pr],
        ["resolve-conflicts", STEP_RULES["resolve-conflicts"]],
      ];
      for (const [phase, rules] of expected) {
        const prompts = openingPromptsFor(provider, phase);
        expect(prompts.length).toBeGreaterThan(0);
        for (const prompt of prompts) {
          expectOnlyRules(prompt, rules);
          const section = prompt.indexOf(`**${BUILD_STEP_INSTRUCTIONS_HEADING}**`);
          // After the stage's own contract; only the session-wide unattended
          // policy follows it.
          expect(section).toBeGreaterThan(0);
          expect(prompt.slice(section)).toContain(UNATTENDED_POLICY_INSTRUCTION);
          expect(prompt.slice(section + 1)).not.toContain("Do not ask questions");
        }
      }
      // Address keeps its system contract, and the frame comes after it.
      const address = openingPromptsFor(provider, "address")[0]!;
      expect(address.indexOf("Report your work in the fix result you submit")).toBeLessThan(
        address.indexOf(BUILD_STEP_INSTRUCTIONS_FRAME_OPEN),
      );
      // Verify keeps its output contract before the frame.
      const verify = openingPromptsFor(provider, "verify")[0]!;
      expect(verify.indexOf("matching the provider-enforced schema")).toBeLessThan(
        verify.indexOf(BUILD_STEP_INSTRUCTIONS_FRAME_OPEN),
      );
    });
  });

  test("a pipeline without instructions renders no frame anywhere", async () => {
    await withService(async (service, storage, provider, _invocations, controls) => {
      const completed = await runWholePipeline(service, storage, provider, controls, {
        build: { agent: "claude", instructions: "   " },
        verify: { agent: "claude" },
      });
      expect(completed.phase).toBe("complete");
      // Blank text is not stored.
      expect(completed.steps?.build).toEqual({ agent: "claude" });
      expect(provider.sent.length).toBeGreaterThan(8);
      for (const { prompt } of provider.sent) {
        expect(prompt).not.toContain(BUILD_STEP_INSTRUCTIONS_HEADING);
        expect(prompt).not.toContain(BUILD_STEP_INSTRUCTIONS_FRAME_OPEN);
      }
    });
  });

  test("the record keeps the trimmed instructions", async () => {
    await withService(async (service) => {
      const started = await service.start(
        startInput({
          steps: { build: { agent: "claude", instructions: "\n  Use small commits.  \n" } },
          reviewers: [
            { agent: "claude", instructions: " Security. " },
            { agent: "claude", instructions: "" },
          ],
          reviewPreparation: { agent: "claude", instructions: " Merge duplicates. " },
        }),
      );
      expect(started.steps?.build?.instructions).toBe("Use small commits.");
      expect(started.reviewers).toEqual([
        { agent: "claude", instructions: "Security." },
        { agent: "claude" },
      ]);
      expect(started.reviewPreparation?.instructions).toBe("Merge duplicates.");
    });
  });

  test("the backend refuses a start whose instructions are over 16 KiB", async () => {
    await withService(async (service) => {
      await expect(
        service.start(
          startInput({
            steps: { verify: { agent: "claude", instructions: "é".repeat(8 * 1024 + 1) } },
          }),
        ),
      ).rejects.toThrow("Invalid build pipeline start request");
    });
  });
});

describe("restarts and rewinds reuse the stored instructions", () => {
  test("restarting Verify and rewinding to Build render the same frames again", async () => {
    await withService(async (service, storage, provider, _invocations, controls) => {
      const completed = await runWholePipeline(
        service,
        storage,
        provider,
        controls,
        instructedSteps(),
      );
      expect(completed.phase).toBe("complete");
      const verify = completed.sessions.findLast((session) => session.phase === "verify")!;
      const verifyPrompts = promptsFor(provider, "verify").length;
      controls.detection!.hasMergeConflicts = false;
      await service.restartStep(completed.id, verify.sessionKey);
      await advanceUntil(
        service,
        storage,
        completed.id,
        () => promptsFor(provider, "verify").length > verifyPrompts,
      );
      const restartedVerify = openingPromptsFor(provider, "verify").at(-1)!;
      expectOnlyRules(restartedVerify, STEP_RULES.verify);

      await advanceUntil(
        service,
        storage,
        completed.id,
        (snapshot) => snapshot.phase === "complete" || snapshot.phase === "failed",
      );
      const build = completed.sessions.find((session) => session.phase === "build")!;
      const buildPrompts = openingPromptsFor(provider, "build").length;
      const rewound = await service.restartStep(completed.id, build.sessionKey);
      expect(rewound.rewinds?.length).toBe(2);
      expect(rewound.steps).toEqual(completed.steps);
      await advanceUntil(
        service,
        storage,
        completed.id,
        () => openingPromptsFor(provider, "build").length > buildPrompts,
      );
      expectOnlyRules(openingPromptsFor(provider, "build").at(-1)!, STEP_RULES.build);
    });
  });
});

describe("the review panel and its preparation", () => {
  test("each reviewer reads its own instructions and preparation reads the preparation step's", async () => {
    await withPipeline(async ({ service, createService, provider, read }) => {
      const started = await service.start({
        ...fanoutStartInput([
          { agent: "claude", model: "opus" },
          { agent: "claude", model: "sonnet" },
        ]),
        steps: {
          build: { agent: "claude", instructions: STEP_RULES.build },
          address: { agent: "claude", instructions: STEP_RULES.address },
        },
        reviewers: [
          { agent: "claude", model: "opus", instructions: "REVIEWER-1-RULES: security." },
          { agent: "claude", model: "sonnet", instructions: "REVIEWER-2-RULES: performance." },
        ],
        reviewPreparation: { agent: "claude", instructions: "PREP-RULES: merge duplicates." },
      });
      // A fresh service is the backend after a restart: it reads the record.
      const restarted = createService();
      try {
        const addressing = await advanceFanoutUntil(restarted, read, started.id, "addressing");
        expect(addressing.phase).toBe("addressing");
      } finally {
        await restarted.shutdown();
      }
      const openings = new Map<string, string>();
      for (const entry of provider.sent) {
        if (!openings.has(entry.sessionId)) openings.set(entry.sessionId, entry.prompt);
      }
      const bySession = (prefix: string) =>
        [...openings].filter(([id]) => id.startsWith(prefix)).map(([, prompt]) => prompt);

      const reviewerOne = bySession("review-1-");
      const reviewerTwo = bySession("review-2-");
      expect(reviewerOne).toHaveLength(1);
      expect(reviewerTwo).toHaveLength(1);
      expect(reviewerOne[0]).toContain(framed("REVIEWER-1-RULES: security."));
      expect(reviewerOne[0]).not.toContain("REVIEWER-2-RULES");
      expect(reviewerTwo[0]).toContain(framed("REVIEWER-2-RULES: performance."));
      expect(reviewerTwo[0]).not.toContain("REVIEWER-1-RULES");
      // The frame is the reviewer's last text, so the shared prefix is intact.
      expect(reviewerOne[0]!.trimEnd().endsWith(BUILD_STEP_INSTRUCTIONS_FRAME_CLOSE)).toBe(true);

      const consolidation = bySession("review-·-consolidation-");
      expect(consolidation).toHaveLength(1);
      expect(consolidation[0]).toContain(framed("PREP-RULES: merge duplicates."));
      expect(consolidation[0]).not.toContain("REVIEWER-1-RULES");

      const preparation = bySession(
        `${REVIEW_PACKAGE_SESSION_LABEL.replace(/\s+/g, "-").toLowerCase()}-`,
      );
      expect(preparation).toHaveLength(1);
      expect(preparation[0]).toContain(framed("PREP-RULES: merge duplicates."));
      expect(preparation[0]).not.toContain(STEP_RULES.build);

      const build = bySession("build-session-");
      expect(build).toHaveLength(1);
      expect(build[0]).toContain(framed(STEP_RULES.build));
      expect(build[0]).not.toContain("PREP-RULES");

      const address = bySession("address-issues-session-");
      expect(address).toHaveLength(1);
      expect(address[0]).toContain(framed(STEP_RULES.address));
    });
  });

  test("a panel without instructions renders no frame", async () => {
    await withPipeline(async ({ service, provider, read }) => {
      const started = await service.start(
        fanoutStartInput([
          { agent: "claude", model: "opus" },
          { agent: "claude", model: "sonnet" },
        ]),
      );
      const addressing = await advanceFanoutUntil(service, read, started.id, "addressing");
      expect(addressing.phase).toBe("addressing");
      expect(provider.sent.length).toBeGreaterThan(4);
      for (const { prompt } of provider.sent) {
        expect(prompt).not.toContain(BUILD_STEP_INSTRUCTIONS_FRAME_OPEN);
      }
    });
  });
});
