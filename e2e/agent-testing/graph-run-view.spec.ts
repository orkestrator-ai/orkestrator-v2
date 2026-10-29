import { ensureProjectExpanded } from "./sidebar-project";
import { expect, test, type Page } from "@playwright/test";
import { spawn, spawnSync } from "node:child_process";
import { closeSync, openSync, readFileSync } from "node:fs";
import path from "node:path";
import { resolveRuntimeProfile } from "../../apps/desktop/electron/runtime-profile";
import { enableExperimentalGraphs } from "./experimental-graphs";

/**
 * The run view's read side against the real backend (item 211): the
 * designer lists the environment's graph runs (none in a fresh environment),
 * the run commands answer through the browser gateway (`graph_runs_list`, a
 * refused `graph_run_get` for a run that does not exist), and the list
 * rehydrates after switching environments and after a reload.
 * Credential-free: no agent runs.
 *
 * The human-node commands answer too (item 208: `graph_run_pending`, and a
 * refused `graph_run_answer`).
 *
 * Launched runs (items 211, 208 and 214), all credential-free: a run
 * launched from "Run graph…" finishes while its environment is away and
 * rehydrates; a run with two human approvals waits while its environment is
 * away (the sidebar shows it waiting), one wait is answered through the
 * command path while away and the other from the run view after returning,
 * with reloads in between. An opt-in case
 * (`ORKESTRATOR_AGENT_TEST_GRAPH_RESTART=1`) restarts the whole profile while
 * a human node waits and answers it afterwards; it leaves the profile running
 * under a detached launcher, so stop it with `dev:stop` as usual.
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
  await enableExperimentalGraphs(invoke);

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

/** Credential-free: prepare-environment (no setup script) and a gate on its commit. */
const QA_TEMPLATE = {
  format: "orkestrator.graph",
  formatVersion: 1,
  id: "qa-launch-rehydrate",
  revision: 0,
  name: "QA launch rehydrate",
  description: "Credential-free: prepare the environment, then gate on its commit.",
  parameters: [],
  roles: [],
  inputs: [],
  outputs: [{ name: "code", type: "workspace@1", from: { node: "prepare", port: "code" } }],
  workspace: { kind: "environment" },
  nodes: [
    {
      id: "prepare",
      kind: "system",
      action: "prepare-environment",
      params: { setup: false },
      outputs: [{ name: "code", type: "workspace@1" }],
    },
    {
      id: "has-commit",
      kind: "gate",
      inputs: [{ name: "code", type: "workspace@1" }],
      branches: [{ when: { path: "code.headRef", op: "nonEmpty" }, to: "ready" }],
      otherwise: "empty",
    },
  ],
  edges: [
    {
      id: "prepare-code",
      from: { node: "prepare", port: "code" },
      to: { node: "has-commit", port: "code" },
    },
  ],
  limits: { maxAgentSessions: 1, maxConcurrentAgents: 1 },
};

