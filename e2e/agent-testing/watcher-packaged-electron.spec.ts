/**
 * The worktree watcher in the packaged app (todo 0048 task 7,
 * docs/todo/transcripts-and-observation/0048-recurring-work-qualification.md):
 * the app's own executable, `app.asar` and the bundled Bun backend, which on
 * macOS keeps its directory watches in a helper it spawns from its own
 * `process.execPath` (`watch-host.ts`). A dev profile runs that helper from
 * the developer's Bun, so only a packaged run shows the bundled one starts it.
 *
 * Build the app first (`mise run package:mac:unpacked:test`, or
 * `package:linux:unpacked:test`); `mise run test:agent:electron:packaged` runs
 * it. It runs on a disposable agent-test profile under a temporary root with
 * an allowlisted environment (packaged-electron-app.ts), with a local Git
 * repository of its own, so nothing reaches the user's data directory. The
 * host reachability probe is off: a local environment needs no Docker.
 *
 * It checks that a local environment becomes watched, that a save reaches the
 * sidebar badge within the watched budget, that a burst past the watcher's
 * overflow threshold and the scan's untracked cap still converges, and on macOS that the helper is the
 * bundled Bun and is replaced after it dies. Output is counts and milliseconds,
 * also written to `output/agent-testing/electron-packaged/evidence-watcher-packaged.json`.
 */
import { expect, test } from "./electron-fixtures";
import { _electron as electron } from "playwright";
import type { ElectronApplication, Page } from "playwright";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { resolveRuntimeProfile } from "../../apps/desktop/electron/runtime-profile";
import { initializeProfile, reserveLoopbackPorts } from "../../apps/desktop/scripts/dev/profile-io";
import { closeElectron, electronProcessTree } from "./design-electron-cleanup";
import { openDesignWindow } from "./design-canvas-electron-journey";
import { recordElectronDiagnostics } from "./electron-diagnostics";
import { ELECTRON_TEST_SWITCHES } from "./electron-launch-switches";
import { waitForStopped, withCleanup } from "../process-cleanup";
import {
  packagedAppExecutable,
  packagedLaunchEnvironment,
  packagedLaunchSwitches,
} from "./packaged-electron-app";

const repositoryRoot = path.resolve(import.meta.dirname, "../..");
/**
 * docs/architecture/recurring-work.md, "Latency budgets" (p95). The watched
 * budget runs from when the save settles (`WATCH_SETTLE_MS`, 400 ms), and
 * saves are timed from the write, so the bound here includes the settle.
 */
const WATCH_SETTLE_MS = 400;
const WATCHED_DIFF_MS = 2_000 + WATCH_SETTLE_MS;
const UNWATCHED_DIFF_MS = 20_000;
const BURST_FILES = 20_000;
/** Enough saves that the budget's p95 allows one slow sample. */
const SAVES = 20;

function p95(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(0.95 * sorted.length) - 1)]!;
}

type Environment = { id: string; name: string; worktreePath?: string | null };

