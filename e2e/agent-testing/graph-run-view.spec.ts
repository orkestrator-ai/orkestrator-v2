import { ensureProjectExpanded } from "./sidebar-project";
import { expect, test, type Page } from "@playwright/test";
import { spawnSync } from "node:child_process";

/**
 * The run view's read side against the real backend (item 211): the
 * designer lists the environment's graph runs (none in a fresh environment),
 * the run commands answer through the browser gateway (`graph_runs_list`, a
 * refused `graph_run_get` for a run that does not exist), and the list
 * rehydrates after switching environments and after a reload.
 * Credential-free: no agent runs.
 *
 * The human-node commands answer too (item 208: `graph_run_pending`, and a
 * refused `graph_run_answer`). Starting a run, switching away while it
 * finishes (or waits on a person) and returning to its tab needs a launch
 * path (items 213 and 214); that scenario joins this file when one exists.
 */

test.use({ actionTimeout: 15_000 });

function devJson(command: string, profile: string) {
  return JSON.parse(
    spawnSync("mise", ["run", command, "--profile", profile, "--json"], { encoding: "utf8" })
      .stdout,
  );
}

async function openEnvironment(page: Page, projectName: string, environmentName: string) {
  await ensureProjectExpanded(page, projectName);
  await page.getByText(environmentName, { exact: true }).first().click();
}

test("the Graphs designer lists the environment's runs from the backend", async ({
  page,
}, testInfo) => {
  const profile = process.env.ORKESTRATOR_AGENT_TEST_PROFILE ?? "codex-qa";
  const status = devJson("dev:status", profile);
  expect(status.status).toBe("ready");
  const login = devJson("dev:login", profile);
  await page.route("**/__orkestrator/invoke", async (route) => {
    const request = route.request().postDataJSON();
    if (request?.command === "check_claude_cli") await route.fulfill({ json: { result: false } });
    else await route.continue();
  });
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.goto(login.loginUrl);
  const call = async (command: string, args: Record<string, unknown> = {}) => {
    const response = await page.request.post(
      new URL("/__orkestrator/invoke", status.browserUrl).href,
      { data: { command, args } },
    );
    const body = await response.json().catch(() => null);
    return { ok: response.ok() && !body?.error, body };
  };
  const invoke = async <T>(command: string, args: Record<string, unknown> = {}): Promise<T> => {
    const { ok, body } = await call(command, args);
    expect(ok, command).toBe(true);
    return body.result as T;
  };

  const projects =
    await invoke<Array<{ id: string; name: string; localPath: string }>>("get_projects");
  const project = projects.find((candidate) => candidate.localPath === status.testProject)!;
  expect(project).toBeTruthy();

  const env = await invoke<{ id: string; name: string }>("create_environment", {
    projectId: project.id,
    name: "graph-runs-smoke",
    environmentType: "local",
    networkAccessMode: "restricted",
  });
  const other = await invoke<{ id: string; name: string }>("create_environment", {
    projectId: project.id,
    name: "graph-runs-other",
    environmentType: "local",
    networkAccessMode: "restricted",
  });
  try {
    await invoke("start_environment", { environmentId: env.id });
    await invoke("start_environment", { environmentId: other.id });

    // The run commands answer through the gateway.
    expect(await invoke("graph_runs_list", { environmentId: env.id })).toEqual([]);
    const missing = await call("graph_run_get", { runId: "no-such-run" });
    expect(missing.ok).toBe(false);
    expect(JSON.stringify(missing.body)).toContain("does not exist");
    const malformed = await call("graph_run_get", { runId: "x", extra: true });
    expect(malformed.ok).toBe(false);
    // Human nodes (item 208): nothing waits in a fresh environment, and an
    // answer for a run that does not exist is refused, never recorded.
    expect(await invoke("graph_run_pending", { environmentId: env.id })).toEqual([]);
    const stale = await call("graph_run_answer", {
      runId: "no-such-run",
      activationKey: "check#iter=1#attempt=1",
      waitId: "33333333-3333-4333-8333-333333333333",
      decision: "approve",
    });
    expect(stale.ok).toBe(false);
    expect(JSON.stringify(stale.body)).toContain("does not exist");

    await page.reload();
    await openEnvironment(page, project.name, env.name);
    await page.getByRole("button", { name: "Graphs", exact: true }).click();
    const designer = page.locator("[data-graph-designer]");
    await expect(designer).toBeVisible();
    const runs = designer.getByRole("region", { name: "Graph runs" });
    await expect(runs.getByTestId("graph-runs-empty")).toHaveText(
      "No graph runs in this environment yet.",
    );
    await page.screenshot({ path: testInfo.outputPath("01-runs-empty.png") });

    // Switch away and back: the list is re-read, not kept from the first mount.
    await openEnvironment(page, project.name, other.name);
    await expect(designer).toBeHidden();
    await openEnvironment(page, project.name, env.name);
    await expect(runs.getByTestId("graph-runs-empty")).toBeVisible();

    // A reload rehydrates the tab and its list from the backend.
    await page.reload();
    await openEnvironment(page, project.name, env.name);
    await expect(
      page.locator("[data-graph-designer]").getByRole("region", { name: "Graph runs" }),
    ).toBeVisible();
    await expect(page.getByTestId("graph-runs-empty")).toBeVisible();
  } finally {
    await invoke("stop_environment", { environmentId: env.id }).catch(() => undefined);
    await invoke("stop_environment", { environmentId: other.id }).catch(() => undefined);
    await invoke("delete_environment", { environmentId: env.id }).catch(() => undefined);
    await invoke("delete_environment", { environmentId: other.id }).catch(() => undefined);
  }
});