test("a graph launched from Run graph… finishes while its environment is away and rehydrates", async ({
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
  const invoke = async <T>(command: string, args: Record<string, unknown> = {}): Promise<T> => {
    const response = await page.request.post(
      new URL("/__orkestrator/invoke", status.browserUrl).href,
      { data: { command, args } },
    );
    const body = await response.json().catch(() => null);
    expect(response.ok() && !body?.error, command).toBe(true);
    return body.result as T;
  };
  await enableExperimentalGraphs(invoke);

  const projects =
    await invoke<Array<{ id: string; name: string; localPath: string }>>("get_projects");
  const project = projects.find((candidate) => candidate.localPath === status.testProject)!;
  expect(project).toBeTruthy();
  await invoke("graph_template_save", { template: QA_TEMPLATE, expectedRevision: 0 }).catch(
    () => undefined,
  );
  const env = await invoke<{ id: string; name: string }>("create_environment", {
    projectId: project.id,
    name: "graph-launch-run",
    environmentType: "local",
    networkAccessMode: "restricted",
  });
  const other = await invoke<{ id: string; name: string }>("create_environment", {
    projectId: project.id,
    name: "graph-launch-away",
    environmentType: "local",
    networkAccessMode: "restricted",
  });
  try {
    await invoke("start_environment", { environmentId: env.id });
    await invoke("start_environment", { environmentId: other.id });
    await page.reload();
    await openEnvironment(page, project.name, env.name);

    // Launch from the action bar: the dialog is generated from the template.
    await page.getByRole("button", { name: "Run graph…" }).first().click();
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByText("Run graph", { exact: true })).toBeVisible();
    await dialog.getByLabel("Template").selectOption({ label: "QA launch rehydrate" });
    await expect(dialog.getByRole("radiogroup", { name: "Environment" })).toBeVisible();
    await dialog.getByRole("radio", { name: "Existing environment" }).click();
    await page.screenshot({ path: testInfo.outputPath("02-launch-dialog.png") });
    await dialog.getByRole("button", { name: "Launch" }).click();
    await expect(dialog).toBeHidden();

    // The run's tab opens in this environment.
    const runTab = page.locator("[data-graph-run]");
    await expect(runTab).toBeVisible();
    const runId = await runTab.getAttribute("data-graph-run");
    expect(runId).toBeTruthy();

    // Switch away at once; the run finishes in the background.
    await openEnvironment(page, project.name, other.name);
    await expect(runTab).toBeHidden();
    await expect
      .poll(
        async () =>
          (await invoke<{ status: string; run?: { status: string } }>("graph_run_get", { runId }))
            .run?.status,
        { timeout: 60_000 },
      )
      .toBe("complete");

    // Return: the tab shows the finished run, read from the backend.
    await openEnvironment(page, project.name, env.name);
    await expect(page.locator(`[data-graph-run="${runId}"]`)).toBeVisible();
    await expect(page.locator("[data-graph-run-status]")).toHaveAttribute(
      "data-graph-run-status",
      "complete",
    );
    await page.screenshot({ path: testInfo.outputPath("03-run-complete.png") });

    // A reload rehydrates the same tab and state.
    await page.reload();
    await openEnvironment(page, project.name, env.name);
    await expect(page.locator("[data-graph-run-status]")).toHaveAttribute(
      "data-graph-run-status",
      "complete",
    );
    const listed = await invoke<Array<{ id: string; status: string }>>("graph_runs_list", {
      environmentId: env.id,
    });
    expect(listed.map((run) => [run.id, run.status])).toEqual([[runId, "complete"]]);
  } finally {
    await invoke("stop_environment", { environmentId: env.id }).catch(() => undefined);
    await invoke("stop_environment", { environmentId: other.id }).catch(() => undefined);
    await invoke("delete_environment", { environmentId: env.id }).catch(() => undefined);
    await invoke("delete_environment", { environmentId: other.id }).catch(() => undefined);
  }
});

const repositoryRoot = path.resolve(import.meta.dirname, "../..");

type GraphRunRead = {
  status: string;
  run?: {
    status: string;
    activations: Array<{
      key: string;
      nodeId: string;
      state: string;
      outlet?: string;
      human?: { id: string; answer?: { decision: string; outlet: string; by: string } };
    }>;
  };
};
type PendingWait = {
  kind: string;
  runId: string;
  activationKey: string;
  nodeId: string;
  title: string;
  waitId?: string;
  form?: string;
};

/**
 * Credential-free: prepare the environment, then two human approvals in a
 * row, then a gate on the approved commit. The first is answered through the
 * command path while the environment is away, the second from the run view.
 */
const HUMAN_TEMPLATE = {
  ...QA_TEMPLATE,
  id: "qa-human-approve",
  name: "QA human approve",
  description: "Credential-free: prepare the environment, two approvals, then a gate.",
  nodes: [
    QA_TEMPLATE.nodes[0],
    {
      id: "first-check",
      label: "First check",
      kind: "human",
      form: { kind: "approve", instructions: "Approve the prepared environment." },
      inputs: [{ name: "code", type: "workspace@1" }],
    },
    {
      id: "second-check",
      label: "Second check",
      kind: "human",
      form: { kind: "approve", instructions: "Approve it once more." },
      inputs: [{ name: "code", type: "workspace@1" }],
    },
    QA_TEMPLATE.nodes[1],
  ],
  edges: [
    {
      id: "prepare-first",
      from: { node: "prepare", port: "code" },
      to: { node: "first-check", port: "code" },
    },
    {
      id: "first-second",
      from: { node: "first-check", outlet: "approved", port: "code" },
      to: { node: "second-check", port: "code" },
    },
    {
      id: "second-gate",
      from: { node: "second-check", outlet: "approved", port: "code" },
      to: { node: "has-commit", port: "code" },
    },
  ],
};

/** One human approval: the restart case waits on it across a profile restart. */
const RESTART_TEMPLATE = {
  ...HUMAN_TEMPLATE,
  id: "qa-human-restart",
  name: "QA human restart",
  description: "Credential-free: prepare the environment, one approval, then a gate.",
  nodes: [HUMAN_TEMPLATE.nodes[0], HUMAN_TEMPLATE.nodes[1], HUMAN_TEMPLATE.nodes[3]],
  edges: [
    HUMAN_TEMPLATE.edges[0],
    {
      id: "first-gate",
      from: { node: "first-check", outlet: "approved", port: "code" },
      to: { node: "has-commit", port: "code" },
    },
  ],
};

