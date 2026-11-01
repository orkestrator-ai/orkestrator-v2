import { expect, type BrowserContext, type Page, type TestInfo } from "@playwright/test";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { loadAppWithDevRetry } from "./dev-startup-retry";

/**
 * Shared helpers for the container app wiring specs (todo 0048, task 4). They
 * drive a profile started with `--fixture-environments local,container`:
 * backend commands through the owner token, and changes written straight
 * into the container or worktree, never through a provider turn.
 */

const repositoryRoot = path.resolve(import.meta.dirname, "../..");
export const profile = process.env.ORKESTRATOR_AGENT_TEST_PROFILE ?? "codex-qa";
export const containerName =
  process.env.ORKESTRATOR_AGENT_TEST_CONTAINER_ENV ?? "fixture-container";
export const localName = process.env.ORKESTRATOR_AGENT_TEST_LOCAL_ENV ?? "fixture-local";
/** The Files panel poll (5 s), a read, and margin for a loaded host. */
export const POLL_BUDGET_MS = 20_000;

type Status = { browserUrl?: string; authFile?: string };
export type Environment = {
  id: string;
  name: string;
  projectId: string;
  environmentType: string;
  status?: string;
  containerId?: string | null;
  worktreePath?: string | null;
};

export function profileStatus(): Status {
  const command = spawnSync("mise", ["run", "dev:status", "--profile", profile, "--json"], {
    cwd: repositoryRoot,
    encoding: "utf8",
  });
  if (!command.stdout.trim()) throw new Error(command.stderr || "dev:status returned no manifest");
  return JSON.parse(command.stdout) as Status;
}

/** Calls a backend command with the owner token; keep traces off in callers. */
export async function invoke<T>(command: string, args: Record<string, unknown> = {}): Promise<T> {
  const status = profileStatus();
  const token = (JSON.parse(readFileSync(status.authFile!, "utf8")) as { token: string }).token;
  const response = await fetch(new URL("/__orkestrator/invoke", status.browserUrl!), {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ command, args }),
  });
  const payload = (await response.json()) as { result?: T; error?: string };
  if (!response.ok || payload.error) throw new Error(payload.error ?? `${command} failed`);
  return payload.result as T;
}

export async function fixtureEnvironment(name: string): Promise<Environment> {
  const projects = await invoke<Array<{ id: string }>>("get_projects");
  for (const project of projects) {
    const environments = await invoke<Environment[]>("get_environments", {
      projectId: project.id,
    });
    const match = environments.find((environment) => environment.name === name);
    if (match) return match;
  }
  throw new Error(`No fixture environment named ${name}`);
}

/**
 * Runs a shell script in the container's workspace, as the container user
 * unless `user` says otherwise. `input` is written to the script's stdin.
 */
export function inContainer(
  containerId: string,
  script: string,
  options: { user?: string; input?: string } = {},
): string {
  const result = spawnSync(
    "docker",
    [
      "exec",
      ...(options.input === undefined ? [] : ["-i"]),
      "-u",
      options.user ?? "node",
      "-w",
      "/workspace",
      containerId,
      "sh",
      "-c",
      script,
    ],
    { encoding: "utf8", input: options.input },
  );
  if (result.status !== 0) throw new Error(result.stderr || `docker exec failed: ${script}`);
  return result.stdout;
}

/** This host diagnostic can cover the app; acknowledge it without touching the firewall. */
export async function acknowledgeConnectivityWarning(page: Page, testInfo: TestInfo) {
  await page.addLocatorHandler(
    page.getByRole("dialog", { name: "Docker containers can't reach Orkestrator", exact: true }),
    async (dialog) => {
      testInfo.annotations.push({
        type: "environment",
        description: "Acknowledged container-to-host connectivity warning.",
      });
      await dialog.getByRole("button", { name: "Close", exact: true }).last().click();
    },
  );
}

export async function login(page: Page, testInfo: TestInfo) {
  await acknowledgeConnectivityWarning(page, testInfo);
  // The one-shot login URL is parsed in memory and never copied into output.
  const command = spawnSync("mise", ["run", "dev:login", "--profile", profile, "--json"], {
    cwd: repositoryRoot,
    encoding: "utf8",
  });
  if (command.status !== 0) throw new Error(command.stderr || "dev:login failed");
  const { loginUrl } = JSON.parse(command.stdout) as { loginUrl?: unknown };
  if (typeof loginUrl !== "string") throw new Error("dev:login returned no login URL");
  await loadAppWithDevRetry(page, testInfo, () =>
    page.goto(loginUrl, { waitUntil: "domcontentloaded" }),
  );
}

/** A second window in the same signed-in browser context. */
export async function openSecondWindow(context: BrowserContext, testInfo: TestInfo) {
  const second = await context.newPage();
  await second.setViewportSize({ width: 1400, height: 900 });
  await acknowledgeConnectivityWarning(second, testInfo);
  await loadAppWithDevRetry(second, testInfo, () =>
    second.goto(profileStatus().browserUrl!, { waitUntil: "domcontentloaded" }),
  );
  return second;
}

/** A reload, retried once for the dev server's flake 0167 like the first load. */
export async function reloadApp(page: Page, testInfo: TestInfo) {
  await loadAppWithDevRetry(page, testInfo, () => page.reload({ waitUntil: "domcontentloaded" }));
}

export async function selectEnvironment(page: Page, name: string) {
  const expand = page.getByRole("button", { name: /^Expand project / }).first();
  const collapse = page.getByRole("button", { name: /^Collapse project / }).first();
  await expect(expand.or(collapse)).toBeVisible({ timeout: 30_000 });
  if (await expand.isVisible()) await expand.click();
  const item = page.getByText(name, { exact: true }).first();
  await expect(item).toBeVisible({ timeout: 15_000 });
  await item.click();
}

/**
 * Makes the read coordinator see a hidden (or visible again) document. A real
 * hidden tab also throttles timers; the coordinator decides from
 * `visibilityState` and the `visibilitychange` event, which this drives.
 */
export async function setDocumentHidden(page: Page, hidden: boolean) {
  await page.evaluate((next) => {
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => (next ? "hidden" : "visible"),
    });
    Object.defineProperty(document, "hidden", { configurable: true, get: () => next });
    document.dispatchEvent(new Event("visibilitychange"));
  }, hidden);
}
