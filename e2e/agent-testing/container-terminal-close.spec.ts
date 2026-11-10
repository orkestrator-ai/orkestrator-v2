import { expect, test, type Page } from "./browser-test";
import { spawnSync } from "node:child_process";
import path from "node:path";
import {
  containerProcessesInSessions,
  containerSessionsRunning,
  recordedTerminalShellPids,
} from "./container-terminal-processes";
import { terminalVisibleText } from "./terminal-visible-text";

/**
 * Closing a container terminal ends its shell and everything under it in the
 * container, not only the host's `docker exec -it` client (Docker keeps an
 * exec running after its client is gone). Driven through the backend's own
 * terminal commands against a profile started with
 * `--fixture-environments local,container`; no agent, no login and no traffic
 * from the container to the host.
 *
 * The test's shell is found by session ID: it is the session leader of its
 * TTY, so the shell and the job it runs share one. After `detach_terminal`
 * nothing in that session may be left, and the shell's PID record must be
 * gone too. The report is content-free: counts only.
 */

const repositoryRoot = path.resolve(import.meta.dirname, "../..");
const profile = process.env.ORKESTRATOR_AGENT_TEST_PROFILE ?? "codex-qa";
const environmentName =
  process.env.ORKESTRATOR_AGENT_TEST_ROOT_TERMINAL_ENVIRONMENT ?? "fixture-container";

type Status = { status: string; browserUrl: string };
type Invoke = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;

function profileCommand<T>(command: string): T {
  const result = spawnSync("mise", ["run", command, "--profile", profile, "--json"], {
    cwd: repositoryRoot,
    encoding: "utf8",
    timeout: 60_000,
  });
  if (result.status !== 0) throw new Error(result.stderr || `${command} failed`);
  return JSON.parse(result.stdout) as T;
}

/**
 * Signs the browser context in without rendering the app: this spec needs only
 * the session cookie. The request client runs outside Chromium, so Docker
 * network churn on a Linux host (flake 2340) cannot abort it.
 */
async function login(page: Page, status: Status): Promise<Invoke> {
  // The one-shot login URL is parsed in memory and never copied into output.
  const { loginUrl } = profileCommand<{ loginUrl?: unknown }>("dev:login");
  if (typeof loginUrl !== "string") throw new Error("dev:login returned no login URL");
  const request = page.context().request;
  const exchange = await request.get(loginUrl, { maxRedirects: 0 });
  expect(exchange.status(), "the login exchange was refused").toBeLessThan(400);
  return async <T>(command: string, args: Record<string, unknown> = {}): Promise<T> => {
    const response = await request.post(new URL("/__orkestrator/invoke", status.browserUrl).href, {
      data: { command, args },
    });
    expect(response.ok(), `${command} failed`).toBe(true);
    return ((await response.json()) as { result: T }).result;
  };
}

test.skip(process.env.ORKESTRATOR_AGENT_TEST_DOCKER !== "1", "Docker fixture profile required");

test("Docker fixture closing a container terminal ends its shell and jobs in the container", async ({
  page,
}, testInfo) => {
  test.setTimeout(3 * 60_000);
  const status = profileCommand<Status>("dev:status");
  expect(status.status).toBe("ready");
  const invoke = await login(page, status);

  let environment: { id: string; name: string; containerId?: string | null } | undefined;
  for (const project of await invoke<Array<{ id: string }>>("get_projects")) {
    environment = (
      await invoke<Array<{ id: string; name: string; containerId?: string | null }>>(
        "get_environments",
        { projectId: project.id },
      )
    ).find((entry) => entry.name === environmentName);
    if (environment) break;
  }
  expect(environment?.containerId, `${environmentName} has no container`).toBeTruthy();
  const containerId = environment!.containerId!;

  const shellsBefore = containerSessionsRunning(containerId, "zsh");
  const { sessionId } = await invoke<{ sessionId: string }>("create_terminal_session", {
    containerId,
    environmentId: environment!.id,
    terminalKey: `terminal-close-${Date.now()}`,
    cols: 100,
    rows: 30,
  });
  let closed = false;
  try {
    await invoke("start_terminal_session", { sessionId });
    const output = async () =>
      terminalVisibleText(
        (await invoke<{ output: string }>("get_terminal_output_snapshot", { sessionId })).output,
      );
    // The image's zsh prompt ends with ❯; wait for it so no input is lost.
    await expect
      .poll(async () => /[#$%>❯]\s*$/.test((await output()).trimEnd()), {
        timeout: 60_000,
      })
      .toBe(true);

    let session: number | undefined;
    await expect
      .poll(
        () => {
          const added = [...containerSessionsRunning(containerId, "zsh")].filter(
            (sid) => !shellsBefore.has(sid),
          );
          session = added.length === 1 ? added[0] : undefined;
          return added.length;
        },
        { timeout: 15_000 },
      )
      .toBe(1);
    const sessions = new Set([session!]);

    // A foreground job: zsh's job control gives it a process group of its own.
    await invoke("terminal_write", { sessionId, data: "sleep 4321\r" });
    await expect
      .poll(
        () =>
          containerProcessesInSessions(containerId, sessions)
            .map((entry) => entry.comm)
            .sort(),
        { timeout: 15_000 },
      )
      .toEqual(["sleep", "zsh"]);
    expect(recordedTerminalShellPids(containerId)).toContain(session);

    await invoke("detach_terminal", { sessionId });
    closed = true;
    expect(
      (await invoke<{ running: boolean }>("get_terminal_session", { sessionId })).running,
    ).toBe(false);
    expect(await invoke<string[]>("list_terminal_sessions")).not.toContain(sessionId);

    // Neither the shell nor its job is left in the container.
    await expect
      .poll(() => containerProcessesInSessions(containerId, sessions).length, {
        timeout: 15_000,
      })
      .toBe(0);
    expect(recordedTerminalShellPids(containerId)).not.toContain(session);
    await testInfo.attach("container-terminal-close.json", {
      body: JSON.stringify({ leftInSession: 0, recordsLeft: 0 }),
      contentType: "application/json",
    });
  } finally {
    if (!closed) await invoke("detach_terminal", { sessionId }).catch(() => undefined);
  }
});
