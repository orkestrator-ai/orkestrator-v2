/**
 * Real-Docker qualification of preserving-rebuild faults (C15): the Docker
 * daemon disappearing while the copy runs, and the backend process killed
 * immediately before and immediately after the commit write.
 *
 * Opt-in exactly like container-live-replacement.test.ts:
 * RUN_LIVE_DOCKER_TESTS=1 and ORKESTRATOR_QUALIFICATION_IMAGE=<image>. Each
 * scenario has its own private data directory (the SQLite storage service and
 * registry writer lease a backend uses) and so its own owner label; `afterAll`
 * removes exactly the resources carrying those owner labels.
 *
 * Fault injection stays in test fixtures:
 * - Disconnect: the backend's Docker CLI calls are pointed through
 *   `DOCKER_HOST` at a unix-socket proxy in front of the real socket
 *   (container-live-rebuild-fixtures.ts). Severing it destroys every open
 *   connection and removes the socket file, as when a daemon goes away; the
 *   real daemon is never restarted.
 * - Kill: the rebuild runs in a child Bun process
 *   (container-live-rebuild-kill-driver.ts) that parks inside its own storage
 *   wrapper at the commit write and is SIGKILLed by PID; a fresh storage
 *   service and writer lease over the same directory then run the backend's
 *   startup reconciliation.
 *
 * Scenario ids refer to the matrix in
 * docs/development/container-qualification.md.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseContainerLifecycle } from "@orkestrator/protocol/container-lifecycle";
import type { Subprocess } from "bun";
import { dockerOwnerNamespace } from "../src/core/docker-ownership";
import { waitForContainerBoot } from "../src/core/container-readiness";
import { reconcileContainerOperations } from "../src/core/container-lifecycle-service";
import type { Environment } from "../src/core/models";
import { openRegistryWriter, type RegistryWriter } from "../src/core/registry-writer-lease";
import { StorageService } from "../src/core/storage";
import { readStoredValue } from "../src/core/storage-test-support";
import { lifecycleEnvironment } from "./container-lifecycle-fixtures";
import { startRuntime } from "./container-live-start";
import {
  QUALIFICATION_PROJECT,
  durableLifecycleContext,
  realDocker,
  realDockerEndpoint,
  startDockerApiProxy,
  withDockerHost,
  type DockerApiProxy,
} from "./container-live-rebuild-fixtures";
import type { KillDriverConfig, KillDriverEvent } from "./container-live-rebuild-kill-driver";
import {
  STATE_SNAPSHOT,
  WORKSPACE_SNAPSHOT,
  exec,
  populateLegacyRuntime,
  sqliteSnapshot,
} from "./container-live-workspace";

const IMAGE = process.env.ORKESTRATOR_QUALIFICATION_IMAGE?.trim() ?? "";
const ENABLED = process.env.RUN_LIVE_DOCKER_TESTS === "1" && IMAGE.length > 0;
const live = ENABLED ? test : test.skip;
const RUN = `f${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
/** Generous: the qualification host may be heavily loaded. */
const LIVE_TIMEOUT_MS = 1_500_000;
/** Short writer-lease staleness so the takeover after a kill is quick. */
const LEASE_STALE_MS = 10_000;
const DRIVER = path.join(import.meta.dir, "container-live-rebuild-kill-driver.ts");
const BACKEND_DIR = path.resolve(import.meta.dir, "..");
const MiB = 1024 * 1024;

const dataDirs: string[] = [];
const proxies: DockerApiProxy[] = [];
let endpoint = "";

/** Every check the test itself makes goes to the real daemon. */
async function docker(args: string[], timeoutMs = 120_000): Promise<string> {
  return realDocker(endpoint, args, timeoutMs);
}

async function dockerList(args: string[]): Promise<string[]> {
  return (await docker(args)).split("\n").filter(Boolean).sort();
}

/**
 * Prints one scenario observation and, when ORKESTRATOR_QUALIFICATION_EVIDENCE
 * names a file, appends it there as a JSON line (a logged run deletes passing
 * output). Observations carry no workspace contents.
 */