/** Signs `page` in to the profile and returns gateway command helpers. */
async function connect(page: Page, profile: string) {
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
  await enableExperimentalGraphs(invoke);
  return { status, call, invoke };
}

type Invoke = Awaited<ReturnType<typeof connect>>["invoke"];

async function pendingWaits(invoke: Invoke, environmentId: string): Promise<PendingWait[]> {
  return invoke<PendingWait[]>("graph_run_pending", { environmentId });
}

/** An environment's sidebar row (the row's button is named after the environment). */
function sidebarRow(page: Page, environmentName: string) {
  return page.getByRole("button", { name: new RegExp(`^${environmentName}(\\s|$)`) }).first();
}

/** The row's leading marker: `data-state` is `waiting`, `working`, `idle` or `inactive`. */
function sidebarMarker(page: Page, environmentName: string) {
  return sidebarRow(page, environmentName).getByTestId("environment-status-marker");
}

/** Answers the run view's waiting human node with Approve and a note. */
async function approveFromRunView(page: Page, nodeId: string, note: string) {
  const panel = page.locator(`[data-graph-human-node="${nodeId}"][data-graph-human-waiting]`);
  await expect(panel).toBeVisible();
  await panel.getByRole("radio", { name: "Approve" }).click();
  await panel.getByRole("textbox", { name: "Note (optional)" }).fill(note);
  await panel.getByRole("button", { name: "Send" }).click();
}

