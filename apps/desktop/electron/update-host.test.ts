import { afterEach, describe, expect, mock, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { NATIVE_EVENT_STREAM_CONNECTED_EVENT } from "@orkestrator/protocol/gateway-event-stream";
import type { UpdateHostRequest } from "@orkestrator/protocol/updates";
import type { UpdaterLike, UpdateCheckResult } from "./auto-update.js";
import { createDesktopUpdateHost, readPendingInstallMarker } from "./update-host.js";

const BASE = "https://github.com/orkestrator-ai/orkestrator-v2/releases/download";
const TARGET = {
  version: "2.22.0",
  tag: "v2.22.0",
  channel: "stable" as const,
  requirementsSha256: "a".repeat(64),
};

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function fakeUpdater(
  options: { offered?: string | null; downloadError?: Error; stageError?: Error } = {},
) {
  const listeners = new Map<string, Set<(arg: never) => void>>();
  const updater = {
    autoDownload: true,
    autoInstallOnAppQuit: true,
    allowDowngrade: true,
    feeds: [] as unknown[],
    /** `autoInstallOnAppQuit` at each download: set, a completed download stages the update. */
    downloads: [] as boolean[],
    on(event: string, listener: (arg: never) => void) {
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event)!.add(listener);
      return updater;
    },
    off(event: string, listener: (arg: never) => void) {
      listeners.get(event)?.delete(listener);
      return updater;
    },
    setFeedURL(feed: unknown) {
      updater.feeds.push(feed);
    },
    checkForUpdates: mock(async (): Promise<UpdateCheckResult | null> => {
      const offered = options.offered === undefined ? TARGET.version : options.offered;
      return offered
        ? { isUpdateAvailable: true, updateInfo: { version: offered } }
        : { isUpdateAvailable: false };
    }),
    downloadUpdate: mock(async () => {
      updater.downloads.push(updater.autoInstallOnAppQuit);
      if (updater.autoInstallOnAppQuit && options.stageError) throw options.stageError;
      for (const percent of [10, 60, 100]) {
        for (const listener of listeners.get("download-progress") ?? [])
          listener({ percent } as never);
      }
      if (options.downloadError) throw options.downloadError;
      return [];
    }),
    quitAndInstall: mock((_silent?: boolean, _run?: boolean) => undefined),
    emit(event: string, arg: unknown) {
      for (const listener of listeners.get(event) ?? []) listener(arg as never);
    },
    listenerCount: (event: string) => listeners.get(event)?.size ?? 0,
  };
  return updater;
}

function setup(
  options: {
    updater?: ReturnType<typeof fakeUpdater> | null;
    appVersion?: string;
    pending?: UpdateHostRequest[];
    /** What the nth registration's reply lists; overrides `pending`. */
    pendingFor?: (registration: number) => UpdateHostRequest[];
    /** Final reports to fail before delivering, as a replaced session would. */
    failFinalReports?: number;
    markerFile?: string;
    keepRollbackCopy?: () => Promise<string>;
    discardRollbackCopy?: () => Promise<void>;
  } = {},
) {
  let failFinalReports = options.failFinalReports ?? 0;
  const directory = mkdtempSync(path.join(os.tmpdir(), "update-host-"));
  directories.push(directory);
  const markerFile = options.markerFile ?? path.join(directory, "updates", "pending-install.json");
  const calls: Array<{ command: string; args: Record<string, unknown> }> = [];
  let session = 0;
  const invoke = mock(async (command: string, args: Record<string, unknown>) => {
    calls.push({ command, args });
    if (command === "update_host_register") {
      session += 1;
      const pending = options.pendingFor?.(session) ?? options.pending ?? [];
      return { hostSessionId: `session-${session}`, pending } as never;
    }
    if (command === "update_host_report" && args.status !== "progress" && failFinalReports > 0) {
      failFinalReports -= 1;
      throw new Error("UpdateError:host-session-expired: register again");
    }
    return { ok: true } as never;
  });
  const updater = options.updater === undefined ? fakeUpdater() : options.updater;
  let clock = 0;
  const host = createDesktopUpdateHost({
    updater: updater as unknown as UpdaterLike | null,
    unavailableReason: updater ? null : "Development and test builds do not update themselves.",
    installKind: "mac-app",
    appVersion: options.appVersion ?? "2.21.0",
    invoke,
    createCancellationToken: () => ({ cancel: mock(() => undefined) }),
    markerFile,
    allowedFeedBaseUrls: [BASE],
    log: { info: () => undefined, warn: () => undefined },
    progressIntervalMs: 1_000,
    keepRollbackCopy: options.keepRollbackCopy,
    discardRollbackCopy: options.discardRollbackCopy,
    now: () => (clock += 600),
  });
  const reports = () =>
    calls.filter((call) => call.command === "update_host_report").map((call) => call.args);
  return { host, updater, calls, reports, invoke, markerFile, directory };
}

