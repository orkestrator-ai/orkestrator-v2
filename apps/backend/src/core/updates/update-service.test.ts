import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ReleaseChannel } from "@orkestrator/protocol/release-channels";
import type { ReleaseRequirements } from "@orkestrator/protocol/release-requirements";
import {
  UPDATE_HOST_REQUEST_EVENT,
  UPDATE_STATUS_EVENT,
  type UpdateHostRegistration,
  type UpdateHostRequest,
  type UpdateRequester,
  type UpdateStatusSnapshot,
} from "@orkestrator/protocol/updates";
import { UpdateFeedError } from "./update-feed.js";
import { UpdateFiles } from "./update-files.js";
import {
  INITIAL_CHECK_DELAY_MS,
  OUTCOME_WAIT_MS,
  PREPARE_STALL_MS,
  UpdateService,
  type UpdateDependencies,
} from "./update-service.js";
import {
  createFakeFeed,
  createFakeTimers,
  flush,
  manifestFor,
  type FakeFeed,
} from "./update-test-support.js";

const REQUESTER: UpdateRequester = {
  listener: "browser",
  remoteAddress: "127.0.0.1",
  tailscaleUser: "alice@example.com",
  identitySource: "tailscale-serve",
  client: { kind: "desktop", version: "2.21.0", name: "alice-mbp" },
};

const DESKTOP_HOST: UpdateHostRegistration = {
  hostKind: "desktop",
  protocolVersion: 1,
  hostVersion: "2.21.0",
  installKind: "mac-app",
  capabilities: { install: true, rollback: false, restart: ["now", "on-quit"] },
};

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

type Harness = {
  service: UpdateService;
  feed: FakeFeed;
  timers: ReturnType<typeof createFakeTimers>;
  events: Array<{ event: string; payload: unknown }>;
  hostRequests(): UpdateHostRequest[];
  dataDir: string;
  channel: { value: unknown };
};

async function harness(
  options: {
    currentVersion?: string;
    channel?: ReleaseChannel;
    own?: ReleaseRequirements | null;
    dataDir?: string;
    feed?: FakeFeed;
    automaticChecks?: boolean;
    disabledReason?: string | null;
    dependencies?: UpdateDependencies;
    schema?: number;
  } = {},
): Promise<Harness> {
  const dataDir =
    options.dataDir ??
    (() => {
      const directory = mkdtempSync(path.join(os.tmpdir(), "update-service-"));
      directories.push(directory);
      return directory;
    })();
  const feed = options.feed ?? createFakeFeed();
  const timers = createFakeTimers();
  const events: Harness["events"] = [];
  const channel = { value: options.channel ?? ("stable" as unknown) };
  const currentVersion = options.currentVersion ?? "2.21.0";
  let sequence = 0;
  const service = new UpdateService({
    dataDir,
    currentVersion,
    platform: "darwin",
    arch: "arm64",
    feed,
    emit: (event, payload) => events.push({ event, payload }),
    readOwnRequirements: () =>
      options.own === undefined ? manifestFor(currentVersion) : options.own,
    readChannel: async () => channel.value,
    writeChannel: async (next) => {
      channel.value = next;
    },
    storageSchemaVersion: () => options.schema ?? 3,
    automaticChecks: options.automaticChecks ?? false,
    disabledReason: options.disabledReason ?? null,
    dependencies: options.dependencies,
    files: new UpdateFiles(dataDir),
    now: () => new Date("2026-10-15T12:00:00.000Z"),
    randomId: () => `id-${++sequence}`,
    timers: timers.timers,
    log: { info: () => undefined, warn: () => undefined },
  });
  await service.start();
  return {
    service,
    feed,
    timers,
    events,
    dataDir,
    channel,
    hostRequests: () =>
      events
        .filter((entry) => entry.event === UPDATE_HOST_REQUEST_EVENT)
        .map((entry) => (entry.payload as { request: UpdateHostRequest }).request),
  };
}

async function availableUpdate(
  h: Harness,
  version = "2.22.0",
  overrides: Partial<ReleaseRequirements> = {},
) {
  await h.feed.publish(manifestFor(version, overrides));
  return h.service.check();
}

