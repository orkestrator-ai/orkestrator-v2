import { expect, test } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";

type Status = {
  status: string;
  browserUrl?: string;
  authFile?: string;
  testProject?: string;
};
type Project = { id: string; name: string; localPath: string | null };
type Environment = { id: string; worktreePath?: string | null; branch: string };

const repositoryRoot = path.resolve(import.meta.dirname, "../..");
const profile = process.env.ORKESTRATOR_AGENT_TEST_PROFILE ?? "codex-qa";

async function profileStatus(): Promise<Status> {
  const command = spawnSync("bun", ["run", "dev:status", "--", "--profile", profile, "--json"], {
    cwd: repositoryRoot,
    encoding: "utf8",
  });
  if (!command.stdout.trim()) throw new Error(command.stderr || "dev:status returned no manifest");
  return JSON.parse(command.stdout) as Status;
}

test("real browser gateway exercises an authoritative local environment", async ({ page }) => {
  const status = await profileStatus();
  expect(status.status).toBe("ready");
  expect(status.browserUrl).toBeTruthy();
  expect(status.authFile).toBeTruthy();
  expect(status.testProject).toBeTruthy();
  const auth = JSON.parse(await readFile(status.authFile!, "utf8")) as { token: string };
  // Mint outside Playwright so the persistent gateway token can never enter a
  // browser trace. The exchanged code is short-lived and consumed exactly once.
  const minted = await fetch(new URL("/__orkestrator/agent-test/bootstrap", status.browserUrl!).href, {
    method: "POST",
    headers: { authorization: `Bearer ${auth.token}` },
  });
  expect(minted.ok).toBe(true);
  const { code } = await minted.json() as { code: string };
  const exchanged = await page.request.post(
    new URL("/__orkestrator/agent-test/bootstrap/exchange", status.browserUrl!).href,
    { data: { code } },
  );
  expect(exchanged.ok()).toBe(true);
  const invoke = async <T>(command: string, args: Record<string, unknown> = {}): Promise<T> => {
    const response = await page.request.post(new URL("/__orkestrator/invoke", status.browserUrl!).href, {
      data: { command, args },
    });
    expect(response.ok(), `${command}: ${await response.text()}`).toBe(true);
    return (await response.json() as { result: T }).result;
  };

  const projects = await invoke<Project[]>("get_projects");
  const fixture = projects.find((project) => project.localPath === status.testProject);
  expect(fixture).toBeTruthy();

  await page.goto(status.browserUrl!);
  await expect(page.getByText(fixture!.name, { exact: false }).first()).toBeVisible({ timeout: 30_000 });

  const environment = await invoke<Environment>("create_environment", {
    projectId: fixture!.id,
    name: `smoke-${Date.now()}`,
    networkAccessMode: "restricted",
    environmentType: "local",
  });
  try {
    await invoke("start_environment", { environmentId: environment.id });
    const hydrated = await invoke<Environment>("get_environment", { environmentId: environment.id });
    expect(hydrated.worktreePath).toBeTruthy();
    expect(hydrated.worktreePath!.includes(`${path.sep}worktrees${path.sep}`)).toBe(true);

    const terminal = await invoke<{ sessionId: string }>("create_local_terminal_session", {
      environmentId: environment.id,
      terminalKey: "agent-smoke",
      cols: 80,
      rows: 24,
      trackEnvironmentActivity: true,
    });
    await invoke("start_local_terminal_session", { sessionId: terminal.sessionId });
    await invoke("local_terminal_write", {
      sessionId: terminal.sessionId,
      data: "sleep 1; printf 'background-done\\n'; printf 'changed\\n' > smoke-change.txt\n",
    });

    // Exercise the inactive-environment contract through unrelated authoritative
    // reads while the backend-owned terminal keeps progressing.
    await invoke("get_projects");
    await invoke("get_environments", { projectId: fixture!.id });
    await page.reload();
    await expect(page.getByText(fixture!.name, { exact: false }).first()).toBeVisible({ timeout: 30_000 });

    await expect.poll(
      () => invoke<string>("get_terminal_output_buffer", { sessionId: terminal.sessionId }),
      { timeout: 15_000 },
    ).toContain("background-done");
    await invoke<void>("refresh_environment_diff_stats", {
      environmentId: environment.id,
    });
    await expect.poll(async () => {
      const snapshot = await invoke<{
        entries: Array<{ environmentId: string; stats: { filesChanged: number } }>;
      }>("get_environment_diff_stats");
      return snapshot.entries.find((entry) => entry.environmentId === environment.id)?.stats.filesChanged ?? 0;
    }, { timeout: 15_000 }).toBeGreaterThan(0);
    await invoke("close_local_terminal_session", { sessionId: terminal.sessionId });
  } finally {
    await invoke("stop_environment", { environmentId: environment.id }).catch(() => undefined);
    await invoke("delete_environment", { environmentId: environment.id }).catch(() => undefined);
  }
});
