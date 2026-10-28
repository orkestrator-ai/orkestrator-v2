import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { CommandContext } from "./commands-context.js";
import { gitHubCli, setManagedGitHubCli } from "./github-cli-binary.js";
import { HostMaintenanceService } from "./host-maintenance.js";
import {
  applyGhChannel,
  ensureEnvironmentImage,
  fetchReleasePins,
  installedLatestGh,
  startGhUpdate,
  startImageUpdate,
  startToolchainRepair,
} from "./host-maintenance-tasks.js";
import { runCommand } from "./shell.js";

let dataDir: string;
let service: HostMaintenanceService;

beforeEach(async () => {
  dataDir = await mkdtemp(path.join(tmpdir(), "ork-host-tasks-"));
  service = new HostMaintenanceService({
    dataDir,
    updater: "none",
    version: "2.21.1",
    emit: () => undefined,
  });
  service.init();
});

afterEach(async () => {
  setManagedGitHubCli(undefined);
  service.close();
  await rm(dataDir, { recursive: true, force: true });
});

function context(): CommandContext {
  return {
    hostMaintenance: service,
    storage: { getDataDir: () => dataDir },
  } as unknown as CommandContext;
}

async function until(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("timed out");
    await Bun.sleep(10);
  }
}

/** A gh release archive for this platform holding a script that prints its version. */
async function ghRelease(version: string): Promise<{ name: string; bytes: Uint8Array }> {
  const target = `${process.platform === "darwin" ? "macOS" : "linux"}_${process.arch === "x64" ? "amd64" : "arm64"}`;
  const folder = `gh_${version}_${target}`;
  const work = path.join(dataDir, "fixture");
  await mkdir(path.join(work, folder, "bin"), { recursive: true });
  const executable = path.join(work, folder, "bin", "gh");
  await writeFile(executable, `#!/bin/sh\necho "gh version ${version} (2026-10-01)"\n`);
  await chmod(executable, 0o755);
  const zip = process.platform === "darwin";
  const name = `${folder}.${zip ? "zip" : "tar.gz"}`;
  if (zip) await runCommand("zip", ["-qr", name, folder], { cwd: work, timeoutMs: 30_000 });
  else await runCommand("tar", ["-czf", name, folder], { cwd: work, timeoutMs: 30_000 });
  return { name, bytes: new Uint8Array(await readFile(path.join(work, name))) };
}

function github(version: string, archive: { name: string; bytes: Uint8Array }, corrupt = false) {
  const digest = createHash("sha256").update(archive.bytes).digest("hex");
  return (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith("/releases/latest")) return Response.json({ tag_name: `v${version}` });
    if (url.endsWith("_checksums.txt")) {
      return new Response(`${corrupt ? "0".repeat(64) : digest}  ${archive.name}\n`);
    }
    if (url.endsWith(archive.name)) return new Response(new Blob([archive.bytes as BlobPart]));
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
}

describe("gh channel", () => {
  test("installs the newest gh after checking GitHub's checksum and uses it", async () => {
    const archive = await ghRelease("2.200.0");
    const task = startGhUpdate(context(), "latest", {
      pinned: "/managed/gh",
      fetchImpl: github("2.200.0", archive),
    });
    await until(() => service.task(task.id)?.state !== "running");
    expect(service.task(task.id)).toMatchObject({
      state: "succeeded",
      result: { channel: "latest", version: "2.200.0" },
    });
    expect(service.ghChannel()).toBe("latest");
    expect(gitHubCli()).toBe((await installedLatestGh(dataDir)) ?? "");
    expect(gitHubCli()).toContain(path.join("gh-latest", "2.200.0", "gh"));
    expect(await installedLatestGh(dataDir)).not.toBeNull();
  });

  test("refuses an archive that does not match its checksum", async () => {
    const archive = await ghRelease("2.200.0");
    const task = startGhUpdate(context(), "latest", {
      pinned: "/managed/gh",
      fetchImpl: github("2.200.0", archive, true),
    });
    await until(() => service.task(task.id)?.state !== "running");
    expect(service.task(task.id)).toMatchObject({ state: "failed" });
    expect(service.task(task.id)?.error).toContain("checksum");
    expect(service.ghChannel()).toBe("pinned");
  });

  test("going back to the pin selects the managed gh again", async () => {
    service.setGhChannel("latest");
    const task = startGhUpdate(context(), "pinned", { pinned: "/managed/gh" });
    await until(() => service.task(task.id)?.state !== "running");
    expect(service.ghChannel()).toBe("pinned");
    expect(gitHubCli()).toBe("/managed/gh");
  });

  test("at startup, latest without an installed copy falls back to the pin", async () => {
    await applyGhChannel(context(), "latest", "/managed/gh");
    expect(gitHubCli()).toBe("/managed/gh");
  });
});

