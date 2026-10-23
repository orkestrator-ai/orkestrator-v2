import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { isDesignError } from "./errors.js";
import {
  DESIGN_EXPORT_CONTAINER_WRITER,
  designExportDigest,
  type DesignExportSpawn,
} from "./export-writer.js";
import { exportPreview, exportSave, reconcileExport, type DesignExportContext } from "./exports.js";
import { portableBytes } from "./records.js";
import {
  createDesignHarness,
  trackUnhandledRejections,
  type DesignHarness,
} from "./test-support.js";

/**
 * Opt-in real-container export qualification:
 * `ORKESTRATOR_TEST_DOCKER_DESIGN_IMAGE=orkestrator-v2:latest`.
 *
 * Every export here runs the shipped helper through a real `docker exec -i`
 * into a running container of the environment image, with `/workspace` on a
 * named volume mounted the way `storageMountArguments` mounts it
 * (`volume-nocopy`, owned by `node`). The container is started directly with
 * `sleep` as its entrypoint, so the network-policy entrypoint, workspace setup
 * and Orkestrator's container lifecycle are not part of the run. The volume
 * and container are labelled with a throwaway namespace and removed by id
 * afterwards; nothing touches the user's environments.
 *
 * Interruptions are real: the Docker client is killed with part of the
 * payload sent, the container is stopped or restarted while the helper is
 * waiting for input, and the workspace is emptied under a held export. The
 * spawn seam only forwards (or withholds) the payload and counts helper runs,
 * so reconciliation is proved to inspect, never to write again.
 */
const image = process.env.ORKESTRATOR_TEST_DOCKER_DESIGN_IMAGE;
const enabled =
  Boolean(image) &&
  spawnSync("docker", ["version"], { stdio: "ignore", timeout: 10_000 }).status === 0;

const OWNER = `ork-design-export-test-${randomUUID().slice(0, 8)}`;
const frameInput = { name: "Page", x: 0, y: 0, width: 400, height: 300, html: "<h1>Page</h1>" };

/** Bounds every Docker client call; lifecycle commands on Docker Desktop can take seconds. */
const DOCKER_CALL_TIMEOUT_MS = 60_000;
const DOCKER_TEST_TIMEOUT_MS = 120_000;

/**
 * Runs the Docker client without blocking the event loop, so a stuck daemon
 * fails the test at its deadline instead of freezing the runner.
 */
async function docker(args: string[], allowFailure = false): Promise<string> {
  const started = Date.now();
  const child = Bun.spawn(["docker", ...args], { stdout: "pipe", stderr: "pipe", stdin: "ignore" });
  const timer = setTimeout(() => child.kill("SIGKILL"), DOCKER_CALL_TIMEOUT_MS);
  const [stdout, stderr, status] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]).finally(() => clearTimeout(timer));
  const elapsed = Date.now() - started;
  if (elapsed > 10_000) console.error(`docker ${args[0]} took ${elapsed} ms`);
  if (status !== 0 && !allowFailure) {
    throw new Error(`docker ${args[0]} failed (${status}): ${stderr.trim()}`);
  }
  return stdout.trim();
}

/** A writer run whose payload the test forwards (or withholds) by hand. */
interface HeldWriter {
  child: ChildProcessWithoutNullStreams;
  /** The real `docker exec` stdin. */
  stdin: NodeJS.WritableStream;
  /** The complete payload the export tried to send. */
  payload: Buffer;
}

interface SpawnControl {
  calls: Array<"writer" | "inspector">;
  /** Holds the next writer run instead of forwarding its payload. */
  holdNextWriter?: (held: HeldWriter) => void;
}

/** Real `docker exec`; records which helper ran and can hold a writer's stdin. */
function controlledSpawn(control: SpawnControl): DesignExportSpawn {
  return (command, args) => {
    const child = spawn(command, args, { stdio: "pipe" });
    const kind = args[5] === DESIGN_EXPORT_CONTAINER_WRITER ? "writer" : "inspector";
    control.calls.push(kind);
    const hold = kind === "writer" ? control.holdNextWriter : undefined;
    if (!hold) return child;
    control.holdNextWriter = undefined;
    const stdin = child.stdin;
    stdin.on("error", () => undefined);
    const gate = new PassThrough();
    const chunks: Buffer[] = [];
    gate.on("data", (chunk: Buffer) => chunks.push(chunk));
    gate.on("end", () => hold({ child, stdin, payload: Buffer.concat(chunks) }));
    Object.defineProperty(child, "stdin", { value: gate, configurable: true, writable: true });
    return child;
  };
}