async function evidence(scenario: string, fields: Record<string, unknown>): Promise<void> {
  const line = JSON.stringify({ run: RUN, scenario, at: new Date().toISOString(), ...fields });
  console.log(`[rebuild-faults] ${line}`);
  const file = process.env.ORKESTRATOR_QUALIFICATION_EVIDENCE;
  if (file) await fs.appendFile(file, `${line}\n`);
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

beforeAll(async () => {
  if (!ENABLED) return;
  endpoint = await realDockerEndpoint();
});

afterAll(async () => {
  if (!ENABLED) return;
  for (const proxy of proxies) await proxy.close();
  const leftovers: string[] = [];
  for (const dataDir of dataDirs) {
    const filter = `label=orkestrator-owner=${dockerOwnerNamespace(dataDir)}`;
    // One resource per call: a multi-argument removal intermittently answered
    // "404 page not found" on Docker Desktop 4.95 under load.
    for (const [list, remove] of [
      [
        ["ps", "-aq", "--filter", filter],
        ["rm", "-f"],
      ],
      [
        ["volume", "ls", "-q", "--filter", filter],
        ["volume", "rm"],
      ],
      [
        ["network", "ls", "-q", "--filter", filter],
        ["network", "rm"],
      ],
    ] as const) {
      for (const id of await dockerList([...list]).catch(() => [])) {
        await docker([...remove, id]).catch(() => undefined);
      }
      leftovers.push(...(await dockerList([...list]).catch(() => [`unlisted ${list[0]}`])));
    }
    await fs.rm(dataDir, { recursive: true, force: true });
  }
  expect(leftovers).toEqual([]);
}, 300_000);

function lifecycleOf(environment: Environment | null) {
  const parsed = parseContainerLifecycle(environment?.containerLifecycle);
  if (!parsed.supported) throw new Error("unsupported lifecycle record");
  return parsed.record;
}

interface LiveEnvironment {
  dataDir: string;
  owner: string;
  storage: StorageService;
  writer: RegistryWriter;
  context: ReturnType<typeof durableLifecycleContext>;
  /** Called with every persisted operation phase. */
  phases: Set<(phase: string, operationId: string) => void>;
  environmentId: string;
  containerId: string;
  close(): Promise<void>;
}

/**
 * A legacy environment in its own data directory, owned by a storage service
 * and writer lease exactly as a backend holds them.
 */
async function createLegacyEnvironment(label: string, bigFileMiB = 0): Promise<LiveEnvironment> {
  const { createDockerContainer } = await import("../src/core/commands-containers");
  const { resolveDockerImage } = await import("../src/core/docker-image");
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "ork-rebuild-faults-"));
  dataDirs.push(dataDir);
  const owner = dockerOwnerNamespace(dataDir);
  const storage = new StorageService(dataDir);
  await storage.init();
  await storage.addProject({ ...QUALIFICATION_PROJECT });
  const writer = await openRegistryWriter(dataDir, { staleMs: LEASE_STALE_MS });
  expect(writer.isHeld()).toBe(true);
  const phases = new Set<(phase: string, operationId: string) => void>();
  const context = durableLifecycleContext(storage, writer, IMAGE, (_event, payload) => {
    const operation = (
      payload as { snapshot?: { operation?: { operationId: string; phase: string } } }
    )?.snapshot?.operation;
    if (operation) for (const listener of phases) listener(operation.phase, operation.operationId);
  });
  const environment = lifecycleEnvironment({
    id: `env-${RUN}-${label}`,
    networkAccessMode: "full",
  });
  await storage.addEnvironment(environment);
  const resolved = await resolveDockerImage(IMAGE);
  if (resolved.kind !== "present") throw new Error("qualification image missing");
  // A legacy runtime: no storage set, the workspace lives in the writable layer.
  const containerId = await createDockerContainer(environment, context, {
    imageId: resolved.imageId,
    runtimeGeneration: 1,
  });
  await startRuntime(containerId);
  await waitForContainerBoot(containerId);
  await storage.updateEnvironment(environment.id, {
    containerId,
    status: "running",
    containerLifecycle: {
      schemaVersion: 1,
      revision: 1,
      lastRuntimeGeneration: 1,
      runtime: {
        containerId,
        runtimeGeneration: 1,
        owner,
        imageRef: IMAGE,
        imageId: resolved.imageId,
      },
      storage: { format: "legacy-layer", workspaceGeneration: 1 },
      outcomes: [],
    },
  });
  await populateLegacyRuntime(containerId);
  if (bigFileMiB > 0) {
    // Long enough a copy that a fault lands inside it, not around it.
    await exec(containerId, `head -c ${bigFileMiB * MiB} /dev/urandom > /workspace/big.bin`);
  }
  return {
    dataDir,
    owner,
    storage,
    writer,
    context,
    phases,
    environmentId: environment.id,
    containerId,
    async close() {
      await writer.release();
      storage.close();
    },
  };
}