const prepare = (
  overrides: Partial<Extract<UpdateHostRequest, { kind: "prepare" }>> = {},
): UpdateHostRequest => ({
  kind: "prepare",
  requestId: "req-prepare",
  jobId: "job-1",
  target: TARGET,
  feedBaseUrl: BASE,
  allowDowngrade: false,
  ...overrides,
});

const install = (restart: "now" | "on-quit" = "now"): UpdateHostRequest => ({
  kind: "install",
  requestId: `req-install-${restart}`,
  jobId: "job-1",
  target: TARGET,
  fromVersion: "2.21.0",
  restart,
  storageSchemaVersion: 3,
  toolchainBinDir: null,
});

async function deliver(
  h: ReturnType<typeof setup>,
  request: UpdateHostRequest,
  session = "session-1",
) {
  h.host.handleBackendEvent("update-host-request", { hostSessionId: session, request });
  await new Promise((resolve) => setTimeout(resolve, 10));
}

describe("registering", () => {
  test("registers as a desktop host that can install now or on quit, and turns automatic download off", async () => {
    const h = setup();
    expect(h.updater).toMatchObject({
      autoDownload: false,
      autoInstallOnAppQuit: false,
      allowDowngrade: false,
    });
    await h.host.register();
    expect(h.calls[0]).toEqual({
      command: "update_host_register",
      args: {
        registration: {
          hostKind: "desktop",
          protocolVersion: 1,
          hostVersion: "2.21.0",
          installKind: "mac-app",
          capabilities: { install: true, rollback: false, restart: ["now", "on-quit"] },
          unavailableReason: null,
          armedJobId: null,
        },
      },
    });
  });

  test("an install that cannot update itself registers with the reason", async () => {
    const h = setup({ updater: null });
    await h.host.register();
    expect(h.calls[0]?.args).toMatchObject({
      registration: {
        capabilities: { install: false },
        unavailableReason: expect.stringContaining("Development"),
      },
    });
  });

  test("acts on pending requests from the reply and re-registers after a reconnect", async () => {
    const h = setup({ pending: [prepare()] });
    await h.host.register();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(h.updater!.downloadUpdate).toHaveBeenCalledTimes(1);
    h.host.handleBackendEvent(NATIVE_EVENT_STREAM_CONNECTED_EVENT, undefined);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(h.calls.filter((call) => call.command === "update_host_register")).toHaveLength(2);
    // The same request delivered again is not run twice.
    expect(h.updater!.downloadUpdate).toHaveBeenCalledTimes(1);
  });

  test("a final report that did not arrive is sent again while the backend still lists it", async () => {
    const h = setup({
      pendingFor: (registration) => (registration === 1 ? [] : [prepare()]),
      failFinalReports: 1,
    });
    await h.host.register();
    await deliver(h, prepare());
    await new Promise((resolve) => setTimeout(resolve, 20));
    const finals = h.reports().filter((report) => report.status === "succeeded");
    expect(finals.map((report) => report.hostSessionId)).toEqual(["session-1", "session-2"]);
    // Re-sent, not re-run.
    expect(h.updater!.downloadUpdate).toHaveBeenCalledTimes(1);
  });

  test("a final report for a request the backend no longer lists is dropped", async () => {
    const h = setup({ failFinalReports: 1 });
    await h.host.register();
    await deliver(h, prepare());
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(h.calls.filter((call) => call.command === "update_host_register")).toHaveLength(2);
    expect(h.reports().filter((report) => report.status === "succeeded")).toHaveLength(1);
  });

  test("ignores requests for another host session", async () => {
    const h = setup();
    await h.host.register();
    await deliver(h, prepare(), "session-other");
    expect(h.updater!.checkForUpdates).not.toHaveBeenCalled();
  });
});