function holdNextWriter(control: SpawnControl): Promise<HeldWriter> {
  return new Promise((resolve) => {
    control.holdNextWriter = resolve;
  });
}

describe.skipIf(!enabled)("design export from a running container", () => {
  const volume = `${OWNER}-workspace`;
  let containerId = "";
  let harness: DesignHarness;
  let context: DesignExportContext;
  let control: SpawnControl;
  const recordFaults: { beforeRename?: (file: string) => void | Promise<void> } = {};
  const rejections = trackUnhandledRejections();
  const service = () => harness.service;
  const serviceOptions = () => ({
    faults: { beforeRename: (file: string) => recordFaults.beforeRename?.(file) },
  });

  const exec = (script: string, allowFailure = false) =>
    docker(["exec", containerId, "sh", "-c", script], allowFailure);
  const running = async () =>
    (await docker(["inspect", "-f", "{{.State.Running}}", containerId])) === "true";
  /** Inode and mtime of a workspace file, or null when it is absent. */
  const fileIdentity = async (relativePath: string) => {
    const out = await exec(`stat -c '%i %Y' /workspace/${relativePath} 2>/dev/null || true`);
    return out || null;
  };
  const fileDigest = async (relativePath: string) => {
    const out = await exec(`sha256sum /workspace/${relativePath} 2>/dev/null || true`);
    return out ? `sha256:${out.split(" ")[0]}` : null;
  };
  /** Every name under /workspace, including hidden temporary files. */
  const workspaceFiles = async () =>
    (await exec("cd /workspace && find . -mindepth 1 | sort")).split("\n").filter(Boolean);
  /** In-container helper processes (`node -e`) that are still alive. */
  const liveHelpers = async () =>
    (await exec("pgrep -f '^node -e' || true")).split("\n").filter(Boolean);
  /** Bytes the running helper has read so far (its own startup reads, then stdin). */
  const helperBytesRead = async () => {
    const out = await exec(
      "for pid in $(pgrep -f '^node -e'); do sed -n 's/^rchar: //p' /proc/$pid/io; done",
    );
    return out
      .split("\n")
      .filter(Boolean)
      .reduce((sum, value) => sum + Number(value), 0);
  };
  const waitFor = async (check: () => Promise<boolean>, label: string, timeoutMs = 20_000) => {
    const deadline = Date.now() + timeoutMs;
    while (!(await check())) {
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
      await Bun.sleep(100);
    }
  };

  const setup = async (name = "Container design", environmentId = "env-1") => {
    const canvas = await service().create(environmentId, name, undefined, "user");
    await service().createFrame(canvas.id, environmentId, 1, frameInput, "user");
    return canvas.id;
  };
  const save = (canvasId: string, relativePath: string, revision: number, replace?: string) =>
    exportSave(service(), "env-1", canvasId, context, {
      relativePath,
      revision,
      expected: replace ? { state: "present", digest: replace } : { state: "absent" },
    });
  const failureOf = (promise: Promise<unknown>) =>
    promise.then(
      () => undefined,
      (error: unknown) => error,
    );
  const expectedDigest = async (canvasId: string) => {
    const { record } = await service().loadFor(canvasId, "env-1");
    return designExportDigest(portableBytes(record.document));
  };
  /**
   * Once the writer is running (the intent is committed), the next private
   * record write of this canvas, its settlement, fails as if the process died.
   */
  const failNextSettlement = (canvasId: string) => {
    void holdNextWriter(control).then(({ stdin, payload }) => {
      recordFaults.beforeRename = (file) => {
        if (!file.endsWith(`${canvasId}.orkrec`)) return;
        delete recordFaults.beforeRename;
        throw new Error("injected crash before settlement");
      };
      stdin.end(payload);
    });
  };

  beforeAll(async () => {
    await docker(["volume", "create", "--label", `orkestrator-owner=${OWNER}`, volume]);
    // A fresh `volume-nocopy` mount is root-owned; give it to `node` once.
    await docker([
      "run",
      "--rm",
      "--user",
      "0",
      "--network",
      "none",
      "--mount",
      `type=volume,src=${volume},dst=/workspace,volume-nocopy`,
      "--entrypoint",
      "chown",
      image!,
      "1000:1000",
      "/workspace",
    ]);
    containerId = await docker([
      "run",
      "-d",
      "--network",
      "none",
      "--label",
      `orkestrator-owner=${OWNER}`,
      "--mount",
      `type=volume,src=${volume},dst=/workspace,volume-nocopy`,
      "--entrypoint",
      "/bin/sleep",
      image!,
      "infinity",
    ]);
  });

  afterAll(async () => {
    if (containerId) await docker(["rm", "-f", containerId], true);
    await docker(["volume", "rm", volume], true);
  });

  beforeEach(async () => {
    rejections.install();
    delete recordFaults.beforeRename;
    if (!(await running())) await docker(["start", containerId]);
    await exec("find /workspace -mindepth 1 -delete");
    harness = await createDesignHarness({
      prefix: "ork-design-export-container-",
      service: serviceOptions(),
    });
    control = { calls: [] };
    context = {
      destination: { kind: "container", containerId },
      writerOptions: { spawn: controlledSpawn(control), timeoutMs: 20_000 },
    };
  });

  afterEach(async () => {
    delete recordFaults.beforeRename;
    await harness.close();
    rejections.remove();
    expect(rejections.seen).toEqual([]);
    rejections.seen.length = 0;
  });

  test(
    "exports, previews as the same canvas, and replaces with a private backup",
    async () => {
      const canvasId = await setup();
      const digest = await expectedDigest(canvasId);
      const preview = await exportPreview(service(), "env-1", canvasId, context);
      expect(preview.target).toMatchObject({ exists: false, needsReplaceConfirmation: false });
      const receipt = await save(canvasId, preview.suggestedPath, 2);
      expect(receipt).toMatchObject({ revision: 2, digest, replaced: false });
      expect(await fileDigest(preview.suggestedPath)).toBe(digest);
      expect(await exec(`stat -c '%U %a' /workspace/${preview.suggestedPath}`)).toBe("node 644");
      const again = await exportPreview(service(), "env-1", canvasId, context);
      expect(again.target).toMatchObject({
        sameCanvas: true,
        reason: "same-canvas",
        needsReplaceConfirmation: false,
        fingerprint: digest,
      });

      await service().createFrame(canvasId, "env-1", 2, { ...frameInput, x: 500 }, "user");
      const next = await expectedDigest(canvasId);
      const replaced = await save(canvasId, preview.suggestedPath, 3, digest);
      expect(replaced).toMatchObject({ revision: 3, digest: next, replaced: true });
      expect(await fileDigest(preview.suggestedPath)).toBe(next);
      await service().close();
      const backups = await readdir(service().store.exportBackupDir(canvasId));
      expect(backups).toHaveLength(1);
      const backup = await readFile(join(service().store.exportBackupDir(canvasId), backups[0]!));
      expect(designExportDigest(backup)).toBe(digest);
      expect((await workspaceFiles()).filter((name) => name.endsWith(".tmp"))).toEqual([]);
    },
    DOCKER_TEST_TIMEOUT_MS,
  );

  test(
    "a stopped container refuses before writing and leaves nothing to reconcile",
    async () => {
      const canvasId = await setup();
      await docker(["stop", "-t", "1", containerId]);
      const failure = await failureOf(save(canvasId, "designs/stopped.orkdes", 2));
      expect(isDesignError(failure, "storage")).toBe(true);
      expect(await service().snapshot("env-1", canvasId)).not.toHaveProperty(
        "workspace.pendingExport",
      );
      expect(await reconcileExport(service(), "env-1", canvasId, context)).toEqual({
        state: "none",
      });
      await docker(["start", containerId]);
      expect(await workspaceFiles()).toEqual([]);
      expect(await save(canvasId, "designs/stopped.orkdes", 2)).toMatchObject({ revision: 2 });
    },
    DOCKER_TEST_TIMEOUT_MS,
  );

  for (const stage of [
    { name: "before the write", forwarded: 0, lands: false },
    { name: "during the write", forwarded: 0.5, lands: false },
    // The daemon closes the helper's stdin when the client dies, so a complete
    // payload is published although the client never hears the result.
    { name: "after sending every byte", forwarded: 1, lands: true },
  ]) {
    test(
      `a client killed ${stage.name} is an unknown outcome proved by digest`,
      async () => {
        // A large payload keeps the helper's own startup reads small beside it.
        const canvas = await service().create("env-1", "Large design", undefined, "user");
        const canvasId = canvas.id;
        const html = `<p>${"x".repeat(200 * 1024)}</p>`;
        await service().createFrame(canvasId, "env-1", 1, { ...frameInput, html }, "user");
        await service().createFrame(canvasId, "env-1", 2, { ...frameInput, x: 500, html }, "user");
        const digest = await expectedDigest(canvasId);
        const held = holdNextWriter(control);
        const saving = failureOf(save(canvasId, "designs/killed.orkdes", 3));
        const { child, stdin, payload } = await held;
        const sent = Math.floor(payload.length * stage.forwarded);
        // Nothing has been forwarded yet: wait for the helper to start and its
        // own reads to settle, so the baseline counts no payload byte.
        let baseline = -1;
        await waitFor(async () => {
          if ((await liveHelpers()).length === 0) return false;
          const read = await helperBytesRead();
          const settled = read === baseline;
          baseline = read;
          return settled;
        }, "the helper to start");
        if (sent > 0) {
          await new Promise<void>((resolve) =>
            stdin.write(payload.subarray(0, sent), () => resolve()),
          );
          // The client dies only once the helper has read every byte sent.
          await waitFor(
            async () => (await helperBytesRead()) >= baseline + sent,
            "the helper to read the sent bytes",
          );
        }
        child.kill("SIGKILL");
        const failure = await saving;
        expect(isDesignError(failure, "unknown-outcome")).toBe(true);
        expect(await service().snapshot("env-1", canvasId)).toMatchObject({
          workspace: { pendingExport: { state: "unknown", relativePath: "designs/killed.orkdes" } },
        });
        // The orphaned helper sees end of input, then publishes or refuses and exits.
        await waitFor(
          async () => (await liveHelpers()).length === 0,
          "the orphaned helper to exit",
        );
        expect((await workspaceFiles()).filter((name) => name.includes("killed"))).toEqual(
          stage.lands ? ["./designs/killed.orkdes"] : [],
        );
        const identity = await fileIdentity("designs/killed.orkdes");
        const writers = control.calls.filter((kind) => kind === "writer").length;
        const reconciled = await reconcileExport(service(), "env-1", canvasId, context);
        expect(control.calls.filter((kind) => kind === "writer").length).toBe(writers);
        if (stage.lands) {
          expect(reconciled).toMatchObject({ state: "exported", receipt: { revision: 3, digest } });
          expect(await fileIdentity("designs/killed.orkdes")).toBe(identity);
          expect(await fileDigest("designs/killed.orkdes")).toBe(digest);
          return;
        }
        expect(reconciled).toEqual({ state: "not-exported" });
        expect(await save(canvasId, "designs/killed.orkdes", 3)).toMatchObject({ revision: 3 });
        expect(await fileDigest("designs/killed.orkdes")).toBe(digest);
      },
      DOCKER_TEST_TIMEOUT_MS,
    );
  }

  test(
    "a crash after the rename and before the association commit reconciles without rewriting",
    async () => {
      const canvasId = await setup();
      failNextSettlement(canvasId);
      await expect(save(canvasId, "designs/lost.orkdes", 2)).rejects.toThrow("injected");
      const identity = await fileIdentity("designs/lost.orkdes");
      expect(identity).not.toBeNull();
      const restarted = await harness.restart(serviceOptions());
      expect(await restarted.snapshot("env-1", canvasId)).toMatchObject({
        workspace: { pendingExport: { state: "unknown", relativePath: "designs/lost.orkdes" } },
      });
      const writers = control.calls.filter((kind) => kind === "writer").length;
      expect(await reconcileExport(restarted, "env-1", canvasId, context)).toMatchObject({
        state: "exported",
        receipt: { relativePath: "designs/lost.orkdes", revision: 2 },
      });
      expect(control.calls.filter((kind) => kind === "writer").length).toBe(writers);
      expect(await fileIdentity("designs/lost.orkdes")).toBe(identity);
      expect(await fileDigest("designs/lost.orkdes")).toBe(await expectedDigest(canvasId));
      expect(await restarted.snapshot("env-1", canvasId)).toMatchObject({
        workspace: { export: { relativePath: "designs/lost.orkdes", lastExportedRevision: 2 } },
      });
    },
    DOCKER_TEST_TIMEOUT_MS,
  );

  for (const action of ["stop", "restart"] as const) {
    test(
      `a container ${action} while the helper waits for input publishes nothing`,
      async () => {
        const canvasId = await setup();
        const held = holdNextWriter(control);
        const saving = failureOf(save(canvasId, "designs/interrupted.orkdes", 2));
        const { stdin, payload } = await held;
        await docker([action, "-t", "1", containerId]);
        // The payload now arrives at a client whose exec has already gone.
        stdin.end(payload);
        const failure = await saving;
        expect(isDesignError(failure, "unknown-outcome")).toBe(true);
        if (action === "stop") {
          // Inspection cannot prove either outcome while the container is down.
          expect(await reconcileExport(service(), "env-1", canvasId, context)).toEqual({
            state: "unavailable",
          });
          expect(await service().snapshot("env-1", canvasId)).toMatchObject({
            workspace: { pendingExport: { state: "unknown" } },
          });
          await docker(["start", containerId]);
        }
        await waitFor(running, "the container to run");
        expect(await workspaceFiles()).toEqual([]);
        expect(await reconcileExport(service(), "env-1", canvasId, context)).toEqual({
          state: "not-exported",
        });
        expect(control.calls.filter((kind) => kind === "writer")).toHaveLength(1);
        expect(await save(canvasId, "designs/interrupted.orkdes", 2)).toMatchObject({
          revision: 2,
        });
      },
      DOCKER_TEST_TIMEOUT_MS,
    );
  }

  test(
    "a container stopped after publishing reconciles once it runs again",
    async () => {
      const canvasId = await setup();
      failNextSettlement(canvasId);
      await expect(save(canvasId, "designs/published.orkdes", 2)).rejects.toThrow("injected");
      const identity = await fileIdentity("designs/published.orkdes");
      await docker(["stop", "-t", "1", containerId]);
      const restarted = await harness.restart(serviceOptions());
      expect(await reconcileExport(restarted, "env-1", canvasId, context)).toEqual({
        state: "unavailable",
      });
      await docker(["start", containerId]);
      expect(await reconcileExport(restarted, "env-1", canvasId, context)).toMatchObject({
        state: "exported",
        receipt: { revision: 2 },
      });
      expect(control.calls.filter((kind) => kind === "writer")).toHaveLength(1);
      expect(await fileIdentity("designs/published.orkdes")).toBe(identity);
    },
    DOCKER_TEST_TIMEOUT_MS,
  );

  test(
    "an emptied workspace under a held export gets exactly the export, or none after publish",
    async () => {
      const canvasId = await setup();
      await exec("mkdir -p /workspace/designs && echo keep > /workspace/designs/other.txt");
      const held = holdNextWriter(control);
      const saving = save(canvasId, "designs/removed.orkdes", 2);
      const { stdin, payload } = await held;
      await exec("find /workspace -mindepth 1 -delete");
      stdin.end(payload);
      // The writer recreates the folder and publishes only its own exact bytes.
      expect(await saving).toMatchObject({ revision: 2, replaced: false });
      expect(await workspaceFiles()).toEqual(["./designs", "./designs/removed.orkdes"]);
      expect(await fileDigest("designs/removed.orkdes")).toBe(await expectedDigest(canvasId));

      // Removed after the rename but before the association commit: proved absent.
      const second = await setup("Second");
      failNextSettlement(second);
      await expect(
        exportSave(service(), "env-1", second, context, {
          relativePath: "designs/second.orkdes",
          revision: 2,
          expected: { state: "absent" },
        }),
      ).rejects.toThrow("injected");
      await exec("find /workspace -mindepth 1 -delete");
      const writers = control.calls.filter((kind) => kind === "writer").length;
      expect(await reconcileExport(service(), "env-1", second, context)).toEqual({
        state: "not-exported",
      });
      expect(control.calls.filter((kind) => kind === "writer").length).toBe(writers);
      expect(await workspaceFiles()).toEqual([]);
    },
    DOCKER_TEST_TIMEOUT_MS,
  );

  test(
    "deleting the canvas or its environment during an export never restores it",
    async () => {
      const canvasId = await setup();
      const held = holdNextWriter(control);
      const saving = save(canvasId, "designs/deleted.orkdes", 2);
      const { stdin, payload } = await held;
      await service().delete(canvasId, "env-1", "user");
      stdin.end(payload);
      expect(await saving).toMatchObject({ revision: 2 });
      expect(await fileDigest("designs/deleted.orkdes")).not.toBeNull();
      expect(await service().snapshot("env-1", canvasId)).toMatchObject({ kind: "deleted" });
      expect(await service().list("env-1")).toEqual([]);

      const doomed = await setup("Doomed", "env-gone");
      const heldGone = holdNextWriter(control);
      const gone = failureOf(
        exportSave(service(), "env-gone", doomed, context, {
          relativePath: "designs/gone.orkdes",
          revision: 2,
          expected: { state: "absent" },
        }),
      );
      const writer = await heldGone;
      expect(await service().deleteEnvironment("env-gone")).toBe(1);
      writer.stdin.end(writer.payload);
      expect(isDesignError(await gone, "not-found")).toBe(true);
      expect(await service().snapshot("env-gone", doomed)).toMatchObject({ kind: "missing" });
    },
    DOCKER_TEST_TIMEOUT_MS,
  );
});
