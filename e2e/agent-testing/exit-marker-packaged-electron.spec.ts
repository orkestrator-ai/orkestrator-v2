/**
 * The clean exit marker and the essential log in the packaged app (to-do 6141
 * task 3, docs/architecture/logging.md, "Health summary and the clean exit
 * marker"): the app's own executable, `app.asar` and the bundled Bun backend,
 * with the data directory a packaged build resolves. `dev:test` covered these
 * paths only through the development bundle.
 *
 * Three launches of one disposable profile:
 *
 * 1. The desktop's essential log file appears under `logs/essential/` with
 *    mode 0600 and a desktop `essential.started`, and a diagnostics bundle read
 *    through the same two commands Settings uses (`plan_diagnostics_bundle`,
 *    `read_diagnostics_bundle`) arrives whole and holds that log. Then a
 *    normal quit (`app.quit()`).
 * 2. The next start writes `backend` `previous-run` with `outcome: "clean"`.
 *    Then the app's own process tree is killed with SIGKILL.
 * 3. The next start writes `previous-run` with `outcome: "crashed"`.
 *
 * The native save dialog a release candidate shows for the bundle is not
 * driven here (a person checks it: manual-test checklist, 6141 task 3).
 *
 * Build the app first (`mise run package:mac:unpacked:test`, or
 * `package:linux:unpacked:test`); `mise run test:agent:electron:packaged` runs
 * it. It runs on a disposable agent-test profile under a temporary root with
 * an allowlisted environment (packaged-electron-app.ts), so nothing reaches
 * the user's data directory. Evidence (outcomes, durations, sizes; no log
 * contents) goes to `output/agent-testing/electron-packaged/evidence-exit-marker-packaged.json`.
 */
import { expect, test } from "./electron-fixtures";
import { _electron as electron } from "playwright";
import type { ElectronApplication, Page } from "playwright";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { gunzipSync } from "node:zlib";

import { resolveRuntimeProfile } from "../../apps/desktop/electron/runtime-profile";
import { initializeProfile, reserveLoopbackPorts } from "../../apps/desktop/scripts/dev/profile-io";
import { closeElectron, electronProcessTree } from "./design-electron-cleanup";
import { openDesignWindow } from "./design-canvas-electron-journey";
import { recordElectronDiagnostics } from "./electron-diagnostics";
import { ELECTRON_TEST_SWITCHES } from "./electron-launch-switches";
import { processAlive, signalProcess, waitForStopped, withCleanup } from "../process-cleanup";
import {
  packagedAppExecutable,
  packagedLaunchEnvironment,
  packagedLaunchSwitches,
} from "./packaged-electron-app";

const repositoryRoot = path.resolve(import.meta.dirname, "../..");

type EssentialEntry = {
  area?: string;
  event?: string;
  level?: string;
  fields?: Record<string, unknown>;
};

/** The essential log's entries, oldest first, across its rotated files. */
async function readEssentialEntries(dataDir: string): Promise<EssentialEntry[]> {
  const directory = path.join(dataDir, "logs", "essential");
  const files = ["essential.3.jsonl", "essential.2.jsonl", "essential.1.jsonl", "essential.jsonl"];
  const entries: EssentialEntry[] = [];
  for (const file of files) {
    const text = await readFile(path.join(directory, file), "utf8").catch(() => "");
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      try {
        entries.push(JSON.parse(line) as EssentialEntry);
      } catch {
        // A torn last line while the writer appends; the next read has it whole.
      }
    }
  }
  return entries;
}

/** The `previous-run` outcomes, in order. */
function previousRunOutcomes(entries: readonly EssentialEntry[]): string[] {
  return entries
    .filter((entry) => entry.area === "backend" && entry.event === "previous-run")
    .map((entry) => String(entry.fields?.outcome));
}

/** The names of the regular files in a `.tar.gz`, read from its ustar headers. */
function tarEntryNames(gzipped: Uint8Array): string[] {
  const tar = gunzipSync(gzipped);
  const names: string[] = [];
  let offset = 0;
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const field = (start: number, length: number) =>
      header
        .subarray(start, start + length)
        .toString("utf8")
        .replace(/\0.*$/s, "");
    const name = field(0, 100);
    const prefix = field(345, 155);
    const size = parseInt(field(124, 12).trim() || "0", 8);
    const type = field(156, 1);
    if (type === "0" || type === "") names.push(prefix ? `${prefix}/${name}` : name);
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  return names;
}