describe("preparing", () => {
  test("pins the updater to the resolved release, forwards throttled progress and reports success", async () => {
    const h = setup();
    await h.host.register();
    await deliver(h, prepare());
    expect(h.updater!.feeds).toEqual([
      {
        provider: "generic",
        url: `${BASE}/v2.22.0`,
        channel: "latest",
        useMultipleRangeRequest: false,
      },
    ]);
    const reports = h.reports();
    expect(reports.at(-1)).toMatchObject({
      status: "succeeded",
      requestId: "req-prepare",
      hostSessionId: "session-1",
    });
    const progress = reports.filter((report) => report.status === "progress");
    expect(progress.length).toBeGreaterThan(0);
    expect(progress.length).toBeLessThan(3);
    expect(h.updater!.allowDowngrade).toBe(false);
    expect(h.updater!.listenerCount("download-progress")).toBe(0);
  });

  test("refuses a release the feed does not offer, an untrusted feed, and a failed download", async () => {
    const mismatch = setup({ updater: fakeUpdater({ offered: "2.22.1" }) });
    await mismatch.host.register();
    await deliver(mismatch, prepare());
    expect(mismatch.reports().at(-1)).toMatchObject({
      status: "failed",
      error: { code: "feed-mismatch" },
    });
    expect(mismatch.updater!.downloadUpdate).not.toHaveBeenCalled();

    const untrusted = setup();
    await untrusted.host.register();
    await deliver(untrusted, prepare({ feedBaseUrl: "https://evil.example/releases" }));
    expect(untrusted.reports().at(-1)).toMatchObject({
      status: "failed",
      error: { code: "untrusted-feed" },
    });

    const broken = setup({
      updater: fakeUpdater({ downloadError: new Error("sha512 checksum mismatch") }),
    });
    await broken.host.register();
    await deliver(broken, prepare());
    expect(broken.reports().at(-1)).toMatchObject({
      status: "failed",
      error: { message: "sha512 checksum mismatch" },
    });
  });

  test("allows a downgrade only for the request that asked for one", async () => {
    const h = setup();
    await h.host.register();
    let during = false;
    h.updater!.checkForUpdates.mockImplementation(async () => {
      during = h.updater!.allowDowngrade;
      return { isUpdateAvailable: true, updateInfo: { version: TARGET.version } };
    });
    await deliver(h, prepare({ allowDowngrade: true }));
    expect(during).toBe(true);
    expect(h.updater!.allowDowngrade).toBe(false);
  });
});

describe("installing", () => {
  test("records the pending install, says it is restarting, then quits and installs", async () => {
    const h = setup();
    await h.host.register();
    await deliver(h, install("now"));
    expect(await readPendingInstallMarker(h.markerFile)).toMatchObject({
      jobId: "job-1",
      fromVersion: "2.21.0",
      toVersion: "2.22.0",
      mode: "now",
    });
    expect(
      h
        .reports()
        .map((report) => [
          report.status,
          (report.progress as { message?: string } | undefined)?.message,
        ]),
    ).toEqual([
      ["progress", "restarting"],
      ["succeeded", undefined],
    ]);
    expect(h.updater!.quitAndInstall).toHaveBeenCalledWith(true, true);
  });

  test("an updater error after quitAndInstall reports the install failed and clears the marker", async () => {
    const h = setup();
    await h.host.register();
    await deliver(h, install("now"));
    h.updater!.emit("error", new Error("EACCES: cannot replace the AppImage"));
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(h.calls.at(-1)).toEqual({
      command: "update_host_outcome",
      args: {
        hostSessionId: "session-1",
        jobId: "job-1",
        outcome: "failed",
        rollbackFailed: false,
        error: { code: "install-failed", message: "EACCES: cannot replace the AppImage" },
      },
    });
    expect(existsSync(h.markerFile)).toBe(false);
  });

  test("install on quit stages the downloaded update with the flag set, without restarting", async () => {
    const h = setup();
    await h.host.register();
    await deliver(h, prepare());
    await deliver(h, install("on-quit"));
    // electron-updater stages (macOS) or adds its quit handler (AppImage)
    // only for a download that completes with the flag set.
    expect(h.updater!.downloads).toEqual([false, true]);
    expect(h.updater!.autoInstallOnAppQuit).toBe(true);
    expect(h.updater!.quitAndInstall).not.toHaveBeenCalled();
    expect(h.reports().at(-1)).toMatchObject({ status: "succeeded" });
    expect((await readPendingInstallMarker(h.markerFile))?.mode).toBe("on-quit");
    await h.host.register();
    expect(h.calls.at(-1)?.args).toMatchObject({ registration: { armedJobId: "job-1" } });
  });

  test("install on quit that cannot stage fails and stays disarmed", async () => {
    const h = setup({ updater: fakeUpdater({ stageError: new Error("code signature invalid") }) });
    await h.host.register();
    await deliver(h, install("on-quit"));
    expect(h.reports().at(-1)).toMatchObject({
      status: "failed",
      error: { message: "code signature invalid" },
    });
    expect(h.updater!.autoInstallOnAppQuit).toBe(false);
    expect(existsSync(h.markerFile)).toBe(false);
  });

  test("a staging error after arming on quit reports the install failed", async () => {
    const h = setup();
    await h.host.register();
    await deliver(h, install("on-quit"));
    h.updater!.emit("error", new Error("Squirrel could not verify the update"));
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(h.calls.at(-1)).toMatchObject({
      command: "update_host_outcome",
      args: { outcome: "failed", error: { code: "install-failed" } },
    });
    expect(h.updater!.autoInstallOnAppQuit).toBe(false);
  });

  test("a staging error reported by the updater refuses the install", async () => {
    const h = setup();
    await h.host.register();
    h.updater!.emit("error", new Error("Squirrel could not stage the update"));
    await deliver(h, install("now"));
    expect(h.reports().at(-1)).toMatchObject({
      status: "failed",
      error: { code: "staging-failed" },
    });
    expect(h.updater!.quitAndInstall).not.toHaveBeenCalled();
  });

  test("cancel disarms install on quit and forgets the pending install", async () => {
    const h = setup();
    await h.host.register();
    await deliver(h, install("on-quit"));
    await deliver(h, { kind: "cancel", requestId: "req-cancel", jobId: "job-1" });
    expect(h.updater!.autoInstallOnAppQuit).toBe(false);
    expect(existsSync(h.markerFile)).toBe(false);
  });
});

