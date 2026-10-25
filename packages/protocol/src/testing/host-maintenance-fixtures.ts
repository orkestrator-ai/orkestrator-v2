import type { HostMaintenanceSnapshot, HostUpdateJob } from "../host-maintenance.js";

/** A host update job for tests; override what the test is about. */
export function hostUpdateJobFixture(overrides: Partial<HostUpdateJob> = {}): HostUpdateJob {
  return {
    id: "job-1",
    state: "requested",
    fromVersion: "2.21.1",
    requestedVersion: null,
    targetVersion: null,
    drain: "now",
    idleDeadline: null,
    progressPercent: null,
    restartAt: null,
    error: null,
    requestedAt: "2026-10-16T12:00:00.000Z",
    updatedAt: "2026-10-16T12:00:00.000Z",
    completedAt: null,
    ...overrides,
  };
}

/** A host maintenance snapshot with an available desktop updater and nothing in progress. */
export function hostMaintenanceSnapshotFixture(
  overrides: Partial<HostMaintenanceSnapshot> = {},
): HostMaintenanceSnapshot {
  return {
    revision: 1,
    version: "2.21.1",
    updater: {
      kind: "desktop",
      available: true,
      reason: null,
      latestVersion: null,
      updateAvailable: null,
      checkedAt: null,
      checkError: null,
    },
    checkRequest: null,
    job: null,
    tasks: {},
    nextRelease: null,
    ghChannel: "pinned",
    updateChannel: "stable",
    ...overrides,
  };
}