/** Runs a preserving rebuild with the backend's Docker calls sent to `dockerHost`. */
async function rebuild(
  env: LiveEnvironment,
  expectedContainerId: string,
  dockerHost = endpoint,
): Promise<{ outcome?: { containerId: string }; error?: Error }> {
  const { replaceRuntimePreservingState } = await import("../src/core/container-replacement");
  return withDockerHost(dockerHost, () =>
    replaceRuntimePreservingState(
      { environmentId: env.environmentId, expectedContainerId },
      env.context,
    ).then(
      (outcome) => ({ outcome: outcome ?? undefined }),
      (error: unknown) => ({ error: error instanceof Error ? error : new Error(String(error)) }),
    ),
  );
}

async function workspaceFingerprint(containerId: string, bigFile: boolean): Promise<string> {
  const snapshot = await exec(containerId, WORKSPACE_SNAPSHOT);
  return bigFile
    ? `${snapshot}\n${await exec(containerId, "sha256sum /workspace/big.bin")}`
    : snapshot;
}

/**
 * Exactly one authoritative runtime and storage set: the record's runtime is
 * the environment's container and not also a recovery copy, and every
 * container and volume Docker holds for the environment is either current or
 * a referenced recovery copy — nothing orphaned, nothing missing.
 */
async function expectOneAuthoritativeSet(environment: Environment | null) {
  expect(environment).not.toBeNull();
  const record = lifecycleOf(environment);
  expect(record.operation).toBeUndefined();
  expect(record.runtime?.containerId).toBeDefined();
  expect(record.runtime?.containerId).toBe(environment!.containerId!);
  const retainedRuntimes = (record.retainedRuntimes ?? []).map((runtime) => runtime.containerId);
  expect(retainedRuntimes).not.toContain(record.runtime!.containerId);
  const retainedSets = (record.retainedStorage ?? []).map((set) => set.storageSetId);
  if (record.storage.storageSetId) expect(retainedSets).not.toContain(record.storage.storageSetId);
  const label = `label=environment-id=${environment!.id}`;
  expect(await dockerList(["ps", "-aq", "--no-trunc", "--filter", label])).toEqual(
    [record.runtime!.containerId, ...retainedRuntimes].sort(),
  );
  const referenced = new Set(
    [
      ...(record.storage.volumes ?? []),
      ...(record.retainedStorage ?? []).flatMap((set) => set.volumes),
    ].map((volume) => volume.name),
  );
  expect(await dockerList(["volume", "ls", "-q", "--filter", label])).toEqual(
    [...referenced].sort(),
  );
  return record;
}

/** Storage helpers this registry started that are still on the daemon. */
async function storageHelpers(owner: string, status?: "running"): Promise<string[]> {
  return dockerList([
    "ps",
    "-q",
    ...(status ? ["--filter", `status=${status}`] : ["-a"]),
    "--filter",
    `label=orkestrator-owner=${owner}`,
    "--filter",
    "label=orkestrator-resource-role=storage-helper",
  ]);
}

async function waitForStorageHelpersGone(owner: string, timeoutMs = 600_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while ((await storageHelpers(owner)).length > 0) {
    if (Date.now() > deadline) throw new Error("storage helper outlived the disconnect");
    await sleep(1_000);
  }
}

async function startProxy(name: string): Promise<DockerApiProxy> {
  if (!endpoint.startsWith("unix://")) {
    throw new Error(`The disconnect fixture needs a unix-socket Docker endpoint, not ${endpoint}`);
  }
  // Short: macOS limits unix socket paths to 104 bytes.
  const proxy = await startDockerApiProxy(
    `/tmp/ork-${RUN}-${name}.sock`,
    endpoint.slice("unix://".length),
  );
  proxies.push(proxy);
  return proxy;
}

/**
 * After a disconnect the rebuild cannot remove its candidate, so the
 * candidate's volumes must be kept referenced as a failed-candidate copy; once
 * Docker is back, the backend's reconciliation has nothing left unresolved
 * and discarding that copy removes exactly its volumes.
 */