describe("after a restart", () => {
  function writeMarker(file: string, toVersion: string) {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(
      file,
      JSON.stringify({
        version: 1,
        jobId: "job-1",
        fromVersion: "2.21.0",
        toVersion,
        mode: "now",
        createdAt: "x",
      }),
    );
  }

  test("the new version reports success, clears the marker and deletes the rollback copy", async () => {
    const discardRollbackCopy = mock(async () => undefined);
    const h = setup({ appVersion: "2.22.0", discardRollbackCopy });
    writeMarker(h.markerFile, "2.22.0");
    await h.host.register();
    await h.host.reportStartupOutcome();
    expect(h.calls.at(-1)).toEqual({
      command: "update_host_outcome",
      args: { hostSessionId: "session-1", jobId: "job-1", outcome: "succeeded" },
    });
    expect(existsSync(h.markerFile)).toBe(false);
    expect(discardRollbackCopy).toHaveBeenCalledTimes(1);
    // Without a pending install there is nothing to report or delete.
    await h.host.reportStartupOutcome();
    expect(discardRollbackCopy).toHaveBeenCalledTimes(1);
  });

  test("still the old version means the install did not apply", async () => {
    const h = setup({ appVersion: "2.21.0" });
    writeMarker(h.markerFile, "2.22.0");
    await h.host.register();
    await h.host.reportStartupOutcome();
    expect(h.calls.at(-1)?.args).toMatchObject({
      outcome: "failed",
      rollbackFailed: false,
      error: { code: "install-not-applied" },
    });
  });

  test("no marker, no report; a damaged marker is ignored", async () => {
    const h = setup();
    await h.host.register();
    await h.host.reportStartupOutcome();
    mkdirSync(path.dirname(h.markerFile), { recursive: true });
    writeFileSync(h.markerFile, "{not json");
    await h.host.reportStartupOutcome();
    expect(h.calls.map((call) => call.command)).toEqual(["update_host_register"]);
    expect(readFileSync(h.markerFile, "utf8")).toBe("{not json");
  });
});