function invoker(window: Page) {
  return <T>(command: string, args: Record<string, unknown> = {}) =>
    window.evaluate(
      ({ command, args }) =>
        (
          globalThis as typeof globalThis & {
            orkestrator: { invoke<R>(command: string, args?: Record<string, unknown>): Promise<R> };
          }
        ).orkestrator.invoke<T>(command, args),
      { command, args },
    );
}

type BundlePlan = {
  planId: string;
  fileName: string;
  archive: { bytes: number; sha256: string };
  manifest: { entries: Array<{ path: string }> };
};
type BundleChunk = { data: string; nextOffset: number | null };

test("the packaged app writes the essential log and reports a clean quit and a kill on the next start", async () => {
  test.setTimeout(420_000);
  const executablePath = packagedAppExecutable(repositoryRoot, process.env);
  expect(
    existsSync(executablePath),
    `No packaged app at ${executablePath}. Run \`mise run package:mac:unpacked:test\` first.`,
  ).toBe(true);
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "orkestrator-exit-marker-"));
  const [rendererPort, gatewayPort] = (await reserveLoopbackPorts(2)) as [number, number];
  const profile = resolveRuntimeProfile({
    repositoryRoot,
    requestedId: "exit-marker-packaged",
    flavor: "agent-test",
    rendererPort,
    gatewayPort,
    roots: {
      developmentRoot: path.join(temporaryRoot, "dev"),
      productionDataDir: path.join(temporaryRoot, "production"),
      homeDir: temporaryRoot,
    },
  });
  const profilePath = await initializeProfile(profile);
  const home = path.join(temporaryRoot, "home");
  await mkdir(home, { recursive: true });
  const evidence: Record<string, unknown> = { platform: process.platform, arch: process.arch };

  // Every app this test launched, so cleanup can prove each tree stopped.
  const launched: ElectronApplication[] = [];
  const owned = new Set<number>();
  const launch = async (): Promise<{ app: ElectronApplication; window: Page }> => {
    const app = await electron.launch({
      executablePath,
      args: [...ELECTRON_TEST_SWITCHES, ...packagedLaunchSwitches(process.platform)],
      cwd: temporaryRoot,
      env: packagedLaunchEnvironment(process.env, { home, profilePath }),
    });
    launched.push(app);
    recordElectronDiagnostics(app);
    const window = await openDesignWindow(app, profile, { title: "native", timeoutMs: 90_000 });
    const runtime = await app.evaluate(({ app: electronApp }) => ({
      isPackaged: electronApp.isPackaged,
      userData: electronApp.getPath("userData"),
    }));
    expect(runtime.isPackaged).toBe(true);
    expect(runtime.userData).toBe(profile.dataDir);
    return { app, window };
  };
  /** Until the latest start has written its `previous-run` line. */
  const waitForOutcomes = async (count: number): Promise<string[]> => {
    let outcomes: string[] = [];
    await expect
      .poll(
        async () => (outcomes = previousRunOutcomes(await readEssentialEntries(profile.dataDir))),
        { timeout: 60_000, intervals: [250] },
      )
      .toHaveLength(count);
    return outcomes;
  };

  await withCleanup(async () => {
    // 1. First start: the file writer in packaged paths, then a bundle, then a normal quit.
    const first = await launch();
    const essentialFile = path.join(profile.dataDir, "logs", "essential", "essential.jsonl");
    await expect
      .poll(
        async () =>
          (await readEssentialEntries(profile.dataDir)).some(
            (entry) => entry.event === "essential.started",
          ),
        { timeout: 30_000 },
      )
      .toBe(true);
    const mode = (await stat(essentialFile)).mode & 0o777;
    evidence.essentialFileMode = mode.toString(8);
    expect(mode).toBe(0o600);
    // A first run has no earlier run, so it writes no previous-run line.
    expect(previousRunOutcomes(await readEssentialEntries(profile.dataDir))).toEqual([]);

    const invoke = invoker(first.window);
    const plan = await invoke<BundlePlan>("plan_diagnostics_bundle", {});
    const pieces: Buffer[] = [];
    let offset: number | null = 0;
    while (offset !== null) {
      const chunk: BundleChunk = await invoke<BundleChunk>("read_diagnostics_bundle", {
        planId: plan.planId,
        offset,
      });
      pieces.push(Buffer.from(chunk.data, "base64"));
      offset = chunk.nextOffset;
    }
    const bundle = Buffer.concat(pieces);
    expect(bundle.byteLength).toBe(plan.archive.bytes);
    expect(createHash("sha256").update(bundle).digest("hex")).toBe(plan.archive.sha256);
    const names = tarEntryNames(bundle);
    const manifestPaths = plan.manifest.entries.map((entry) => entry.path);
    expect(names).toEqual(expect.arrayContaining(["manifest.json", "health-summary.json"]));
    expect(manifestPaths).toContain("logs/essential/essential.jsonl");
    expect(names.some((name) => name.endsWith("logs/essential/essential.jsonl"))).toBe(true);
    evidence.bundle = { bytes: plan.archive.bytes, files: names.length, pieces: pieces.length };

    const firstTree = electronProcessTree(first.app);
    for (const pid of firstTree) owned.add(pid);
    const quitAt = Date.now();
    await closeElectron(first.app, firstTree);
    evidence.quitMs = Date.now() - quitAt;
    const afterQuit = await readEssentialEntries(profile.dataDir);
    expect(afterQuit.some((entry) => entry.event === "essential.stopped")).toBe(true);

    // 2. Second start: the normal quit reads as clean. Then kill the app's own tree.
    const second = await launch();
    const afterClean = await waitForOutcomes(1);
    expect(afterClean).toEqual(["clean"]);
    const cleanLine = previousRunLine(await readEssentialEntries(profile.dataDir), 0);
    evidence.clean = { level: cleanLine.level, ranForMs: cleanLine.fields?.ranForMs };
    expect(cleanLine.level).toBe("info");
    expect(Number(cleanLine.fields?.ranForMs)).toBeGreaterThan(0);

    const secondTree = electronProcessTree(second.app);
    for (const pid of secondTree) owned.add(pid);
    // Only this test's own app and its descendants, snapshotted from its handle.
    for (const pid of secondTree) signalProcess(pid, "SIGKILL");
    await waitForStopped(secondTree, 15_000);

    // 3. Third start: the killed run reads as crashed.
    const third = await launch();
    const afterKill = await waitForOutcomes(2);
    expect(afterKill).toEqual(["clean", "crashed"]);
    const crashedLine = previousRunLine(await readEssentialEntries(profile.dataDir), 1);
    evidence.crashed = {
      level: crashedLine.level,
      ranForMs: crashedLine.fields?.ranForMs,
      lastSeenAgoMs: crashedLine.fields?.lastSeenAgoMs,
    };
    expect(crashedLine.level).toBe("warn");
    for (const pid of electronProcessTree(third.app)) owned.add(pid);

    test.info().annotations.push({ type: "exit marker", description: JSON.stringify(evidence) });
    const evidenceFile = path.join(
      repositoryRoot,
      "output",
      "agent-testing",
      "electron-packaged",
      "evidence-exit-marker-packaged.json",
    );
    await mkdir(path.dirname(evidenceFile), { recursive: true });
    await writeFile(
      evidenceFile,
      `${JSON.stringify({ recordedAt: new Date().toISOString(), ...evidence }, null, 2)}\n`,
    );
  }, [
    async () => {
      let snapshotFailed = false;
      await withCleanup(async () => {
        for (const app of launched) {
          let tree: number[];
          try {
            tree = electronProcessTree(app);
          } catch {
            snapshotFailed = true;
            continue;
          }
          for (const pid of tree) owned.add(pid);
          if (tree.length > 0) await closeElectron(app, tree);
        }
      }, [
        async () => {
          if (snapshotFailed) {
            throw new Error("Cannot remove profile without an owned-process snapshot");
          }
          await waitForStopped([...owned].filter(processAlive), 0);
          await rm(temporaryRoot, { recursive: true, force: true });
        },
      ]);
    },
  ]);
});

function previousRunLine(entries: readonly EssentialEntry[], index: number): EssentialEntry {
  const lines = entries.filter(
    (entry) => entry.area === "backend" && entry.event === "previous-run",
  );
  return lines[index]!;
}