async function expectDisconnectRetainedOriginal(
  env: LiveEnvironment,
  proxy: DockerApiProxy,
  originalId: string,
  originalSetId: string | undefined,
  error: Error | undefined,
) {
  expect(error?.message).toStartWith("ContainerLifecycleError:");
  let environment = await env.storage.getEnvironment(env.environmentId);
  let record = lifecycleOf(environment);
  expect(record.operation).toBeUndefined();
  expect(environment?.containerId).toBe(originalId);
  expect(environment?.status).toBe("stopped");
  expect(record.runtime?.containerId).toBe(originalId);
  expect(record.storage.storageSetId).toBe(originalSetId);
  const outcome = record.outcomes.at(-1);
  expect(outcome).toMatchObject({ status: "failed" });
  expect(outcome?.failureCode).toBeDefined();
  const failed = (record.retainedStorage ?? []).filter((set) => set.reason === "failed-candidate");
  expect(failed).toEqual([
    expect.objectContaining({ operationId: outcome!.operationId, reason: "failed-candidate" }),
  ]);
  expect(failed[0]!.volumes.map((volume) => volume.role).sort()).toEqual(["state", "workspace"]);
  // A helper the cut client started may still be running daemon-side; it is
  // `--rm` and must go away by itself.
  await waitForStorageHelpersGone(env.owner);

  await proxy.restore();
  // What the backend does when Docker is reachable again and on its next
  // start: settle anything unresolved by exact identity. Nothing is.
  expect(
    await withDockerHost(proxy.endpoint, () => reconcileContainerOperations(env.context)),
  ).toEqual([]);
  record = await expectOneAuthoritativeSet(await env.storage.getEnvironment(env.environmentId));
  // No candidate runtime was ever created.
  expect(
    await dockerList([
      "ps",
      "-aq",
      "--filter",
      `label=orkestrator-operation-id=${outcome!.operationId}`,
    ]),
  ).toEqual([]);

  // The failed candidate is listed, never restorable, and discards cleanly.
  const { listRecoveryCopies, discardRecoveryCopy } = await import("../src/core/recovery-copies");
  const list = await withDockerHost(proxy.endpoint, () =>
    listRecoveryCopies(env.environmentId, env.context),
  );
  const copy = list.copies.find((entry) => entry.reason === "failed-candidate");
  expect(copy).toMatchObject({ restorable: false });
  const discarded = await withDockerHost(proxy.endpoint, () =>
    discardRecoveryCopy(
      { environmentId: env.environmentId, copyId: copy!.copyId, expectedRevision: list.revision },
      env.context,
    ),
  );
  expect(discarded?.discarded).toBe(true);
  environment = await env.storage.getEnvironment(env.environmentId);
  record = await expectOneAuthoritativeSet(environment);
  expect((record.retainedStorage ?? []).some((set) => set.reason === "failed-candidate")).toBe(
    false,
  );
}