function git(cwd: string, ...args: string[]): void {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git ${args[0]} failed: ${result.stderr.trim()}`);
}

/** A bare origin with one commit on `main`, and a clone for the project. */
async function makeRepository(root: string): Promise<{ origin: string; checkout: string }> {
  const seed = path.join(root, "seed");
  const origin = path.join(root, "origin.git");
  const checkout = path.join(root, "project");
  await mkdir(seed, { recursive: true });
  git(root, "init", "--quiet", "--bare", "--initial-branch=main", origin);
  git(seed, "init", "--quiet", "--initial-branch=main");
  git(seed, "config", "user.email", "watcher-packaged@example.invalid");
  git(seed, "config", "user.name", "watcher-packaged");
  await writeFile(path.join(seed, "README.md"), "fixture\n");
  git(seed, "add", "README.md");
  git(seed, "commit", "--quiet", "-m", "fixture");
  git(seed, "push", "--quiet", origin, "main");
  git(root, "clone", "--quiet", origin, checkout);
  return { origin, checkout };
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

/**
 * Untracked files the backend line-counts per scan (`UNTRACKED_SCAN_MAX_FILES`,
 * apps/backend/src/core/commands-validation.ts). Past it the badge is
 * approximate and its tooltip names the cap, so a bigger burst can never show
 * an exact `+N`.
 */
const CAPPED_REASON = "Too many untracked files to count them all";

async function badgeState(
  page: Page,
  environmentName: string,
): Promise<{ additions: number | null; capped: boolean }> {
  const badge = await page
    .evaluate((name) => {
      for (const label of Array.from(document.querySelectorAll("span[id]"))) {
        if (label.textContent !== name) continue;
        const element = label
          .closest('[role="button"]')
          ?.querySelector<HTMLElement>('[data-testid="environment-change-badge"]');
        if (element) return { text: element.textContent, title: element.title };
      }
      return null;
    }, environmentName)
    .catch(() => null);
  const match = /\+([\d,]+)/.exec(badge?.text ?? "");
  return {
    additions: match ? Number(match[1]!.replaceAll(",", "")) : null,
    capped: Boolean(badge?.title.includes(CAPPED_REASON)),
  };
}

async function badgeAdditions(page: Page, environmentName: string): Promise<number | null> {
  return (await badgeState(page, environmentName)).additions;
}

async function msUntil(
  since: number,
  done: () => Promise<boolean>,
  label: string,
  timeoutMs: number,
) {
  for (;;) {
    if (await done()) return Date.now() - since;
    if (Date.now() - since > timeoutMs) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

/** The watch helper among the app's own descendants: `<bun> -e <watch-host program>`. */
function watchHelper(app: ElectronApplication): { pid: number; executable: string } | null {
  const owned = new Set(electronProcessTree(app));
  const listing = spawnSync("ps", ["-ww", "-A", "-o", "pid=,command="], {
    encoding: "utf8",
  }).stdout;
  for (const line of listing.split("\n")) {
    const match = /^\s*(\d+)\s+(\S+) -e (.*)$/.exec(line);
    if (!match || !owned.has(Number(match[1]))) continue;
    if (!match[3]!.includes('require("node:fs")')) continue;
    return { pid: Number(match[1]), executable: match[2]! };
  }
  return null;
}

test("the packaged app watches a local worktree, follows a burst and replaces a lost watch helper", async () => {
  test.setTimeout(420_000);
  const executablePath = packagedAppExecutable(repositoryRoot, process.env);
  expect(
    existsSync(executablePath),
    `No packaged app at ${executablePath}. Run \`mise run package:mac:unpacked:test\` first.`,
  ).toBe(true);
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "orkestrator-watcher-packaged-"));
  let app: ElectronApplication | null = null;
  const [rendererPort, gatewayPort] = (await reserveLoopbackPorts(2)) as [number, number];
  const profile = resolveRuntimeProfile({
    repositoryRoot,
    requestedId: "watcher-packaged",
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
  const repository = await makeRepository(path.join(temporaryRoot, "repo"));
  await withCleanup(async () => {
    app = await electron.launch({
      executablePath,
      args: [...ELECTRON_TEST_SWITCHES, ...packagedLaunchSwitches(process.platform)],
      cwd: temporaryRoot,
      env: packagedLaunchEnvironment(process.env, { home, profilePath }),
    });
    recordElectronDiagnostics(app);
    const launched = app;
    const window = await openDesignWindow(launched, profile, {
      title: "native",
      timeoutMs: 60_000,
    });
    const runtime = await launched.evaluate(({ app: electronApp }) => ({
      isPackaged: electronApp.isPackaged,
      userData: electronApp.getPath("userData"),
    }));
    expect(runtime.isPackaged).toBe(true);
    expect(runtime.userData).toBe(profile.dataDir);
    const invoke = invoker(window);

    const project = await invoke<{ id: string; name: string }>("add_project", {
      gitUrl: repository.origin,
      localPath: repository.checkout,
    });
    const created = await invoke<Environment>("create_environment", {
      projectId: project.id,
      name: `watched-${Date.now()}`,
      networkAccessMode: "restricted",
      environmentType: "local",
    });
    await invoke("start_environment", { environmentId: created.id });
    const environment = await invoke<Environment>("get_environment", { environmentId: created.id });
    const worktree = environment.worktreePath!;
    expect(worktree).toBeTruthy();

    const watched = async () => {
      const diagnostics = await invoke<{
        caches: Array<{ name: string; gauges: Record<string, number> }>;
      }>("get_recurring_work_diagnostics");
      return (
        diagnostics.caches.find((entry) => entry.name === "worktree-snapshots")?.gauges.watched ?? 0
      );
    };
    const startedAt = Date.now();
    const watchedMs = await msUntil(
      startedAt,
      async () => (await watched()) >= 1,
      "watched",
      60_000,
    );

    await window.reload();
    const expand = window.getByRole("button", { name: `Expand project ${project.name}` });
    const entry = window.getByText(environment.name, { exact: true }).first();
    await expect(expand.or(entry)).toBeVisible({ timeout: 30_000 });
    // A startup dialog that opens over the sidebar can take the first click.
    await expect(async () => {
      if (await expand.isVisible()) await expand.click();
      await expect(entry).toBeVisible({ timeout: 5_000 });
    }).toPass({ timeout: 60_000 });

    const save = async (name: string, lineCount: number, budgetMs: number) => {
      const before = (await badgeAdditions(window, environment.name)) ?? 0;
      const at = Date.now();
      await writeFile(
        path.join(worktree, name),
        Array.from({ length: lineCount }, (_, index) => `${index}`).join("\n") + "\n",
      );
      return msUntil(
        at,
        async () => (await badgeAdditions(window, environment.name)) === before + lineCount,
        name,
        budgetMs * 3,
      );
    };
    const saves: number[] = [];
    for (let index = 0; index < SAVES; index += 1)
      saves.push(await save(`save-${index}.txt`, 2, WATCHED_DIFF_MS));

    // A burst past the watcher's overflow threshold.
    const before = (await badgeAdditions(window, environment.name)) ?? 0;
    const burst = path.join(worktree, "burst");
    for (let start = 0; start < BURST_FILES; start += 500) {
      await mkdir(path.join(burst, `d${start}`), { recursive: true });
    }
    for (let start = 0; start < BURST_FILES; start += 256) {
      await Promise.all(
        Array.from({ length: Math.min(256, BURST_FILES - start) }, (_, offset) => {
          const index = start + offset;
          return writeFile(
            path.join(burst, `d${Math.floor(index / 500) * 500}`, `f${index}.txt`),
            "x\n",
          );
        }),
      );
    }
    // Past the scan cap the first capped badge is "shown"; removing the burst
    // back to the exact earlier count proves no final change was lost.
    const burstAt = Date.now();
    const burstMs = await msUntil(
      burstAt,
      async () => (await badgeState(window, environment.name)).capped,
      "burst",
      120_000,
    );
    const removedAt = Date.now();
    await rm(burst, { recursive: true, force: true });
    const burstRemovedMs = await msUntil(
      removedAt,
      async () => {
        const badge = await badgeState(window, environment.name);
        return !badge.capped && (badge.additions ?? 0) === before;
      },
      "burst removal",
      120_000,
    );

    const result: Record<string, unknown> = {
      platform: process.platform,
      watchedAfterStartMs: watchedMs,
      saveMs: saves,
      saveP95Ms: p95(saves),
      burstFiles: BURST_FILES,
      burstAfterLastWriteMs: burstMs,
      exactAfterRemovalMs: burstRemovedMs,
    };
    if (process.platform === "darwin") {
      const helper = watchHelper(launched);
      expect(helper, "no watch helper among the packaged app's processes").not.toBeNull();
      // The bundled Bun, inside the app bundle: not the developer's.
      const bundle = executablePath.slice(0, executablePath.indexOf(".app/") + ".app/".length);
      result.helperIsBundledBun = helper!.executable.startsWith(bundle);
      expect(result.helperIsBundledBun).toBe(true);
      // The helper is one of this app's own descendants (above), so it is ours to signal.
      const killedAt = Date.now();
      process.kill(helper!.pid, "SIGKILL");
      result.fallbackMs = await msUntil(
        killedAt,
        async () => (await watched()) === 0,
        "fallback",
        30_000,
      );
      result.pollingSaveMs = await save("polling.txt", 2, UNWATCHED_DIFF_MS);
      result.reattachMs = await msUntil(
        killedAt,
        async () => (await watched()) >= 1,
        "re-attach",
        300_000,
      );
      const replacement = watchHelper(launched);
      result.helperReplaced = replacement !== null && replacement.pid !== helper!.pid;
      expect(result.helperReplaced).toBe(true);
      result.saveAfterRetryMs = await save("after-retry.txt", 2, WATCHED_DIFF_MS);
    }
    test.info().annotations.push({ type: "packaged watcher", description: JSON.stringify(result) });
    const evidence = path.join(
      repositoryRoot,
      "output",
      "agent-testing",
      "electron-packaged",
      "evidence-watcher-packaged.json",
    );
    await mkdir(path.dirname(evidence), { recursive: true });
    await writeFile(
      evidence,
      `${JSON.stringify({ recordedAt: new Date().toISOString(), ...result }, null, 2)}\n`,
    );
    // The budget is a p95 (docs/architecture/recurring-work.md).
    expect(p95(saves)).toBeLessThanOrEqual(WATCHED_DIFF_MS);
  }, [
    async () => {
      let owned: number[] | undefined = app ? undefined : [];
      await withCleanup(async () => {
        if (app) {
          owned = electronProcessTree(app);
          await closeElectron(app, owned);
        }
      }, [
        async () => {
          if (!owned) throw new Error("Cannot remove profile without an owned-process snapshot");
          await waitForStopped(owned, 0);
          await rm(temporaryRoot, { recursive: true, force: true });
        },
      ]);
    },
  ]);
});
