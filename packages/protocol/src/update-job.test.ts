import { describe, expect, test } from "bun:test";
import {
  advanceUpdateJobTo,
  allowedUpdateTransitions,
  InvalidUpdateTransition,
  transitionUpdateJob,
  type UpdateJobEvent,
} from "./update-job.js";
import { UPDATE_JOB_PHASES, type UpdateJob, type UpdateJobPhase } from "./updates.js";

const AT = "2026-10-15T00:00:00.000Z";
const ERROR = { step: "download" as const, code: "network", message: "offline" };

function job(phase: UpdateJobPhase): UpdateJob {
  return {
    id: "job-1",
    fromVersion: "2.21.0",
    target: {
      version: "2.22.0",
      tag: "v2.22.0",
      channel: "stable",
      requirementsSha256: "a".repeat(64),
    },
    approvedConsentIds: [],
    restartPolicy: "immediate",
    downgrade: false,
    phase,
    createdAt: AT,
    updatedAt: AT,
    requester: {
      listener: "internal",
      remoteAddress: null,
      tailscaleUser: null,
      identitySource: "local",
      client: null,
    },
    progress: null,
    error: null,
    rollbackFailed: false,
    actionsOnHost: [],
    storageSchemaVersion: 3,
    installWhen: null,
    dependencies: null,
  };
}

const EVENTS: UpdateJobEvent[] = [
  { type: "fetch-dependencies" },
  { type: "download" },
  { type: "ready" },
  { type: "install" },
  { type: "restarting" },
  { type: "verify" },
  { type: "succeed" },
  { type: "fail", error: ERROR },
  { type: "fail", error: ERROR, rollbackFailed: true },
  { type: "roll-back", error: ERROR },
  { type: "cancel" },
];

describe("update job transitions", () => {
  test("the happy path walks every phase in order", () => {
    let current = job("approved");
    const phases: UpdateJobPhase[] = [];
    for (const type of [
      "fetch-dependencies",
      "download",
      "ready",
      "install",
      "restarting",
      "verify",
      "succeed",
    ] as const) {
      current = transitionUpdateJob(current, { type }, AT);
      phases.push(current.phase);
    }
    expect(phases).toEqual([
      "fetching-dependencies",
      "downloading",
      "ready",
      "installing",
      "restarting",
      "verifying",
      "succeeded",
    ]);
  });

  test.each(UPDATE_JOB_PHASES.map((phase) => [phase]))(
    "every event from %s either follows a declared edge or throws",
    (phase) => {
      const allowed = new Set(allowedUpdateTransitions(phase));
      for (const event of EVENTS) {
        let next: UpdateJob | null = null;
        try {
          next = transitionUpdateJob(job(phase), event, AT);
        } catch (error) {
          expect(error).toBeInstanceOf(InvalidUpdateTransition);
          continue;
        }
        expect(allowed.has(next.phase)).toBe(true);
      }
    },
  );

  test("before installing a failure is plain failed and cancel is allowed", () => {
    for (const phase of ["approved", "fetching-dependencies", "downloading", "ready"] as const) {
      expect(transitionUpdateJob(job(phase), { type: "fail", error: ERROR }, AT)).toMatchObject({
        phase: "failed",
        error: ERROR,
        rollbackFailed: false,
      });
      expect(transitionUpdateJob(job(phase), { type: "cancel" }, AT).phase).toBe("cancelled");
      expect(() =>
        transitionUpdateJob(job(phase), { type: "roll-back", error: ERROR }, AT),
      ).toThrow(InvalidUpdateTransition);
    }
  });

  test("from installing on a failure must report its rollback", () => {
    for (const phase of ["installing", "restarting", "verifying"] as const) {
      expect(() => transitionUpdateJob(job(phase), { type: "fail", error: ERROR }, AT)).toThrow(
        InvalidUpdateTransition,
      );
      expect(transitionUpdateJob(job(phase), { type: "roll-back", error: ERROR }, AT).phase).toBe(
        "rolled-back",
      );
      expect(
        transitionUpdateJob(job(phase), { type: "fail", error: ERROR, rollbackFailed: true }, AT),
      ).toMatchObject({ phase: "failed", rollbackFailed: true });
      expect(() => transitionUpdateJob(job(phase), { type: "cancel" }, AT)).toThrow(
        InvalidUpdateTransition,
      );
    }
  });

  test("terminal phases accept nothing", () => {
    for (const phase of ["succeeded", "failed", "rolled-back", "cancelled"] as const) {
      expect(allowedUpdateTransitions(phase)).toEqual([]);
      for (const event of EVENTS) {
        expect(() => transitionUpdateJob(job(phase), event, AT)).toThrow(InvalidUpdateTransition);
      }
      expect(() =>
        transitionUpdateJob(
          job(phase),
          { type: "progress", step: "download", percent: 1, message: null },
          AT,
        ),
      ).toThrow(InvalidUpdateTransition);
    }
  });

  test("progress clamps the percentage and keeps the phase", () => {
    const next = transitionUpdateJob(
      job("downloading"),
      { type: "progress", step: "download", percent: 140.4, message: "Downloading" },
      AT,
    );
    expect(next).toMatchObject({
      phase: "downloading",
      progress: { step: "download", percent: 100, message: "Downloading" },
    });
  });

  test("advancing walks the intermediate edges a restart skipped", () => {
    expect(advanceUpdateJobTo(job("ready"), "verifying", AT).phase).toBe("verifying");
    expect(advanceUpdateJobTo(job("installing"), "verifying", AT).phase).toBe("verifying");
    expect(advanceUpdateJobTo(job("verifying"), "verifying", AT).phase).toBe("verifying");
    expect(() => advanceUpdateJobTo(job("downloading"), "verifying", AT)).toThrow(
      InvalidUpdateTransition,
    );
  });
});
