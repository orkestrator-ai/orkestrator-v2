/**
 * The Schedules notice with two real backends on one data directory, live
 * (to-do 5160 task 3). Opt-in (`ORKESTRATOR_AGENT_TEST_LIVE_TWO_BACKENDS=1`)
 * against a running credential-free agent-test profile, which it leaves
 * needing a restart (its backend loses the writer lease for good):
 *
 *   env -u DISPLAY -u WAYLAND_DISPLAY ORKESTRATOR_HOST_REACHABILITY_CHECK=off \
 *     mise run dev:test --profile ork-sched --fixture --no-agent-credentials \
 *     --no-host-seed --headless --agent-platforms pi
 *   ORKESTRATOR_AGENT_TEST_PROFILE=ork-sched ORKESTRATOR_AGENT_TEST_LIVE_TWO_BACKENDS=1 \
 *     mise run test:logged -- --name two-backends -- bunx playwright test \
 *     --config e2e/agent-testing/playwright.browser.config.ts schedules-two-backends-live.spec.ts
 *   mise run dev:stop --profile ork-sched && mise run dev:reset --profile ork-sched
 *
 * No provider turn. It turns scheduling on, saves one operator schedule due
 * in 2099 (so nothing fires), and reads Settings → Schedules:
 *
 * 1. on the profile's own backend, which holds the writer lease: no notice;
 * 2. on a second backend this spec starts on the same data directory, with
 *    the profile backend's own arguments and only another gateway port and
 *    its own gateway token: the `another-backend` notice;
 * 3. on the first backend again, after the lease file is overwritten under a
 *    token neither backend holds, as a process reclaiming it would: the open
 *    view rereads on the `scheduled-job` announcement and shows the
 *    `writer-lease-lost` notice, with no reload;
 * 4. on the second backend again: nothing refreshes the written lease, so it
 *    goes stale and the second backend, which kept trying, wins it
 *    (`ReclaimingRegistryWriter`). Its open view drops the notice with no
 *    reload and it fires; the first backend stays lost.
 *
 * The second backend runs in a process group this spec creates and is
 * stopped through it. The schedule is deleted, the setting restored and the
 * written lease removed if it still holds this run's token. Screenshots go to
 * `output/visual-previews/5160-schedules-*.png`, and the answers of
 * `list_scheduled_jobs` to `output/agent-testing/<run>/schedules-two-backends.json`.
 */
import {
  expect,
  fetchModulesOutsideChromium,
  test,
  type BrowserContext,
  type Page,
} from "./browser-test";
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { schedulerPausedMessage } from "@orkestrator/protocol/scheduled-jobs";
import {
  authenticatedInvoke,
  profileStatus,
  repositoryRoot,
  type Environment,
  type Invoke,
  type Project,
  type Status,
} from "./slash-command-live-support";
import { pairingPorts } from "./design-renderer-pairing-support";
import {
  backendArgsFromCmdline,
  secondBackendArgs,
  takeoverLease,
} from "./schedules-two-backends-support";

const LIVE = process.env.ORKESTRATOR_AGENT_TEST_LIVE_TWO_BACKENDS === "1";
const profile = process.env.ORKESTRATOR_AGENT_TEST_PROFILE ?? "ork-sched";
const runId = process.env.ORKESTRATOR_AGENT_TEST_RUN_ID ?? profile;
const BACKEND_ENTRY = path.join(repositoryRoot, "apps", "backend", "src", "main.ts");
const LEASE_FILE = "container-lifecycle.writer.lease";

type FullStatus = Status & { pids?: { backend?: number } };
type ListAnswer = { schedules: Array<{ id: string }>; scheduler?: unknown };

test.use({ trace: "off", screenshot: "off" });

function stopGroup(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null || child.pid === undefined) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      try {
        process.kill(-child.pid!, "SIGKILL");
      } catch {
        // Already gone.
      }
    }, 15_000);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
    try {
      // The group this spec created for the second backend, and only it.
      process.kill(-child.pid!, "SIGTERM");
    } catch {
      clearTimeout(timer);
      resolve();
    }
  });
}

async function openSchedules(page: Page) {
  for (const name of ["Continue Without Docker", "Continue Without Claude", "Hide"]) {
    const button = page.getByRole("button", { name, exact: true });
    if (await button.isVisible().catch(() => false)) await button.click().catch(() => undefined);
  }
  await page.getByRole("button", { name: "Global settings", exact: true }).click();
  await page
    .getByRole("navigation", { name: "Settings sections" })
    .getByRole("button", { name: "Schedules", exact: true })
    .click();
  await expect(page.getByText("5160 two-backend notice").first()).toBeVisible({ timeout: 30_000 });
}

async function shot(page: Page, name: string) {
  const file = path.join(repositoryRoot, "output", "visual-previews", `5160-schedules-${name}.png`);
  mkdirSync(path.dirname(file), { recursive: true });
  await page.screenshot({ path: file });
}

