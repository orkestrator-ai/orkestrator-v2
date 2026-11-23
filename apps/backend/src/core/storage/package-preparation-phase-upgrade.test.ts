import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  BUILD_PIPELINE_VERSION,
  isBuildPipeline,
  REVIEW_PACKAGE_SESSION_LABEL,
} from "@orkestrator/protocol/build-pipeline";
import { newReviewValidationRun } from "@orkestrator/protocol/review-workflow";
import { StorageDatabase } from "./database.js";
import { openBackendDatabase, STORAGE_MIGRATIONS, storeLayout } from "./stores.js";
import { StorageService } from "./service.js";
import {
  PACKAGE_PREPARATION_PHASE_UPGRADE_VERSION,
  upgradeBuildPipelinePackagePreparation,
  upgradePackagePreparationPhase,
} from "./package-preparation-phase-upgrade.js";

const directories: string[] = [];

async function dataDir(): Promise<string> {
  const directory = await fs.mkdtemp(path.join(tmpdir(), "orkestrator-package-preparation-"));
  directories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })),
  );
});

const STARTED = "2026-11-18T00:00:00.000Z";
const PREPARATION_KEY = "pipeline-1:rework:1:preparation";

type Snapshot = Record<string, unknown> & { sessions: Array<Record<string, unknown>> };

function session(
  phase: string,
  key: string,
  label: string,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    phase,
    iteration: 1,
    sessionKey: key,
    sdkSessionId: `provider-${key}`,
    status: "idle",
    startedAt: STARTED,
    completedAt: STARTED,
    label,
    ...extra,
  };
}

/**
 * Round 2's package preparation running, as builds before 4740 task 4 stored
 * it: a Rework session under the preparation label, the pipeline `reworking`.
 */
function formerPreparation(): Snapshot {
  return {
    id: "pipeline-1",
    taskId: "task-1",
    projectId: "project-1",
    environmentId: "environment-1",
    environmentType: "local",
    agentType: "codex",
    phase: "reworking",
    sessions: [
      session("rework", "pipeline-1:rework:1:rework", "Rework Session"),
      session("rework", PREPARATION_KEY, REVIEW_PACKAGE_SESSION_LABEL, {
        status: "running",
        completedAt: undefined,
        validationPlan: true,
        interactionTranscript: [
          {
            id: "interaction-1",
            provider: "codex",
            kind: "question",
            phase: "rework",
            requestedAt: 1,
            resolvedAt: 2,
            outcome: "auto-declined-headless",
            title: "Which command?",
            questions: [],
          },
        ],
      }),
    ],
    currentSessionIndex: 1,
    iteration: 1,
    maxIterations: 3,
    createdAt: STARTED,
    taskTitle: "Retry safely",
    taskSnapshot: {
      title: "Retry safely",
      description: "rework the reworking path",
      acceptanceCriteria: "",
      comments: [],
      images: [],
    },
    backendRevision: 3,
    controller: "backend",
  };
}

function plan() {
  return { headRef: "a".repeat(40), commands: [], limitations: ["No commands available"] };
}

