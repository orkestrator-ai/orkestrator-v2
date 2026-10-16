import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { CommandContext } from "./commands-context.js";
import { gitHubCli, setManagedGitHubCli } from "./github-cli-binary.js";
import { HostMaintenanceService } from "./host-maintenance.js";
import {
  applyGhChannel,
  fetchReleasePins,
  installedLatestGh,
  startGhUpdate,
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