describe("rollback copies", () => {
  test("keeps a copy before install and records it for a failed start to restore", async () => {
    const keepRollbackCopy = mock(async () => "/data/updates/rollback/2.21.0/Orkestrator AI.app");
    const h = setup({ keepRollbackCopy });
    await h.host.register();
    expect(h.calls[0]?.args).toMatchObject({ registration: { capabilities: { rollback: true } } });
    await deliver(h, prepare());
    expect(keepRollbackCopy).toHaveBeenCalledTimes(1);
    expect(h.reports().at(-1)).toMatchObject({ status: "succeeded" });
    await deliver(h, install("now"));
    expect((await readPendingInstallMarker(h.markerFile))?.rollbackPath).toBe(
      "/data/updates/rollback/2.21.0/Orkestrator AI.app",
    );
  });

  test("a copy that cannot be made fails the download, before anything is installed", async () => {
    const h = setup({
      keepRollbackCopy: async () => {
        throw new Error("ENOSPC: no space left on device");
      },
    });
    await h.host.register();
    await deliver(h, prepare());
    expect(h.reports().at(-1)).toMatchObject({
      status: "failed",
      error: { code: "rollback-copy-failed" },
    });
  });

  test("the restored version reports the rollback the failed one performed", async () => {
    const h = setup({ appVersion: "2.21.0" });
    mkdirSync(path.dirname(h.markerFile), { recursive: true });
    writeFileSync(
      h.markerFile,
      JSON.stringify({
        version: 1,
        jobId: "job-1",
        fromVersion: "2.21.0",
        toVersion: "2.22.0",
        mode: "now",
        createdAt: "x",
        rollbackPath: "/r",
        rolledBack: { reason: "2.22.0 failed to start: Backend service exited during startup" },
      }),
    );
    await h.host.register();
    await h.host.reportStartupOutcome();
    expect(h.calls.at(-1)?.args).toMatchObject({
      outcome: "rolled-back",
      error: { code: "health-check", message: expect.stringContaining("failed to start") },
    });
    expect(existsSync(h.markerFile)).toBe(false);
  });
});

test("cancelled prepare drains before replacement changes the updater", async () => {
  const updater = fakeUpdater();
  let finishFirst!: (value: never[]) => void;
  let finishSecond!: (value: never[]) => void;
  updater.downloadUpdate.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finishFirst = resolve;
      }),
  );
  updater.downloadUpdate.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finishSecond = resolve;
      }),
  );
  const h = setup({ updater });
  await h.host.register();
  await deliver(h, prepare());
  expect(updater.checkForUpdates).toHaveBeenCalledTimes(1);
  await deliver(h, { kind: "cancel", requestId: "cancel-first", jobId: "job-1" });
  await deliver(h, prepare({ jobId: "job-2", requestId: "prepare-second", allowDowngrade: true }));
  expect(updater.checkForUpdates).toHaveBeenCalledTimes(1);
  finishFirst([]);
  await new Promise((resolve) => setTimeout(resolve, 10));
  expect(updater.checkForUpdates).toHaveBeenCalledTimes(2);
  expect(updater.allowDowngrade).toBe(true);
  expect(updater.listenerCount("download-progress")).toBe(1);
  expect(
    h
      .reports()
      .some(
        (entry) =>
          entry.jobId === "job-1" &&
          entry.status === "succeeded" &&
          entry.requestId === "req-prepare",
      ),
  ).toBe(false);
  finishSecond([]);
  await new Promise((resolve) => setTimeout(resolve, 10));
  expect(h.reports()).toContainEqual(
    expect.objectContaining({ jobId: "job-2", status: "succeeded" }),
  );
  expect(updater.listenerCount("download-progress")).toBe(0);
});