function startArgs(snapshot: UpdateStatusSnapshot, approved: string[] = []) {
  const offer = snapshot.available!;
  return {
    targetVersion: offer.version,
    requirementsSha256: offer.requirementsSha256,
    approvedConsentIds: approved,
    restartPolicy: "immediate" as const,
  };
}

describe("checking", () => {
  test("offers a newer release with its requirements diff and compatibility floors", async () => {
    const h = await harness();
    const snapshot = await availableUpdate(h, "2.22.0", {
      network: {
        egressHosts: [
          { host: "github.com", purposes: ["updates"] },
          { host: "api.example.com", purposes: ["toolchain"] },
        ],
      },
    });
    expect(snapshot.check).toMatchObject({ status: "ok", resolution: "update" });
    expect(snapshot.available).toMatchObject({
      version: "2.22.0",
      tag: "v2.22.0",
      channel: "stable",
      downgrade: false,
      compatibility: { minClientVersion: "2.20.0", minBackendVersion: "2.20.0" },
    });
    expect(snapshot.available?.diff.items.map((item) => [item.id, item.consent])).toEqual([
      ["network-egress:api.example.com", true],
    ]);
    expect(h.events.at(-1)?.event).toBe(UPDATE_STATUS_EVENT);
  });

  test("reports up to date, and a failure keeps the last offer", async () => {
    const h = await harness();
    await availableUpdate(h);
    h.feed.failIndexWith = new UpdateFeedError("channel-index-unavailable", "Not found");
    const failed = await h.service.check();
    expect(failed.check).toMatchObject({
      status: "failed",
      error: { code: "channel-index-unavailable" },
    });
    expect(failed.available?.version).toBe("2.22.0");
    const current = await harness({ currentVersion: "2.22.0" });
    await current.feed.publish(manifestFor("2.22.0"));
    expect((await current.service.check()).check.resolution).toBe("up-to-date");
  });

  test("joins a check in flight", async () => {
    const h = await harness();
    await h.feed.publish(manifestFor("2.22.0"));
    await Promise.all([h.service.check(), h.service.check()]);
    expect(h.feed.indexFetches).toBe(1);
  });

  test("a narrower channel waits and offers an explicit downgrade with the storage floor", async () => {
    const h = await harness({ currentVersion: "2.22.0-beta.2", channel: "stable", schema: 4 });
    await h.feed.publish(manifestFor("2.21.0"));
    const snapshot = await h.service.check();
    expect(snapshot.check.resolution).toBe("waiting-for-channel");
    expect(snapshot.available).toBeNull();
    expect(snapshot.downgradeOption).toMatchObject({ version: "2.21.0", downgrade: true });
    // The database is newer than 2.21.0 reads, so installing it is blocked.
    expect(snapshot.downgradeOption?.diff.items[0]).toMatchObject({
      id: "storage-migration:floor-3",
      blocking: true,
    });
  });

  test("changing the channel persists it, audits it and checks again", async () => {
    const h = await harness();
    await h.feed.publish(manifestFor("2.22.0-beta.1"));
    expect((await h.service.check()).available).toBeNull();
    const snapshot = await h.service.setChannel("beta", REQUESTER);
    expect(h.channel.value).toBe("beta");
    expect(snapshot.channel).toBe("beta");
    expect(snapshot.available?.version).toBe("2.22.0-beta.1");
    expect(h.service.auditLog(10)[0]).toMatchObject({
      action: "set-channel",
      channel: "beta",
      requester: { tailscaleUser: "alice@example.com" },
    });
    await expect(h.service.setChannel("nightly", REQUESTER)).rejects.toThrow(
      "UpdateError:invalid-request",
    );
  });

  test("automatic checks run after the startup delay and only when enabled", async () => {
    const h = await harness({ automaticChecks: true });
    await h.feed.publish(manifestFor("2.22.0"));
    h.timers.advance(INITIAL_CHECK_DELAY_MS - 1);
    expect(h.feed.indexFetches).toBe(0);
    h.timers.advance(1);
    await flush();
    expect(h.feed.indexFetches).toBe(1);
    const off = await harness({ automaticChecks: false });
    expect(off.timers.pendingCount()).toBe(0);
  });
});