describe("C15 daemon disconnect during the copy keeps the original authoritative", () => {
  live(
    "a legacy migration whose archive stream is cut mid-copy rolls back to the original",
    async () => {
      const env = await createLegacyEnvironment("c15dm", 96);
      const before = await workspaceFingerprint(env.containerId, true);
      const proxy = await startProxy("dm");
      let copying = false;
      let cut: { bytes: number; path: string } | undefined;
      env.phases.add((phase) => {
        if (phase === "copying") copying = true;
      });
      proxy.onDownstream = (connection, request) => {
        const bytes = proxy.downstreamBytes.get(connection) ?? 0;
        if (
          copying &&
          !proxy.severed &&
          request?.method === "GET" &&
          /\/archive\?path=%2Fworkspace(&|$)/.test(request.path) &&
          bytes >= 8 * MiB
        ) {
          cut = { bytes, path: request.path };
          proxy.sever();
        }
      };
      const { outcome, error } = await rebuild(env, env.containerId, proxy.endpoint);
      await evidence("c15-disconnect-migrate", { cut, error: error?.message });
      expect(outcome).toBeUndefined();
      // Cut while /workspace (over 96 MiB) was still streaming.
      expect(cut).toBeDefined();
      expect(cut!.bytes).toBeLessThan(96 * MiB);
      await expectDisconnectRetainedOriginal(env, proxy, env.containerId, undefined, error);
      expect(lifecycleOf(await env.storage.getEnvironment(env.environmentId)).storage.format).toBe(
        "legacy-layer",
      );

      await startRuntime(env.containerId);
      await waitForContainerBoot(env.containerId);
      expect(await workspaceFingerprint(env.containerId, true)).toBe(before);
      await env.close();
    },
    LIVE_TIMEOUT_MS,
  );

  live(
    "a volume rebuild whose copy helper loses its client keeps the original set",
    async () => {
      const env = await createLegacyEnvironment("c15dr", 512);
      const migrated = await rebuild(env, env.containerId);
      expect(migrated.error).toBeUndefined();
      const sourceId = migrated.outcome!.containerId;
      await startRuntime(sourceId);
      await waitForContainerBoot(sourceId);
      const before = await workspaceFingerprint(sourceId, true);
      const stateBefore = await exec(sourceId, STATE_SNAPSHOT);
      const databasesBefore = await sqliteSnapshot(sourceId, true);
      await env.storage.updateEnvironment(env.environmentId, { status: "running" });
      const sourceSet = lifecycleOf(await env.storage.getEnvironment(env.environmentId)).storage;

      const proxy = await startProxy("dr");
      let copying = false;
      env.phases.add((phase) => {
        if (phase === "copying") copying = true;
      });
      // Cut the client the moment the daemon has started the first copy
      // helper: the copy is then running daemon-side, out of the client's reach.
      let helperAtCut: Promise<string> | undefined;
      proxy.onDownstream = (_connection, request) => {
        const started = /\/containers\/([0-9a-f]+)\/start$/.exec(request?.path ?? "");
        if (!copying || proxy.severed || request?.method !== "POST" || !started) return;
        proxy.sever();
        helperAtCut = docker([
          "inspect",
          "-f",
          '{{.State.Status}} {{index .Config.Labels "orkestrator-resource-role"}} {{join .Args " "}}',
          started[1]!,
        ]).catch((error: unknown) => `gone: ${error instanceof Error ? error.message : error}`);
      };
      const result = await rebuild(env, sourceId, proxy.endpoint);
      const helperState = await helperAtCut;
      await evidence("c15-disconnect-rebuild", {
        helperAtCut: helperState,
        helperStillPresentAfterFailure: (await storageHelpers(env.owner)).length > 0,
        error: result.error?.message,
      });
      expect(result.outcome).toBeUndefined();
      // Still copying the source workspace volume when its client was cut.
      expect(helperState).toStartWith("running storage-helper copy-volume /source");
      await expectDisconnectRetainedOriginal(
        env,
        proxy,
        sourceId,
        sourceSet.storageSetId,
        result.error,
      );

      await startRuntime(sourceId);
      await waitForContainerBoot(sourceId);
      expect(await workspaceFingerprint(sourceId, true)).toBe(before);
      expect(await exec(sourceId, STATE_SNAPSHOT)).toBe(stateBefore);
      expect(await sqliteSnapshot(sourceId, true)).toBe(databasesBefore);
      await env.close();
    },
    LIVE_TIMEOUT_MS,
  );

  live(
    "a daemon outage spanning the copy phase never commits a candidate with skipped data",
    async () => {
      const env = await createLegacyEnvironment("c15do");
      const before = await workspaceFingerprint(env.containerId, false);
      const proxy = await startProxy("do");
      const seen: string[] = [];
      env.phases.add((phase) => {
        seen.push(phase);
        // Docker goes away as the copy starts and is back by the time the
        // copy would have been verified.
        if (phase === "copying") proxy.sever();
        if (phase === "verified") void proxy.restore();
      });
      const { outcome, error } = await rebuild(env, env.containerId, proxy.endpoint);
      await evidence("c15-outage-spanning-copy", {
        phases: seen,
        committed: outcome !== undefined,
        error: error?.message,
      });
      expect(outcome).toBeUndefined();
      expect(seen).not.toContain("verified");
      await expectDisconnectRetainedOriginal(env, proxy, env.containerId, undefined, error);
      await startRuntime(env.containerId);
      await waitForContainerBoot(env.containerId);
      expect(await workspaceFingerprint(env.containerId, false)).toBe(before);
      await env.close();
    },
    LIVE_TIMEOUT_MS,
  );
});

interface PausedDriver {
  child: Subprocess<"ignore", "pipe", "pipe">;
  paused: Extract<KillDriverEvent, { event: "paused" }>;
  events: KillDriverEvent[];
}