test("real electron-updater generic feed verifies, stages, swaps and rolls back a disposable AppImage", async () => {
  const { createRequire } = await import("node:module");
  const { createHash } = await import("node:crypto");
  const { keepRollbackCopy, rollBackFailedUpdate } = await import("./update-rollback.js");
  const require = createRequire(import.meta.url);
  const { AppImageUpdater } = require("electron-updater") as typeof import("electron-updater");
  // Use the installed builder's Node transport; Electron's net transport is
  // exercised by the Electron smoke suite. No updater logic is replaced.
  const builderRequire = createRequire(require.resolve("electron-builder"));
  const { NodeHttpExecutor } = builderRequire("builder-util/out/nodeHttpExecutor");
  const updaterRequire = createRequire(require.resolve("electron-updater"));
  const { ElectronHttpExecutor } = updaterRequire("./electronHttpExecutor");
  const executor = new ElectronHttpExecutor();
  const nodeExecutor = new NodeHttpExecutor();
  executor.createRequest = nodeExecutor.createRequest.bind(nodeExecutor);
  const directory = mkdtempSync(path.join(os.tmpdir(), "real-appimage-update-"));
  directories.push(directory);
  const appImage = path.join(directory, "Fixture.AppImage");
  const oldBytes = "#!/bin/sh\n# previous version\nexit 0\n";
  const newBytes = "#!/bin/sh\n# replacement version\nexit 0\n";
  writeFileSync(appImage, oldBytes, { mode: 0o755 });
  const sha512 = createHash("sha512").update(newBytes).digest("base64");
  let artifactDownloads = 0;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const url = new URL(request.url);
      if (url.pathname.endsWith(".yml"))
        return new Response(
          `version: 2.22.0\nfiles:\n  - url: Fixture.AppImage\n    sha512: ${sha512}\n    size: ${Buffer.byteLength(newBytes)}\npath: Fixture.AppImage\nsha512: ${sha512}\nreleaseDate: '2026-10-15T12:00:00Z'\n`,
        );
      if (url.pathname.endsWith("Fixture.AppImage")) {
        artifactDownloads += 1;
        return new Response(newBytes);
      }
      return new Response("missing", { status: 404 });
    },
  });
  const base = `http://127.0.0.1:${server.port}/feed`;
  const config = path.join(directory, "app-update.yml");
  writeFileSync(config, `provider: generic\nurl: ${base}\nupdaterCacheDirName: fixture-updater\n`);
  const quitHandlers: Array<(code: number) => void> = [];
  const updater = new AppImageUpdater(null, {
    version: "2.21.0",
    name: "fixture",
    isPackaged: true,
    appUpdateConfigPath: config,
    userDataPath: directory,
    baseCachePath: directory,
    whenReady: async () => undefined,
    quit: () => undefined,
    relaunch: () => undefined,
    onQuit: (handler: (code: number) => void) => quitHandlers.push(handler),
  });
  Object.assign(updater, { httpExecutor: executor, _testOnlyOptions: { platform: "linux" } });
  updater.disableDifferentialDownload = true;
  updater.logger = {
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
    debug: () => undefined,
  };
  const previousAppImage = process.env.APPIMAGE;
  process.env.APPIMAGE = appImage;
  const reports: Array<Record<string, unknown>> = [];
  const markerFile = path.join(directory, "updates", "pending-install.json");
  const host = createDesktopUpdateHost({
    updater: updater as unknown as UpdaterLike,
    unavailableReason: null,
    installKind: "appimage",
    appVersion: "2.21.0",
    markerFile,
    allowedFeedBaseUrls: [base],
    log: { info: () => undefined, warn: () => undefined },
    keepRollbackCopy: () =>
      keepRollbackCopy({
        app: { kind: "appimage", path: appImage },
        version: "2.21.0",
        rollbackRoot: path.join(directory, "rollback"),
      }),
    async invoke<T>(command: string, args: Record<string, unknown>): Promise<T> {
      if (command === "update_host_register")
        return { hostSessionId: "real-updater", pending: [] } as T;
      if (command === "update_host_report") reports.push(args);
      return { ok: true } as T;
    },
  });
  const waitForReport = async (requestId: string) => {
    for (let attempt = 0; attempt < 300; attempt += 1) {
      const report = reports.find(
        (entry) => entry.requestId === requestId && entry.status !== "progress",
      );
      if (report) {
        expect(report).toMatchObject({ status: "succeeded" });
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error("real updater did not settle");
  };
  try {
    await host.register();
    host.handleBackendEvent("update-host-request", {
      hostSessionId: "real-updater",
      request: prepare({ feedBaseUrl: base }),
    });
    await waitForReport("req-prepare");
    expect(artifactDownloads).toBe(1);
    expect(readFileSync(appImage, "utf8")).toBe(oldBytes);
    host.handleBackendEvent("update-host-request", {
      hostSessionId: "real-updater",
      request: install("on-quit"),
    });
    await waitForReport("req-install-on-quit");
    expect(artifactDownloads).toBe(1); // Cached download still arms the real quit handler.
    expect(quitHandlers).toHaveLength(1);
    quitHandlers[0]!(0);
    expect(readFileSync(appImage, "utf8")).toBe(newBytes);
    const result = await rollBackFailedUpdate({
      marker: await readPendingInstallMarker(markerFile),
      appVersion: "2.22.0",
      firstLaunch: true,
      app: { kind: "appimage", path: appImage },
      dataDir: directory,
      now: Date.now(),
    });
    expect(result.rolledBack).toBe(true);
    expect(readFileSync(appImage, "utf8")).toBe(oldBytes);
  } finally {
    server.stop(true);
    if (previousAppImage === undefined) delete process.env.APPIMAGE;
    else process.env.APPIMAGE = previousAppImage;
  }
}, 10_000);