describe("fetchReleasePins", () => {
  test("reads the release's toolchain-pins.json", async () => {
    const fetchImpl = (async (input: RequestInfo | URL) => {
      expect(String(input)).toBe(
        "https://github.com/orkestrator-ai/orkestrator-v2/releases/download/v2.22.0/toolchain-pins.json",
      );
      return Response.json({ version: "2.22.0", tools: { claude: "2.1.310", gh: "2.105.0" } });
    }) as typeof fetch;
    expect(await fetchReleasePins("2.22.0", fetchImpl)).toEqual({
      version: "2.22.0",
      tools: { claude: "2.1.310", gh: "2.105.0" },
    });
  });

  test("an unpublished or malformed list is no pins", async () => {
    const missing = (async () => new Response("", { status: 404 })) as unknown as typeof fetch;
    expect(await fetchReleasePins("2.22.0", missing)).toBeNull();
    const malformed = (async () => Response.json({ tools: [1, 2] })) as unknown as typeof fetch;
    expect(await fetchReleasePins("2.22.0", malformed)).toBeNull();
    expect(await fetchReleasePins("latest", missing)).toBeNull();
  });
});

test.each(["compatible", "incompatible", "pull-failure", "tag-failure"])(
  "image update records %s without recreating containers",
  async (mode) => {
    const calls: string[][] = [];
    const reset = mock(() => undefined);
    const dependencies: Parameters<typeof startImageUpdate>[1] = {
      run: async (_file, args = []) => {
        calls.push(args);
        if (mode === "pull-failure" && args[0] === "pull") throw new Error("pull failed");
        if (mode === "tag-failure" && args[0] === "tag") throw new Error("tag failed");
        return { stdout: "", stderr: "" };
      },
      status: async () => ({
        state: mode === "incompatible" ? "incompatible" : "compatible",
        imageRef: "release",
        imageId: "sha256:new",
        registryDigest: null,
        architecture: null,
        manifest: null,
        missingCapabilities: mode === "incompatible" ? ["workspace-prepare"] : [],
        remediation: null,
      }),
      read: async () => ({
        name: "target",
        present: true,
        compatible: true,
        reason: null,
        releaseReference: "release",
        outdatedEnvironments: [
          { id: "old-container", name: "Existing work", projectId: "project" },
        ],
      }),
      reset,
    };
    const task = startImageUpdate({ ...context(), dockerImage: "fixture:target" }, dependencies);
    await until(() => service.task(task.id)?.state !== "running");
    if (mode === "compatible") {
      expect(service.task(task.id)).toMatchObject({
        state: "succeeded",
        result: {
          imageId: "sha256:new",
          tag: "fixture:target",
          outdatedEnvironments: [{ id: "old-container" }],
        },
      });
      expect(calls.map((args) => args[0])).toEqual(["pull", "tag"]);
      expect(reset).toHaveBeenCalledTimes(1);
    } else {
      expect(service.task(task.id)?.state).toBe("failed");
      expect(reset).not.toHaveBeenCalled();
      if (mode === "incompatible") {
        expect(service.task(task.id)?.error).toContain("workspace-prepare");
        expect(calls.map((args) => args[0])).toEqual(["pull"]);
      }
    }
  },
);