test.describe("the Schedules notice with two backends on one data directory", () => {
  test.skip(!LIVE, "opt-in live check that leaves the profile needing a restart");

  test("held, another backend, and a lease taken over", async ({ page, browser }) => {
    test.setTimeout(600_000);
    await page.setViewportSize({ width: 1440, height: 1000 });
    const status = profileStatus(profile) as FullStatus;
    expect(status.profile).toBe(profile);
    expect(status.status).toBe("ready");
    expect(status.flavor).toBe("agent-test");
    const dataDir = status.dataDir!;
    const invoke: Invoke = await authenticatedInvoke(page, status, profile);
    const record: Record<string, unknown> = { profile, startedAt: new Date().toISOString() };
    const writeRecord = () => {
      const file = path.join(
        repositoryRoot,
        "output",
        "agent-testing",
        runId,
        "schedules-two-backends.json",
      );
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`);
    };

    const config = await invoke<{ global?: Record<string, unknown> }>("get_config");
    const hadScheduling = Object.hasOwn(config.global ?? {}, "experimentalScheduling");
    const scheduling = config.global?.experimentalScheduling;
    let scheduleId: string | undefined;
    let targetId: string | undefined;
    let second: ChildProcess | undefined;
    let secondContext: BrowserContext | undefined;
    let takeoverToken: string | undefined;
    try {
      await invoke("patch_global_config", { patch: { experimentalScheduling: true } });
      const fixture = (await invoke<Project[]>("get_projects")).find(
        (project) => project.localPath === status.testProject,
      );
      expect(fixture, "the fixture project is missing").toBeTruthy();
      // The schedule's target; never started, deleted with the schedule.
      const target = await invoke<Environment>("create_environment", {
        projectId: fixture!.id,
        name: `schedule-target-${Date.now()}`,
        environmentType: "local",
        networkAccessMode: "restricted",
      });
      targetId = target.id;
      const created = await invoke<{ schedule: { id: string } }>("create_scheduled_job", {
        name: "5160 two-backend notice",
        at: "2099-10-26T03:12:00.000Z",
        action: {
          kind: "prompt",
          environmentId: target.id,
          tabId: "schedule-qa",
          prompt: "Nothing: this schedule is due in 2099.",
        },
      });
      scheduleId = created.schedule.id;

      // 1. The profile's own backend holds the lease.
      record.first = (await invoke<ListAnswer>("list_scheduled_jobs")).scheduler;
      expect(record.first).toEqual({ firing: true });
      await page.goto(status.browserUrl!);
      await openSchedules(page);
      await expect(page.getByTestId("scheduler-paused")).toHaveCount(0);
      await shot(page, "first-backend-holding");

      // 2. A second backend on the same data directory.
      const pid = status.pids?.backend;
      expect(pid, "dev:status names no backend pid").toBeTruthy();
      const firstArgs = backendArgsFromCmdline(
        readFileSync(`/proc/${pid}/cmdline`, "utf8"),
        BACKEND_ENTRY,
      );
      expect(firstArgs).toContain(dataDir);
      // Random free ports, never the installed app's.
      const [port] = (await pairingPorts(1)) as [number];
      const token = randomBytes(32).toString("base64url");
      const scratch = path.join(path.dirname(dataDir), "second-backend");
      for (const directory of ["home", "tmp"]) {
        mkdirSync(path.join(scratch, directory), { recursive: true, mode: 0o700 });
      }
      const home = path.join(scratch, "home");
      const env: Record<string, string> = {
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        LANG: process.env.LANG ?? "C.UTF-8",
        HOME: home,
        XDG_CONFIG_HOME: path.join(home, ".config"),
        XDG_DATA_HOME: path.join(home, ".local", "share"),
        XDG_STATE_HOME: path.join(home, ".local", "state"),
        TMPDIR: path.join(scratch, "tmp"),
        GIT_CONFIG_NOSYSTEM: "1",
        ORKESTRATOR_GATEWAY_TOKEN: token,
        ORKESTRATOR_GATEWAY_DISABLED: "0",
        ORKESTRATOR_CONTROL_MCP_PORT: "0",
        ORKESTRATOR_AGENT_TEST_ISOLATED: "1",
        ORKESTRATOR_HOST_REACHABILITY_CHECK: "off",
        ...(process.env.DOCKER_HOST ? { DOCKER_HOST: process.env.DOCKER_HOST } : {}),
      };
      let stderr = "";
      second = spawn("bun", [BACKEND_ENTRY, ...secondBackendArgs(firstArgs, port)], {
        cwd: repositoryRoot,
        detached: true,
        env,
        stdio: ["ignore", "ignore", "pipe"],
      });
      second.stderr?.on("data", (chunk: Buffer) => {
        stderr = (stderr + chunk.toString()).slice(-8_192);
      });
      const origin = `http://127.0.0.1:${port}`;
      const invokeSecond = async <T>(command: string, args: Record<string, unknown> = {}) => {
        const response = await fetch(`${origin}/__orkestrator/invoke`, {
          method: "POST",
          headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
          body: JSON.stringify({ command, args }),
          signal: AbortSignal.timeout(10_000),
        });
        if (!response.ok) throw new Error(`${command}: HTTP ${response.status}`);
        return ((await response.json()) as { result: T }).result;
      };
      await expect
        .poll(
          async () => {
            if (second!.exitCode !== null) {
              throw new Error(
                `the second backend exited: ${stderr.match(/\w*Error: [^\n]*/u)?.[0] ?? "no error line"}`,
              );
            }
            return invokeSecond<ListAnswer>("list_scheduled_jobs").then(
              (answer) => answer.schedules.some((schedule) => schedule.id === scheduleId),
              () => false,
            );
          },
          { timeout: 180_000, intervals: [1_000] },
        )
        .toBe(true);
      record.second = (await invokeSecond<ListAnswer>("list_scheduled_jobs")).scheduler;
      expect(record.second).toEqual({ firing: false, reason: "another-backend" });
      record.firstWhileSecondRuns = (await invoke<ListAnswer>("list_scheduled_jobs")).scheduler;
      expect(record.firstWhileSecondRuns).toEqual({ firing: true });
      writeRecord();

      const secondBrowser = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
      // Closed in `finally` with everything else this run started.
      secondContext = secondBrowser;
      await fetchModulesOutsideChromium(secondBrowser);
      const login = await secondBrowser.request.post(`${origin}/__orkestrator/login`, {
        form: { token },
        maxRedirects: 0,
      });
      expect(login.status(), "the second backend refused its own token").toBeLessThan(400);
      const secondPage = await secondBrowser.newPage();
      await secondPage.goto(origin);
      await openSchedules(secondPage);
      await expect(secondPage.getByTestId("scheduler-paused")).toHaveText(
        schedulerPausedMessage("another-backend"),
        { timeout: 30_000 },
      );
      await shot(secondPage, "second-backend");

      // 3. The lease is taken over while the first backend's view is open.
      await expect(page.getByTestId("scheduler-paused")).toHaveCount(0);
      const leasePath = path.join(dataDir, LEASE_FILE);
      const takeover = takeoverLease(second.pid!);
      takeoverToken = takeover.token;
      const temporary = `${leasePath}.qa-${process.pid}.tmp`;
      writeFileSync(temporary, takeover.body, { mode: 0o600 });
      renameSync(temporary, leasePath);
      const takenAt = Date.now();
      // No reload: the loss is announced and the open view rereads.
      await expect(page.getByTestId("scheduler-paused")).toHaveText(
        schedulerPausedMessage("writer-lease-lost"),
        { timeout: 60_000 },
      );
      record.rereadMs = Date.now() - takenAt;
      record.firstAfterTakeover = (await invoke<ListAnswer>("list_scheduled_jobs")).scheduler;
      expect(record.firstAfterTakeover).toEqual({ firing: false, reason: "writer-lease-lost" });
      record.secondAfterTakeover = (
        await invokeSecond<ListAnswer>("list_scheduled_jobs")
      ).scheduler;
      await shot(page, "first-backend-lease-lost");
      writeRecord();

      // 4. Nothing refreshes the written lease, so it goes stale (30 s) and
      // the second backend, which kept trying, wins it: its open view drops
      // the notice with no reload, and the first stays lost.
      await expect(secondPage.getByTestId("scheduler-paused")).toHaveCount(0, {
        timeout: 120_000,
      });
      record.secondTookOverMs = Date.now() - takenAt;
      record.secondAfterStale = (await invokeSecond<ListAnswer>("list_scheduled_jobs")).scheduler;
      expect(record.secondAfterStale).toEqual({ firing: true });
      record.firstAfterStale = (await invoke<ListAnswer>("list_scheduled_jobs")).scheduler;
      expect(record.firstAfterStale).toEqual({ firing: false, reason: "writer-lease-lost" });
      await shot(secondPage, "second-backend-took-over");
      writeRecord();
    } finally {
      await secondContext?.close().catch(() => undefined);
      if (second) await stopGroup(second);
      if (takeoverToken) {
        const leasePath = path.join(dataDir, LEASE_FILE);
        try {
          const current = JSON.parse(readFileSync(leasePath, "utf8")) as { token?: string };
          if (current.token === takeoverToken) rmSync(leasePath, { force: true });
        } catch {
          // Already gone.
        }
      }
      if (scheduleId) {
        await invoke("delete_scheduled_job", { scheduleId }).catch(() => undefined);
      }
      if (targetId) {
        await invoke("delete_environment", { environmentId: targetId }).catch(() => undefined);
      }
      await invoke(
        "patch_global_config",
        hadScheduling
          ? { patch: { experimentalScheduling: scheduling } }
          : { patch: {}, unset: ["experimentalScheduling"] },
      ).catch(() => undefined);
      record.finishedAt = new Date().toISOString();
      writeRecord();
    }
  });
});