/** Starts the driver and resolves once it parks at the commit write. */
async function runDriverUntilPaused(config: KillDriverConfig): Promise<PausedDriver> {
  const child = Bun.spawn(["bun", DRIVER, JSON.stringify(config)], {
    cwd: BACKEND_DIR,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    env: process.env,
  });
  let stderr = "";
  void (async () => {
    const decoder = new TextDecoder();
    for await (const chunk of child.stderr) {
      if (stderr.length < 16_384) stderr += decoder.decode(chunk);
    }
  })();
  const events: KillDriverEvent[] = [];
  const decoder = new TextDecoder();
  let buffered = "";
  for await (const chunk of child.stdout) {
    buffered += decoder.decode(chunk);
    let newline = buffered.indexOf("\n");
    while (newline >= 0) {
      const line = buffered.slice(0, newline).trim();
      buffered = buffered.slice(newline + 1);
      newline = buffered.indexOf("\n");
      if (!line.startsWith("{")) continue;
      const event = JSON.parse(line) as KillDriverEvent;
      events.push(event);
      if (event.event === "paused") return { child, paused: event, events };
      if (event.event === "error" || event.event === "finished") {
        child.kill("SIGKILL");
        throw new Error(`driver did not pause: ${JSON.stringify(event)} ${stderr}`);
      }
    }
  }
  throw new Error(`driver exited before pausing (${await child.exited}): ${stderr}`);
}

async function acquireWriterAfterKill(dataDir: string): Promise<RegistryWriter> {
  const deadline = Date.now() + 5 * LEASE_STALE_MS + 60_000;
  for (;;) {
    const writer = await openRegistryWriter(dataDir, { staleMs: LEASE_STALE_MS });
    if (writer.isHeld()) return writer;
    if (Date.now() > deadline) throw new Error("the dead writer's lease never became stale");
    await sleep(1_000);
  }
}

function storedEnvironment(dataDir: string, environmentId: string): Environment | undefined {
  return readStoredValue<Environment[]>(dataDir, "environments.json")?.find(
    (environment) => environment.id === environmentId,
  );
}