describe("starting an update", () => {
  test("refuses without an installer, with the reason", async () => {
    const h = await harness();
    const snapshot = await availableUpdate(h);
    expect(snapshot.host).toMatchObject({ kind: "none", canInstall: false });
    await expect(h.service.startJob(startArgs(snapshot), REQUESTER)).rejects.toThrow(
      "UpdateError:no-host",
    );
    const disabled = await harness({ disabledReason: "Updates are off" });
    disabled.service.registerHost(DESKTOP_HOST);
    await expect(disabled.service.startJob(startArgs(snapshot), REQUESTER)).rejects.toThrow(
      "UpdateError:updates-disabled",
    );
  });

  test("binds consent to the exact manifest and every consent item", async () => {
    const h = await harness();
    h.service.registerHost(DESKTOP_HOST);
    const snapshot = await availableUpdate(h, "2.22.0", {
      network: {
        egressHosts: [
          { host: "github.com", purposes: ["updates"] },
          { host: "api.example.com", purposes: ["toolchain"] },
        ],
      },
    });
    await expect(h.service.startJob(startArgs(snapshot), REQUESTER)).rejects.toThrow(
      "UpdateError:consent-missing: Not approved: network-egress:api.example.com",
    );
    await expect(
      h.service.startJob({ ...startArgs(snapshot), requirementsSha256: "b".repeat(64) }, REQUESTER),
    ).rejects.toThrow("UpdateError:stale-target");
    const started = await h.service.startJob(
      startArgs(snapshot, ["network-egress:api.example.com"]),
      REQUESTER,
    );
    expect(started.job).toMatchObject({
      approvedConsentIds: ["network-egress:api.example.com"],
      target: { version: "2.22.0", requirementsSha256: snapshot.available!.requirementsSha256 },
    });
  });

  test("an offer this backend no longer holds is re-checked before refusing", async () => {
    const h = await harness();
    const first = await availableUpdate(h, "2.22.0");
    await h.feed.publish(manifestFor("2.22.1"));
    // A restarted backend has no cached offer; the client still shows 2.22.0.
    const restarted = await harness({ dataDir: h.dataDir, feed: h.feed });
    restarted.service.registerHost(DESKTOP_HOST);
    await expect(restarted.service.startJob(startArgs(first), REQUESTER)).rejects.toThrow(
      "stale-target",
    );
    expect(restarted.service.snapshot().available?.version).toBe("2.22.1");
  });

  test("refuses a client older than the target's floor", async () => {
    const h = await harness();
    h.service.registerHost(DESKTOP_HOST);
    const snapshot = await availableUpdate(h, "2.22.0", {
      compatibility: { updateProtocol: 1, minClientVersion: "2.22.0", minBackendVersion: "2.21.0" },
    });
    await expect(
      h.service.startJob(
        { ...startArgs(snapshot), client: { kind: "desktop", version: "2.21.0", name: null } },
        REQUESTER,
      ),
    ).rejects.toThrow("UpdateError:blocked: Update this app first");
  });

  test("only one job at a time", async () => {
    const h = await harness();
    h.service.registerHost(DESKTOP_HOST);
    const snapshot = await availableUpdate(h);
    await h.service.startJob(startArgs(snapshot), REQUESTER);
    await expect(h.service.startJob(startArgs(snapshot), REQUESTER)).rejects.toThrow(
      "UpdateError:job-in-progress",
    );
  });
});

async function hostSession(h: Harness, registration = DESKTOP_HOST) {
  return h.service.registerHost(registration).hostSessionId;
}

function report(
  h: Harness,
  session: string,
  request: UpdateHostRequest,
  status: "progress" | "succeeded" | "failed",
  extra = {},
) {
  h.service.hostReport({
    hostSessionId: session,
    requestId: request.requestId,
    jobId: request.jobId,
    status,
    ...extra,
  });
}