describe("ensureEnvironmentImage", () => {
  const compatible = {
    state: "compatible" as const,
    imageRef: "release",
    imageId: "sha256:new",
    registryDigest: null,
    architecture: null,
    manifest: null,
    missingCapabilities: [],
    remediation: null,
  };

  /** An image update whose `docker pull` waits for `release()`. */
  function gatedDownload(fail = false) {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const calls: string[][] = [];
    const start = mock((target: CommandContext) =>
      startImageUpdate(target, {
        run: async (_file, args = []) => {
          calls.push(args);
          if (args[0] === "pull") {
            await gate;
            if (fail) throw new Error("dial tcp: no route to host");
          }
          return { stdout: "", stderr: "" };
        },
        status: async () => compatible,
        read: async () => null,
        reset: () => undefined,
      }),
    );
    return { start, calls, release };
  }

  test("downloads a missing default image once for concurrent creates", async () => {
    const { start, calls, release } = gatedDownload();
    const resolve = mock(async (imageRef: string) => ({ kind: "missing" as const, imageRef }));
    const first = ensureEnvironmentImage(context(), { resolve, start });
    const second = ensureEnvironmentImage(context(), { resolve, start });
    await until(() => calls.length === 1);
    release();
    await Promise.all([first, second]);

    expect(start).toHaveBeenCalledTimes(1);
    expect(calls.map((args) => args[0])).toEqual(["pull", "tag"]);
    expect(calls[1]?.[2]).toBe("orkestrator-v2:latest");
  });

  test("a failed download reports the image as missing", async () => {
    const { start, release } = gatedDownload(true);
    const pending = ensureEnvironmentImage(context(), {
      resolve: async (imageRef) => ({ kind: "missing", imageRef }),
      start,
    });
    release();
    await expect(pending).rejects.toThrow(/^No such image: orkestrator-v2:latest\..*no route/);
  });

  test("leaves a present image and a custom image alone", async () => {
    const { start } = gatedDownload();
    await ensureEnvironmentImage(context(), {
      resolve: async (imageRef) => ({
        kind: "present",
        imageRef,
        imageId: "sha256:old",
        registryDigest: null,
        architecture: null,
      }),
      start,
    });
    const resolve = mock(async (imageRef: string) => ({ kind: "missing" as const, imageRef }));
    await ensureEnvironmentImage({ ...context(), dockerImage: "custom:dev" }, { resolve, start });

    expect(resolve).not.toHaveBeenCalled();
    expect(start).not.toHaveBeenCalled();
  });
});

test.each([false, true])(
  "desktop toolchain repair preserves activation and reports restartRequired=%s",
  async (changed) => {
    service.close();
    service = new HostMaintenanceService({
      dataDir,
      updater: "desktop",
      version: "2.21.1",
      emit: () => undefined,
    });
    service.init();
    const { pinnedToolchainArtifacts } = await import("@orkestrator/toolchain/manifest");
    const artifacts = pinnedToolchainArtifacts(process.platform, process.arch);
    const inUse = path.join(dataDir, "toolchains", "bin", "in-use");
    const selected = changed ? path.join(dataDir, "toolchains", "bin", "new-set") : inUse;
    const install = mock(async () => {
      throw new Error("must not change desktop activation");
    });
    const task = startToolchainRepair(
      { ...context(), toolchainBinDir: inUse },
      {
        plan: async () => ({
          artifacts,
          tools: artifacts.map((artifact) => artifact.name),
          source: "explicit",
        }),
        ensure: async () => ({
          rootDir: dataDir,
          binDir: selected,
          executables: {} as Awaited<
            ReturnType<typeof import("@orkestrator/toolchain/manager").ensurePinnedToolchains>
          >["executables"],
        }),
        install,
      },
    );
    await until(() => service.task(task.id)?.state !== "running");
    expect(service.task(task.id)).toMatchObject({
      state: "succeeded",
      result: {
        restartRequired: changed,
        versions: Object.fromEntries(
          artifacts.map((artifact) => [artifact.name, artifact.version]),
        ),
      },
    });
    expect(install).not.toHaveBeenCalled();
  },
);

test("a toolchain repair failure becomes a durable failed task", async () => {
  const task = startToolchainRepair(context(), {
    plan: async () => {
      throw new Error("unexpected desktop branch");
    },
    ensure: async () => {
      throw new Error("unexpected desktop branch");
    },
    install: async () => {
      throw new Error("digest mismatch");
    },
  });
  await until(() => service.task(task.id)?.state !== "running");
  expect(service.task(task.id)).toMatchObject({ state: "failed", error: "digest mismatch" });
});