test("a human approval waits while its environment is away and is answered later", async ({
  page,
}, testInfo) => {
  test.setTimeout(240_000);
  const profile = process.env.ORKESTRATOR_AGENT_TEST_PROFILE ?? "codex-qa";
  const { status, call, invoke } = await connect(page, profile);
  const projects =
    await invoke<Array<{ id: string; name: string; localPath: string }>>("get_projects");
  const project = projects.find((candidate) => candidate.localPath === status.testProject)!;
  expect(project).toBeTruthy();
  await invoke("graph_template_save", { template: HUMAN_TEMPLATE, expectedRevision: 0 }).catch(
    () => undefined,
  );
  const env = await invoke<{ id: string; name: string }>("create_environment", {
    projectId: project.id,
    name: "graph-human-run",
    environmentType: "local",
    networkAccessMode: "restricted",
  });
  const other = await invoke<{ id: string; name: string }>("create_environment", {
    projectId: project.id,
    name: "graph-human-away",
    environmentType: "local",
    networkAccessMode: "restricted",
  });
  try {
    await invoke("start_environment", { environmentId: env.id });
    await invoke("start_environment", { environmentId: other.id });
    await page.reload();
    await openEnvironment(page, project.name, env.name);

    // Launch from the action bar on the existing environment.
    await page.getByRole("button", { name: "Run graph…" }).first().click();
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByText("Run graph", { exact: true })).toBeVisible();
    await dialog.getByLabel("Template").selectOption({ label: "QA human approve" });
    await dialog.getByRole("radio", { name: "Existing environment" }).click();
    await dialog.getByRole("button", { name: "Launch" }).click();
    await expect(dialog).toBeHidden();
    const runTab = page.locator("[data-graph-run]");
    await expect(runTab).toBeVisible();
    const runId = (await runTab.getAttribute("data-graph-run"))!;
    expect(runId).toBeTruthy();

    // Switch away at once; the run reaches its first human node in the background.
    await openEnvironment(page, project.name, other.name);
    await expect(runTab).toBeHidden();
    const readRun = async () => (await invoke<GraphRunRead>("graph_run_get", { runId })).run!;
    await expect.poll(async () => (await readRun()).status, { timeout: 60_000 }).toBe("waiting");
    let pending = await pendingWaits(invoke, env.id);
    expect(pending.map((wait) => [wait.kind, wait.nodeId, wait.form, wait.title])).toEqual([
      ["human", "first-check", "approve", "First check"],
    ]);
    // The sidebar shows the away environment waiting for a person, with the
    // unread attention the wait recorded.
    await expect(sidebarMarker(page, env.name)).toHaveAttribute("data-state", "waiting", {
      timeout: 30_000,
    });
    await expect(sidebarRow(page, env.name).getByLabel("New completed activity")).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath("04-human-waiting-away.png") });

    // Answer the first wait through the command path while still away.
    const first = pending[0]!;
    await invoke("graph_run_answer", {
      runId,
      activationKey: first.activationKey,
      waitId: first.waitId,
      decision: "approve",
      note: "Approved while away.",
    });
    // A repeat of the same answer is refused: the wait is already answered.
    const repeat = await call("graph_run_answer", {
      runId,
      activationKey: first.activationKey,
      waitId: first.waitId,
      decision: "approve",
    });
    expect(repeat.ok).toBe(false);
    await expect
      .poll(async () => (await pendingWaits(invoke, env.id)).map((wait) => wait.nodeId), {
        timeout: 60_000,
      })
      .toEqual(["second-check"]);
    const afterFirst = await readRun();
    expect(afterFirst.status).toBe("waiting");
    const firstActivation = afterFirst.activations.find((entry) => entry.nodeId === "first-check")!;
    expect(firstActivation.state).toBe("complete");
    expect(firstActivation.outlet).toBe("approved");
    expect(firstActivation.human?.answer?.decision).toBe("approve");

    // Return: the run view shows the second wait, read from the backend.
    await openEnvironment(page, project.name, env.name);
    await expect(page.locator(`[data-graph-run="${runId}"]`)).toBeVisible();
    await expect(page.locator("[data-graph-run-status]")).toHaveAttribute(
      "data-graph-run-status",
      "waiting",
    );
    await expect(page.getByTestId("graph-run-waiting-banner")).toHaveText(
      "Second check is waiting for you.",
    );
    await expect(
      page.locator('[data-graph-human-node="second-check"][data-graph-human-waiting]'),
    ).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath("05-human-waiting-returned.png") });

    // A reload rehydrates the same wait.
    await page.reload();
    await openEnvironment(page, project.name, env.name);
    await expect(page.locator("[data-graph-run-status]")).toHaveAttribute(
      "data-graph-run-status",
      "waiting",
    );
    await expect(page.getByTestId("graph-run-waiting-banner")).toHaveText(
      "Second check is waiting for you.",
    );

    // Answer the second wait from the run view; the run finishes.
    await approveFromRunView(page, "second-check", "Approved from the run view.");
    await expect(page.locator("[data-graph-run-status]")).toHaveAttribute(
      "data-graph-run-status",
      "complete",
      { timeout: 60_000 },
    );
    await expect(page.getByTestId("graph-run-waiting-banner")).toHaveCount(0);
    expect(await pendingWaits(invoke, env.id)).toEqual([]);
    await expect(sidebarMarker(page, env.name)).not.toHaveAttribute("data-state", "waiting", {
      timeout: 30_000,
    });
    await page.screenshot({ path: testInfo.outputPath("06-human-answered-complete.png") });

    // A reload shows the finished run and both recorded answers.
    await page.reload();
    await openEnvironment(page, project.name, env.name);
    await expect(page.locator("[data-graph-run-status]")).toHaveAttribute(
      "data-graph-run-status",
      "complete",
    );
    const finished = await readRun();
    expect(
      finished.activations
        .filter((entry) => entry.human)
        .map((entry) => [entry.nodeId, entry.outlet, entry.human?.answer?.decision]),
    ).toEqual([
      ["first-check", "approved", "approve"],
      ["second-check", "approved", "approve"],
    ]);
  } finally {
    await invoke("stop_environment", { environmentId: env.id }).catch(() => undefined);
    await invoke("stop_environment", { environmentId: other.id }).catch(() => undefined);
    await invoke("delete_environment", { environmentId: env.id }).catch(() => undefined);
    await invoke("delete_environment", { environmentId: other.id }).catch(() => undefined);
  }
});

/** Runs a command without blocking the event loop (a blocked loop cannot reap the launcher). */
function runAsync(command: string, args: string[], timeoutMs: number): Promise<number | null> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: repositoryRoot, stdio: "ignore" });
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });
}

/**
 * Stops the profile and starts it again with the credential and platform
 * selection stored in its `profile.json`, as quitting and reopening the app
 * would. `--fixture` is not passed on the way back up: it would recreate the
 * fixture repository the environments point at.
 */