describe("running a job", () => {
  test("prefetches dependencies, has the host download, then installs immediately", async () => {
    const prefetched: string[] = [];
    const h = await harness({
      dependencies: {
        prefetch: async (manifest, _job, progress) => {
          progress(50, "Downloading provider binaries");
          prefetched.push(manifest.version);
        },
      },
    });
    const session = await hostSession(h);
    const snapshot = await availableUpdate(h);
    await h.service.startJob(startArgs(snapshot), REQUESTER);
    await flush();
    expect(prefetched).toEqual(["2.22.0"]);
    const [prepare] = h.hostRequests();
    expect(prepare).toMatchObject({
      kind: "prepare",
      target: { version: "2.22.0", tag: "v2.22.0" },
      feedBaseUrl: h.feed.baseUrl,
      allowDowngrade: false,
    });
    expect(h.service.snapshot().job?.phase).toBe("downloading");
    report(h, session, prepare!, "progress", { progress: { percent: 40, message: "Downloading" } });
    expect(h.service.snapshot().job?.progress).toEqual({
      step: "download",
      percent: 40,
      message: "Downloading",
    });
    report(h, session, prepare!, "succeeded");
    await flush();
    const install = h.hostRequests()[1]!;
    expect(install).toMatchObject({
      kind: "install",
      restart: "now",
      fromVersion: "2.21.0",
      storageSchemaVersion: 3,
    });
    expect(h.service.snapshot().job?.phase).toBe("installing");
    report(h, session, install, "progress", { progress: { percent: null, message: "restarting" } });
    expect(h.service.snapshot().job?.phase).toBe("restarting");
    expect(h.service.auditLog(10).map((entry) => entry.action)).toEqual(["install", "start"]);
  });

  test("the new version's host reports the outcome; notices list what needs doing at the machine", async () => {
    const h = await harness();
    const session = await hostSession(h);
    const snapshot = await availableUpdate(h, "2.22.0", {
      permissions: {
        macos: [
          {
            id: "downloads",
            label: "Downloads folder",
            settingsPane: "files-and-folders",
            infoPlistKey: "NSDownloadsFolderUsageDescription",
            usage: "Agents work in Downloads.",
            requirement: "required",
          },
        ],
      },
    });
    await h.service.startJob(startArgs(snapshot, ["macos-permission:downloads"]), REQUESTER);
    await flush();
    report(h, session, h.hostRequests()[0]!, "succeeded");
    await flush();
    const install = h.hostRequests()[1]!;
    report(h, session, install, "progress", { progress: { percent: null, message: "restarting" } });
    report(h, session, install, "succeeded");
    h.service.stop();

    // The restarted app: same data directory, the new version.
    const restarted = await harness({ dataDir: h.dataDir, currentVersion: "2.22.0" });
    expect(restarted.service.snapshot().job?.phase).toBe("restarting");
    const newSession = await hostSession(restarted);
    const result = restarted.service.hostOutcome({
      hostSessionId: newSession,
      jobId: install.jobId,
      outcome: "succeeded",
    });
    expect(result.job?.phase).toBe("succeeded");
    expect(result.notices.map((notice) => notice.kind)).toEqual([
      "update-succeeded",
      "action-needed-on-host",
    ]);
    expect(result.notices[1]?.items.map((item) => item.id)).toEqual(["macos-permission:downloads"]);
    const audit = restarted.service.auditLog(10);
    expect(audit[0]).toMatchObject({
      action: "succeeded",
      fromVersion: "2.21.0",
      toVersion: "2.22.0",
    });
    expect(audit.at(-1)).toMatchObject({
      action: "start",
      approvedConsentIds: ["macos-permission:downloads"],
      requester: {
        listener: "browser",
        tailscaleUser: "alice@example.com",
        client: { name: "alice-mbp" },
      },
    });
    // Acknowledged notices go away.
    const acknowledged = restarted.service.acknowledgeNotice(result.notices[0]!.id);
    expect(acknowledged.notices.map((notice) => notice.kind)).toEqual(["action-needed-on-host"]);
  });

  test("a rollback reported after the restart leaves the job rolled back", async () => {
    const h = await harness();
    const session = await hostSession(h, {
      ...DESKTOP_HOST,
      hostKind: "supervisor",
      installKind: "npm-package",
    });
    await h.service.startJob(startArgs(await availableUpdate(h)), REQUESTER);
    await flush();
    report(h, session, h.hostRequests()[0]!, "succeeded");
    await flush();
    const install = h.hostRequests()[1]!;
    report(h, session, install, "progress", { progress: { percent: null, message: "restarting" } });
    h.service.stop();
    const restored = await harness({ dataDir: h.dataDir, currentVersion: "2.21.0" });
    const result = restored.service.hostOutcome({
      hostSessionId: await hostSession(restored),
      jobId: install.jobId,
      outcome: "rolled-back",
      error: { code: "health-check", message: "no readiness line within 120 s" },
    });
    expect(result.job).toMatchObject({
      phase: "rolled-back",
      error: { code: "health-check" },
      rollbackFailed: false,
    });
    expect(result.notices[0]?.kind).toBe("update-rolled-back");
  });

  test("a download failure fails the job before anything changed", async () => {
    const h = await harness();
    const session = await hostSession(h);
    await h.service.startJob(startArgs(await availableUpdate(h)), REQUESTER);
    await flush();
    report(h, session, h.hostRequests()[0]!, "failed", {
      error: { code: "sha512-mismatch", message: "sha512 checksum mismatch" },
    });
    await flush();
    expect(h.service.snapshot().job).toMatchObject({
      phase: "failed",
      error: { step: "download", code: "host-failed" },
    });
    expect(h.service.snapshot().job?.error?.message).toContain("sha512-mismatch");
    expect(h.service.snapshot().notices[0]?.message).toContain("nothing was changed");
  });

  test("a dependency failure fails the job before the host is asked for anything", async () => {
    const h = await harness({
      dependencies: {
        prefetch: async () => {
          throw new Error("claude archive sha256 mismatch");
        },
      },
    });
    await hostSession(h);
    await h.service.startJob(startArgs(await availableUpdate(h)), REQUESTER);
    await flush();
    expect(h.service.snapshot().job).toMatchObject({
      phase: "failed",
      error: { step: "dependencies" },
    });
    expect(h.hostRequests()).toEqual([]);
  });

  test("a stalled download times out", async () => {
    const h = await harness();
    await hostSession(h);
    await h.service.startJob(startArgs(await availableUpdate(h)), REQUESTER);
    await flush();
    h.timers.advance(PREPARE_STALL_MS);
    await flush();
    expect(h.service.snapshot().job).toMatchObject({
      phase: "failed",
      error: { code: "host-timeout" },
    });
  });

  test("an installer that fails before restarting is a rollback with nothing to undo", async () => {
    const h = await harness();
    const session = await hostSession(h);
    await h.service.startJob(startArgs(await availableUpdate(h)), REQUESTER);
    await flush();
    report(h, session, h.hostRequests()[0]!, "succeeded");
    await flush();
    report(h, session, h.hostRequests()[1]!, "failed", {
      error: { code: "staging-failed", message: "Squirrel" },
    });
    await flush();
    expect(h.service.snapshot().job).toMatchObject({
      phase: "rolled-back",
      error: { step: "install" },
    });
  });

  test("manual restart waits in ready; install now and install on quit", async () => {
    const h = await harness();
    const session = await hostSession(h);
    const snapshot = await availableUpdate(h);
    await h.service.startJob({ ...startArgs(snapshot), restartPolicy: "manual" }, REQUESTER);
    await flush();
    report(h, session, h.hostRequests()[0]!, "succeeded");
    await flush();
    const job = h.service.snapshot().job!;
    expect(job.phase).toBe("ready");
    expect(h.hostRequests()).toHaveLength(1);
    await expect(h.service.installNow("other", REQUESTER)).rejects.toThrow("UpdateError:no-job");
    const armed = h.service.installOnQuit(job.id, REQUESTER);
    await flush();
    const install = h.hostRequests()[1]!;
    expect(install).toMatchObject({ kind: "install", restart: "on-quit" });
    report(h, session, install, "succeeded");
    await armed;
    expect(h.service.snapshot().job).toMatchObject({ phase: "ready", installWhen: "on-quit" });
    h.service.stop();
    // The user quits; the app installs and comes back as the new version.
    const restarted = await harness({ dataDir: h.dataDir, currentVersion: "2.22.0" });
    expect(restarted.service.snapshot().job?.phase).toBe("ready");
    const result = restarted.service.hostOutcome({
      hostSessionId: await hostSession(restarted),
      jobId: job.id,
      outcome: "succeeded",
    });
    expect(result.job?.phase).toBe("succeeded");
  });

  test("cancelling before install tells the host and ends the job", async () => {
    const h = await harness();
    await hostSession(h);
    await h.service.startJob(startArgs(await availableUpdate(h)), REQUESTER);
    await flush();
    const job = h.service.snapshot().job!;
    const snapshot = await h.service.cancel(job.id, REQUESTER);
    expect(snapshot.job?.phase).toBe("cancelled");
    expect(h.hostRequests().at(-1)).toMatchObject({ kind: "cancel", jobId: job.id });
    expect(h.service.auditLog(5).map((entry) => entry.action)).toEqual([
      "cancelled",
      "cancel",
      "start",
    ]);
    await expect(h.service.cancel(job.id, REQUESTER)).rejects.toThrow("not-cancellable");
  });
});