describe("package preparation phase upgrade", () => {
  test("moves a running preparation session and its pipeline to their own phase", () => {
    const former = formerPreparation();
    const upgraded = upgradePackagePreparationPhase(former) as Snapshot;
    expect(upgraded).toMatchObject({
      phase: "preparing-package",
      sessions: [
        { phase: "rework", label: "Rework Session" },
        {
          phase: "package-preparation",
          label: REVIEW_PACKAGE_SESSION_LABEL,
          interactionTranscript: [{ phase: "package-preparation" }],
        },
      ],
    });
    // Transcript paths hash the session key; it stays exactly as written.
    expect(upgraded.sessions.map((entry) => entry.sessionKey)).toEqual(
      former.sessions.map((entry) => entry.sessionKey),
    );
    expect(upgraded.taskSnapshot).toBe(former.taskSnapshot);
    expect(isBuildPipeline(upgraded)).toBe(true);
  });

  test("moves the phase a paused or failed preparation will resume in", () => {
    const paused = upgradePackagePreparationPhase({
      ...formerPreparation(),
      phase: "paused",
      pausedFromPhase: "reworking",
      pauseCause: "requested",
    });
    expect(paused).toMatchObject({ phase: "paused", pausedFromPhase: "preparing-package" });
    expect(isBuildPipeline(paused)).toBe(true);

    const preparation = `provider-${PREPARATION_KEY}`;
    const prompt = {
      sessionId: preparation,
      requestId: "request-1",
      prompt: "Initiate review package creation.",
      useTaskImages: false,
      validationPlan: true,
    };
    const failed = upgradePackagePreparationPhase({
      ...formerPreparation(),
      phase: "failed",
      error: "The provider went away",
      failureContext: { phase: "reworking", kind: "prompt-dispatch", sessionId: preparation },
      reconnectAttempt: {
        id: "reconnect-1",
        startedAt: STARTED,
        phase: "reworking",
        kind: "prompt-dispatch",
      },
      pendingPromptAttempt: {
        ...prompt,
        id: "attempt-1",
        dispatchVersion: 1,
        phase: "reworking",
        startedAt: STARTED,
        backgroundMessage: {
          message: { id: "message-1", text: "Use bun", createdAt: STARTED },
          context: { phase: "reworking", kind: "prompt-dispatch" },
          session: {},
        },
      },
      activePromptContext: { ...prompt, phase: "reworking", kind: "prompt-dispatch" },
      pendingInteractionResolution: {
        journalId: "journal-1",
        sessionKey: PREPARATION_KEY,
        sessionId: preparation,
        interactionId: "interaction-2",
        provider: "codex",
        kind: "question",
        phase: "rework",
        requestedAt: 1,
        claimedAt: 2,
        action: "decline-and-continue",
        title: "Which command?",
        questions: [],
      },
    });
    expect(failed).toMatchObject({
      phase: "failed",
      failureContext: { phase: "preparing-package" },
      reconnectAttempt: { phase: "preparing-package" },
      pendingPromptAttempt: {
        phase: "preparing-package",
        backgroundMessage: { context: { phase: "preparing-package" } },
      },
      activePromptContext: { phase: "preparing-package" },
      pendingInteractionResolution: { phase: "package-preparation" },
    });
    expect(isBuildPipeline(failed)).toBe(true);
  });

  test("moves a pipeline running or holding the validation its preparation planned", () => {
    // A first-round validation restart left the pipeline `building`, with the
    // current index still on the superseded preparation.
    const former = formerPreparation();
    const restarted = upgradePackagePreparationPhase({
      ...former,
      phase: "building",
      iteration: 0,
      sessions: [
        session("build", "pipeline-1:build:0:build", "Build Session", { iteration: 0 }),
        session("rework", PREPARATION_KEY, REVIEW_PACKAGE_SESSION_LABEL, {
          iteration: 0,
          supersededBy: "rewind-1",
          supersededAt: STARTED,
        }),
      ],
      validationRun: newReviewValidationRun("validation-2", plan()),
    });
    expect(restarted).toMatchObject({
      phase: "preparing-package",
      sessions: [{ phase: "build" }, { phase: "package-preparation" }],
    });
    expect(isBuildPipeline(restarted)).toBe(true);
  });

  test("leaves the pipeline phase alone when preparation is not the step it is on", () => {
    // Round 2's Rework runs; round 1's preparation is history.
    const rework = upgradePackagePreparationPhase({
      ...formerPreparation(),
      iteration: 1,
      sessions: [
        session("rework", "pipeline-1:rework:0:preparation", REVIEW_PACKAGE_SESSION_LABEL, {
          iteration: 0,
        }),
        session("rework", "pipeline-1:rework:1:rework", "Rework Session", { status: "running" }),
      ],
    });
    expect(rework).toMatchObject({
      phase: "reworking",
      sessions: [{ phase: "package-preparation" }, { phase: "rework" }],
    });
    expect(isBuildPipeline(rework)).toBe(true);

    // A Rework restart superseded the running preparation; Rework opens next.
    const former = formerPreparation();
    const restarted = upgradePackagePreparationPhase({
      ...former,
      sessions: former.sessions.map((entry) => ({
        ...entry,
        supersededBy: "rewind-1",
        supersededAt: STARTED,
      })),
      restartRequest: { kind: "session", phase: "rework" },
    });
    expect(restarted).toMatchObject({
      phase: "reworking",
      restartRequest: { kind: "session", phase: "rework" },
      sessions: [{ phase: "rework" }, { phase: "package-preparation" }],
    });

    // Reviewing a sealed package: the run is evidence, not the current step.
    const reviewing = upgradePackagePreparationPhase({
      ...formerPreparation(),
      phase: "reviewing",
      validationRun: newReviewValidationRun("validation-1", plan()),
      reviewPackage: { id: "validation-1", round: 2, targetBranch: "main" },
    });
    expect(reviewing).toMatchObject({ phase: "reviewing" });
  });

  test("leaves current records, unreadable records and unreadable stores untouched", () => {
    const current = {
      "pipeline-1": { snapshot: upgradePackagePreparationPhase(formerPreparation()) },
    };
    expect(upgradeBuildPipelinePackagePreparation(current)).toBe(current);
    const unreadable = { broken: "not a record", missing: { revision: 1 } };
    expect(upgradeBuildPipelinePackagePreparation(unreadable)).toBe(unreadable);
    expect(upgradeBuildPipelinePackagePreparation("not a store")).toBe("not a store");
  });

  test("an upgraded database is rewritten once and the backend reads it afterwards", async () => {
    const directory = await dataDir();
    const before = new StorageDatabase(directory, {
      layoutFor: storeLayout,
      migrations: STORAGE_MIGRATIONS.filter(
        (migration) => migration.version < PACKAGE_PREPARATION_PHASE_UPGRADE_VERSION,
      ),
    });
    before.writeStore("build-pipelines", {
      "pipeline-1": {
        version: BUILD_PIPELINE_VERSION,
        id: "pipeline-1",
        projectId: "project-1",
        environmentId: "environment-1",
        snapshot: formerPreparation(),
        updatedAt: STARTED,
        revision: 4,
      },
    });
    before.close();

    const upgraded = openBackendDatabase(directory);
    try {
      expect(upgraded.schemaVersion()).toBeGreaterThanOrEqual(
        PACKAGE_PREPARATION_PHASE_UPGRADE_VERSION,
      );
    } finally {
      upgraded.close();
    }

    const storage = new StorageService(directory);
    await storage.init();
    const pipeline = await storage.getBuildPipeline("pipeline-1");
    // The revision is kept: this is the same record, not a new write to it.
    expect(pipeline?.revision).toBe(4);
    expect(isBuildPipeline(pipeline?.snapshot)).toBe(true);
    expect(pipeline?.snapshot).toMatchObject({
      phase: "preparing-package",
      sessions: [
        { phase: "rework", sessionKey: "pipeline-1:rework:1:rework" },
        { phase: "package-preparation", sessionKey: PREPARATION_KEY },
      ],
    });
  });
});