async function restartProfile(profile: string, logPath: string): Promise<void> {
  const runtime = resolveRuntimeProfile({
    repositoryRoot,
    requestedId: profile,
    flavor: "agent-test",
  });
  const stored = JSON.parse(
    readFileSync(path.join(runtime.profileRoot, "profile.json"), "utf8"),
  ) as {
    credentialSources?: string[];
    agentPlatforms?: string[];
  };
  expect(await runAsync("mise", ["run", "dev:stop", "--profile", profile], 90_000)).toBe(0);
  const credentials = stored.credentialSources ?? [];
  const args = [
    "apps/desktop/scripts/dev-test.ts",
    "--profile",
    profile,
    ...(credentials.length
      ? credentials.flatMap((source) => ["--credential-source", source])
      : ["--no-agent-credentials"]),
    ...(stored.agentPlatforms?.length
      ? ["--agent-platforms", stored.agentPlatforms.join(",")]
      : []),
  ];
  const log = openSync(logPath, "a");
  // The launcher is a foreground supervisor; it outlives this test and is
  // stopped with the profile, like the one the caller started.
  const launcher = spawn("bun", args, {
    cwd: repositoryRoot,
    detached: true,
    stdio: ["ignore", log, log],
  });
  closeSync(log);
  launcher.unref();
  await expect
    .poll(() => devJson("dev:status", profile).status, { timeout: 240_000, intervals: [2_000] })
    .toBe("ready");
}

test("a human node waits across a profile restart and is answered afterwards", async ({
  page,
}, testInfo) => {
  test.skip(
    process.env.ORKESTRATOR_AGENT_TEST_GRAPH_RESTART !== "1",
    "profile restart opt-in required (ORKESTRATOR_AGENT_TEST_GRAPH_RESTART=1)",
  );
  test.setTimeout(8 * 60_000);
  const profile = process.env.ORKESTRATOR_AGENT_TEST_PROFILE ?? "codex-qa";
  let { status, invoke } = await connect(page, profile);
  const projects =
    await invoke<Array<{ id: string; name: string; localPath: string }>>("get_projects");
  const project = projects.find((candidate) => candidate.localPath === status.testProject)!;
  expect(project).toBeTruthy();
  await invoke("graph_template_save", { template: RESTART_TEMPLATE, expectedRevision: 0 }).catch(
    () => undefined,
  );
  const env = await invoke<{ id: string; name: string }>("create_environment", {
    projectId: project.id,
    name: "graph-human-restart",
    environmentType: "local",
    networkAccessMode: "restricted",
  });
  try {
    await invoke("start_environment", { environmentId: env.id });
    const launched = await invoke<{ runId: string }>("graph_run_launch", {
      ref: { scope: "user", id: RESTART_TEMPLATE.id },
      projectId: project.id,
      environment: { kind: "existing", environmentId: env.id },
      requestId: `qa-human-restart-${Date.now()}`,
    });
    const runId = launched.runId;
    await expect
      .poll(async () => (await invoke<GraphRunRead>("graph_run_get", { runId })).run?.status, {
        timeout: 60_000,
      })
      .toBe("waiting");
    const before = await pendingWaits(invoke, env.id);
    expect(before.map((wait) => wait.nodeId)).toEqual(["first-check"]);

    await restartProfile(profile, testInfo.outputPath("dev-test-restart.log"));
    ({ status, invoke } = await connect(page, profile));

    // The same wait survives: same activation, same wait id, still unanswered.
    const after = await pendingWaits(invoke, env.id);
    expect(after.map((wait) => [wait.activationKey, wait.waitId])).toEqual([
      [before[0]!.activationKey, before[0]!.waitId],
    ]);
    expect((await invoke<GraphRunRead>("graph_run_get", { runId })).run?.status).toBe("waiting");

    // Answer it from the run view, opened from the designer's runs list.
    await openEnvironment(page, project.name, env.name);
    const runTab = page.locator(`[data-graph-run="${runId}"]`);
    if (!(await runTab.isVisible().catch(() => false))) {
      await page.getByRole("button", { name: "Graphs", exact: true }).click();
      await page
        .locator("[data-graph-designer]")
        .getByRole("region", { name: "Graph runs" })
        .getByText("QA human restart")
        .first()
        .click();
    }
    await expect(runTab).toBeVisible();
    await expect(sidebarMarker(page, env.name)).toHaveAttribute("data-state", "waiting", {
      timeout: 30_000,
    });
    await page.screenshot({ path: testInfo.outputPath("07-human-waiting-after-restart.png") });
    await approveFromRunView(page, "first-check", "Approved after the restart.");
    await expect(page.locator("[data-graph-run-status]")).toHaveAttribute(
      "data-graph-run-status",
      "complete",
      { timeout: 60_000 },
    );
    expect(await pendingWaits(invoke, env.id)).toEqual([]);
  } finally {
    await invoke("stop_environment", { environmentId: env.id }).catch(() => undefined);
    await invoke("delete_environment", { environmentId: env.id }).catch(() => undefined);
  }
});