async function runKillScenario(pauseAt: KillDriverConfig["pauseAt"]) {
  const env = await createLegacyEnvironment(pauseAt === "before-commit" ? "c15kb" : "c15ka");
  // A volume-backed source: migrate first, as C14 does.
  const migrated = await rebuild(env, env.containerId);
  expect(migrated.error).toBeUndefined();
  const sourceId = migrated.outcome!.containerId;
  await startRuntime(sourceId);
  await waitForContainerBoot(sourceId);
  const before = await workspaceFingerprint(sourceId, false);
  const stateBefore = await exec(sourceId, STATE_SNAPSHOT);
  const databasesBefore = await sqliteSnapshot(sourceId, true);
  await env.storage.updateEnvironment(env.environmentId, { status: "running" });
  const sourceSet = lifecycleOf(await env.storage.getEnvironment(env.environmentId)).storage;
  // This "backend" exits cleanly; the next one runs the rebuild.
  await env.close();

  const { child, paused, events } = await runDriverUntilPaused({
    dataDir: env.dataDir,
    environmentId: env.environmentId,
    expectedContainerId: sourceId,
    image: IMAGE,
    pauseAt,
    leaseStaleMs: LEASE_STALE_MS,
  });
  const phases = events.flatMap((event) => (event.event === "phase" ? [event.phase] : []));
  await evidence(`c15-kill-${pauseAt}`, { driverPid: child.pid, phases });
  // Nothing is persisted between the health check and the commit write.
  expect(phases.at(-1)).toBe("candidate-healthy");
  // The durable record at the instant of the kill.
  const atKill = storedEnvironment(env.dataDir, env.environmentId);
  const recordAtKill = lifecycleOf(atKill ?? null);
  if (pauseAt === "before-commit") {
    expect(recordAtKill.operation).toMatchObject({
      operationId: paused.operationId,
      kind: "rebuild",
      phase: "candidate-healthy",
      status: "running",
    });
    expect(atKill?.containerId).toBe(sourceId);
  } else {
    expect(recordAtKill.operation).toBeUndefined();
    expect(recordAtKill.outcomes.at(-1)).toMatchObject({
      operationId: paused.operationId,
      status: "succeeded",
    });
    expect(atKill?.containerId).toBe(paused.candidateContainerId);
  }
  // The candidate passed its health check and was stopped again.
  expect(await docker(["inspect", "-f", "{{.State.Status}}", paused.candidateContainerId])).toBe(
    "exited",
  );

  process.kill(child.pid, "SIGKILL");
  await child.exited;
  expect(child.signalCode).toBe("SIGKILL");

  // The dead process's lease still excludes a second writer until it is stale.
  const early = await openRegistryWriter(env.dataDir, { staleMs: LEASE_STALE_MS });
  expect(early.isHeld()).toBe(false);
  const writer = await acquireWriterAfterKill(env.dataDir);
  const storage = new StorageService(env.dataDir);
  await storage.init();
  const context = durableLifecycleContext(storage, writer, IMAGE);
  try {
    const reconciled = await reconcileContainerOperations(context);
    const environment = await storage.getEnvironment(env.environmentId);
    const record = await expectOneAuthoritativeSet(environment);
    const outcome = record.outcomes.at(-1);
    await evidence(`c15-kill-${pauseAt}-reconciled`, {
      reconciled: reconciled.map((entry) => entry.result),
      outcome: outcome && { kind: outcome.kind, status: outcome.status },
      runtimeGeneration: record.runtime?.runtimeGeneration,
      retainedRuntimes: record.retainedRuntimes?.length ?? 0,
      retainedStorage: (record.retainedStorage ?? []).map((set) => set.reason),
    });
    let authoritative: string;
    if (pauseAt === "before-commit") {
      // Never committed: the original runtime and set stay authoritative and
      // the candidate (container and volumes) is removed by its operation label.
      expect(reconciled).toEqual([{ environmentId: env.environmentId, result: "settled" }]);
      expect(outcome).toMatchObject({
        operationId: paused.operationId,
        kind: "rebuild",
        status: "interrupted",
        failureCode: "interrupted",
      });
      expect(environment?.containerId).toBe(sourceId);
      expect(environment?.status).toBe("stopped");
      expect(record.storage.storageSetId).toBe(sourceSet.storageSetId);
      expect(record.runtime?.runtimeGeneration).toBe(2);
      expect(
        await docker(["ps", "-aq", "--no-trunc", "--filter", `id=${paused.candidateContainerId}`]),
      ).toBe("");
      expect(record.retainedStorage ?? []).toEqual([]);
      authoritative = sourceId;
    } else {
      // Committed: nothing is undone; the candidate is authoritative and the
      // old runtime and set are kept, stopped, as recovery copies.
      expect(reconciled).toEqual([]);
      expect(outcome).toMatchObject({ operationId: paused.operationId, status: "succeeded" });
      expect(environment?.containerId).toBe(paused.candidateContainerId);
      expect(record.runtime?.runtimeGeneration).toBe(3);
      expect(record.storage.storageSetId).toBe(paused.candidateStorageSetId);
      expect(record.storage.storageSetId).not.toBe(sourceSet.storageSetId);
      expect(record.retainedRuntimes).toContainEqual(
        expect.objectContaining({ containerId: sourceId, retainedReason: "rebuild-source" }),
      );
      expect(record.retainedStorage).toContainEqual(
        expect.objectContaining({ storageSetId: sourceSet.storageSetId, reason: "rebuild-source" }),
      );
      expect(await docker(["inspect", "-f", "{{.State.Status}}", sourceId])).toBe("exited");
      authoritative = paused.candidateContainerId;
    }
    // A second pass finds nothing more to do.
    expect(await reconcileContainerOperations(context)).toEqual([]);

    await startRuntime(authoritative);
    await waitForContainerBoot(authoritative);
    expect(await workspaceFingerprint(authoritative, false)).toBe(before);
    expect(await exec(authoritative, STATE_SNAPSHOT)).toBe(stateBefore);
    expect(await sqliteSnapshot(authoritative, true)).toBe(databasesBefore);
    if (pauseAt === "after-commit") {
      // The recovery copy is intact too.
      await docker(["stop", "-t", "5", authoritative]);
      await startRuntime(sourceId);
      await waitForContainerBoot(sourceId);
      expect(await workspaceFingerprint(sourceId, false)).toBe(before);
      await docker(["stop", "-t", "5", sourceId]);
    }
  } finally {
    await writer.release();
    storage.close();
  }
}

describe("C15 backend killed at the rebuild commit write", () => {
  live(
    "a kill immediately before the commit write keeps the original authoritative",
    () => runKillScenario("before-commit"),
    LIVE_TIMEOUT_MS,
  );

  live(
    "a kill immediately after the commit write keeps the candidate authoritative",
    () => runKillScenario("after-commit"),
    LIVE_TIMEOUT_MS,
  );
});