describe("recovering after a restart", () => {
  async function interruptedAt(phase: "downloading" | "restarting") {
    const h = await harness();
    const session = await hostSession(h);
    await h.service.startJob(startArgs(await availableUpdate(h)), REQUESTER);
    await flush();
    if (phase === "restarting") {
      report(h, session, h.hostRequests()[0]!, "succeeded");
      await flush();
      report(h, session, h.hostRequests()[1]!, "progress", {
        progress: { percent: null, message: "restarting" },
      });
    }
    h.service.stop();
    return h;
  }

  test("a job interrupted before it was ready failed, and changed nothing", async () => {
    const h = await interruptedAt("downloading");
    const restarted = await harness({ dataDir: h.dataDir });
    expect(restarted.service.snapshot().job).toMatchObject({
      phase: "failed",
      error: { code: "interrupted" },
    });
  });

  test("with no outcome reported, the running version decides", async () => {
    const h = await interruptedAt("restarting");
    const updated = await harness({ dataDir: h.dataDir, currentVersion: "2.22.0" });
    updated.timers.advance(OUTCOME_WAIT_MS);
    expect(updated.service.snapshot().job?.phase).toBe("succeeded");

    const again = await interruptedAt("restarting");
    const stillOld = await harness({ dataDir: again.dataDir, currentVersion: "2.21.0" });
    stillOld.timers.advance(OUTCOME_WAIT_MS);
    expect(stillOld.service.snapshot().job).toMatchObject({
      phase: "rolled-back",
      error: { code: "install-not-applied" },
    });
  });
});

describe("host protocol", () => {
  test("a re-registered host receives outstanding requests and stale sessions are refused", async () => {
    const h = await harness();
    const first = await hostSession(h);
    await h.service.startJob(startArgs(await availableUpdate(h)), REQUESTER);
    await flush();
    const reply = h.service.registerHost(DESKTOP_HOST);
    expect(reply.pending.map((request) => request.kind)).toEqual(["prepare"]);
    expect(() => report(h, first, reply.pending[0]!, "succeeded")).toThrow("register again");
    report(h, reply.hostSessionId, reply.pending[0]!, "succeeded");
    await flush();
    expect(h.service.snapshot().job?.phase).toBe("installing");
  });

  test("the status payload summarises version, host and update", async () => {
    const h = await harness();
    await hostSession(h);
    await availableUpdate(h);
    expect(h.service.gatewayStatus()).toEqual({
      ok: true,
      appVersion: "2.21.0",
      updateProtocol: 1,
      host: { kind: "desktop", installKind: "mac-app", canInstall: true },
      updates: { channel: "stable", available: "2.22.0", jobPhase: null },
    });
  });
});
