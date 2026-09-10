import {
  newReviewValidationRun,
  type ReviewValidationRun,
} from "@orkestrator/protocol/review-workflow";
import { expect, test, type Page } from "@playwright/test";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { PANE_LAYOUT_VERSION } from "@orkestrator/protocol/pane-layout";
import type {
  MultiReviewActionResult,
  MultiReviewWorkflow,
} from "@orkestrator/protocol/multi-review";

import { resolveRuntimeProfile } from "../../apps/desktop/electron/runtime-profile";

type Status = {
  status: string;
  profile?: string;
  flavor?: string;
  browserUrl?: string;
  authFile?: string;
  testProject?: string;
};
type Project = { id: string; name: string; localPath: string | null };
type Environment = {
  id: string;
  name: string;
  worktreePath?: string | null;
  branch: string;
  containerId?: string | null;
  status: string;
};
type AgentMessagingSettings = {
  enabled: boolean;
  paused: boolean;
  defaultInjectPolicy: "off" | "idle";
  allowCrossProject: boolean;
  retentionDays: number;
};

const repositoryRoot = path.resolve(import.meta.dirname, "../..");
const profile = process.env.ORKESTRATOR_AGENT_TEST_PROFILE ?? "codex-qa";

async function profileStatus(): Promise<Status> {
  const command = spawnSync("mise", ["run", "dev:status", "--profile", profile, "--json"], {
    cwd: repositoryRoot,
    encoding: "utf8",
  });
  if (!command.stdout.trim()) throw new Error(command.stderr || "dev:status returned no manifest");
  return JSON.parse(command.stdout) as Status;
}

async function authenticatedInvoke(page: Page, status: Status) {
  // Exercise the exact host command agents use. Its stdout is parsed in memory
  // and never copied into Playwright output, so the one-shot code stays out of
  // traces and reports.
  const command = spawnSync("mise", ["run", "dev:login", "--profile", profile, "--json"], {
    cwd: repositoryRoot,
    encoding: "utf8",
  });
  if (command.status !== 0) throw new Error(command.stderr || "dev:login failed");
  let login: { loginUrl?: unknown };
  try {
    login = JSON.parse(command.stdout) as { loginUrl?: unknown };
  } catch {
    throw new Error("dev:login returned invalid JSON");
  }
  if (typeof login.loginUrl !== "string") throw new Error("dev:login returned no login URL");
  const response = await page.goto(login.loginUrl, { waitUntil: "domcontentloaded" });
  expect(response?.ok() ?? false).toBe(true);
  expect(page.url()).not.toContain("/__orkestrator/agent-test/login");
  expect(page.url()).not.toContain("code=");
  return async <T>(command: string, args: Record<string, unknown> = {}): Promise<T> => {
    const invokeResponse = await page.request.post(
      new URL("/__orkestrator/invoke", status.browserUrl!).href,
      {
        data: { command, args },
      },
    );
    expect(invokeResponse.ok(), `${command}: ${await invokeResponse.text()}`).toBe(true);
    return ((await invokeResponse.json()) as { result: T }).result;
  };
}

test("real browser gateway exercises an authoritative local environment", async ({ page }) => {
  const status = await profileStatus();
  expect(status.status).toBe("ready");
  expect(status.browserUrl).toBeTruthy();
  expect(status.authFile).toBeTruthy();
  expect(status.testProject).toBeTruthy();
  const invoke = await authenticatedInvoke(page, status);

  const projects = await invoke<Project[]>("get_projects");
  const fixture = projects.find((project) => project.localPath === status.testProject);
  expect(fixture).toBeTruthy();

  await page.goto(status.browserUrl!);
  await expect(page.getByText(fixture!.name, { exact: false }).first()).toBeVisible({
    timeout: 30_000,
  });

  const environment = await invoke<Environment>("create_environment", {
    projectId: fixture!.id,
    name: `smoke-${Date.now()}`,
    networkAccessMode: "restricted",
    environmentType: "local",
  });
  try {
    await invoke("start_environment", { environmentId: environment.id });
    const hydrated = await invoke<Environment>("get_environment", {
      environmentId: environment.id,
    });
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
      data: "sleep 1; i=0; while [ $i -lt 1100 ]; do printf '%0480d\\n' \"$i\"; i=$((i + 1)); done; printf 'background-done\\n'; printf 'changed\\n' > smoke-change.txt\n",
    });

    // Exercise the inactive-environment contract through unrelated authoritative
    // reads while the backend-owned terminal keeps progressing.
    await invoke("get_projects");
    await invoke("get_environments", { projectId: fixture!.id });
    await page.reload();
    await expect(page.getByText(fixture!.name, { exact: false }).first()).toBeVisible({
      timeout: 30_000,
    });

    await expect
      .poll(
        async () => {
          const snapshot = await invoke<{
            mode: string;
            output: string;
            revision: number;
            historyTruncated: boolean;
          } | null>("get_terminal_state_snapshot", { sessionId: terminal.sessionId });
          return {
            current: snapshot?.mode === "state" && snapshot.output.includes("background-done"),
            retainedWithinBudget:
              (snapshot?.output.length ?? Number.POSITIVE_INFINITY) <= 2 * 1024 * 1024,
            rolledOver: snapshot?.historyTruncated === true,
          };
        },
        { timeout: 30_000 },
      )
      .toEqual({ current: true, retainedWithinBudget: true, rolledOver: true });
    const historyPage = await invoke<{
      rows: Array<{ text: string }>;
      previousCursor: string | null;
    } | null>("get_terminal_history_page", { sessionId: terminal.sessionId });
    expect(historyPage?.rows.some((row) => row.text.includes("background-done"))).toBe(true);
    await invoke<void>("refresh_environment_diff_stats", {
      environmentId: environment.id,
    });
    await expect
      .poll(
        async () => {
          const snapshot = await invoke<{
            entries: Array<{ environmentId: string; stats: { filesChanged: number } }>;
          }>("get_environment_diff_stats");
          return (
            snapshot.entries.find((entry) => entry.environmentId === environment.id)?.stats
              .filesChanged ?? 0
          );
        },
        { timeout: 15_000 },
      )
      .toBeGreaterThan(0);
    await invoke("close_local_terminal_session", { sessionId: terminal.sessionId });
  } finally {
    await invoke("stop_environment", { environmentId: environment.id }).catch(() => undefined);
    await invoke("delete_environment", { environmentId: environment.id }).catch(() => undefined);
  }
});

test("agent mail rehydrates after an inactive recipient is opened and the page reloads", async ({
  page,
}) => {
  const status = await profileStatus();
  expect(status.status).toBe("ready");
  expect(status.browserUrl).toBeTruthy();
  expect(status.testProject).toBeTruthy();
  const invoke = await authenticatedInvoke(page, status);
  const projects = await invoke<Project[]>("get_projects");
  const fixture = projects.find((project) => project.localPath === status.testProject);
  expect(fixture).toBeTruthy();
  const staleEnvironments = await invoke<Environment[]>("get_environments", {
    projectId: fixture!.id,
  });
  for (const stale of staleEnvironments.filter(({ name }) => name.startsWith("mail-"))) {
    await invoke("stop_environment", { environmentId: stale.id }).catch(() => undefined);
    await invoke("delete_environment", { environmentId: stale.id }).catch(() => undefined);
  }
  const previousSettings = await invoke<AgentMessagingSettings>("get_agent_messaging_settings");
  const suffix = Date.now();
  const sender = await invoke<Environment>("create_environment", {
    projectId: fixture!.id,
    name: `mail-sender-${suffix}`,
    networkAccessMode: "restricted",
    environmentType: "local",
  });
  const recipient = await invoke<Environment>("create_environment", {
    projectId: fixture!.id,
    name: `mail-recipient-${suffix}`,
    networkAccessMode: "restricted",
    environmentType: "local",
  });
  const senderTabId = "mail-sender-agent";
  const recipientTabId = "mail-recipient-agent";
  try {
    await invoke("update_agent_messaging_settings", {
      settings: {
        ...previousSettings,
        enabled: true,
        paused: false,
        defaultInjectPolicy: "off",
      },
    });
    for (const [environment, tabId] of [
      [sender, senderTabId],
      [recipient, recipientTabId],
    ] as const) {
      await invoke("start_environment", { environmentId: environment.id });
      const currentLayout = await invoke<{ revision?: number } | null>("get_pane_layout", {
        environmentId: environment.id,
      });
      await invoke("save_pane_layout", {
        environmentId: environment.id,
        expectedRevision: currentLayout?.revision ?? 0,
        layout: {
          version: PANE_LAYOUT_VERSION,
          containerId: null,
          activePaneId: "pane-mail",
          root: {
            kind: "leaf",
            id: "pane-mail",
            tabs: [
              {
                id: tabId,
                type: "agent-native",
                nativeAgentData: { environmentId: environment.id, platform: "claude" },
              },
            ],
            activeTabId: tabId,
          },
        },
      });
    }

    await page.goto(status.browserUrl!);
    const expandProject = page.getByRole("button", { name: `Expand project ${fixture!.name}` });
    await expect(expandProject).toBeVisible({ timeout: 30_000 });
    await expandProject.click();
    await page.getByText(sender.name, { exact: true }).first().click();
    await expect(page.getByText(sender.name, { exact: true }).first()).toBeVisible();
    await invoke("send_agent_mail", {
      requestId: `browser-mail-${suffix}`,
      toEnvironmentId: recipient.id,
      toTabId: recipientTabId,
      subject: "Inactive recipient",
      body: "This message arrived while the recipient environment was inactive.",
    });

    await page.getByText(recipient.name, { exact: true }).first().click();
    await expect(page.getByText("1 message in inbox · pull only")).toBeVisible({
      timeout: 15_000,
    });
    await expect(
      page.getByRole("button", { name: "1 unseen agent messages; open inbox", exact: true }),
    ).toBeVisible();

    await page.reload();
    const expandAfterReload = page.getByRole("button", {
      name: `Expand project ${fixture!.name}`,
    });
    await expect(expandAfterReload).toBeVisible({ timeout: 30_000 });
    await expandAfterReload.click();
    await page.getByText(recipient.name, { exact: true }).first().click();
    await expect(page.getByText("1 message in inbox · pull only")).toBeVisible({
      timeout: 15_000,
    });
    await expect(
      page.getByRole("button", { name: "1 unseen agent messages; open inbox", exact: true }),
    ).toBeVisible();
  } finally {
    await invoke("update_agent_messaging_settings", { settings: previousSettings }).catch(
      () => undefined,
    );
    for (const environment of [sender, recipient]) {
      await invoke("stop_environment", { environmentId: environment.id }).catch(() => undefined);
      await invoke("delete_environment", { environmentId: environment.id }).catch(() => undefined);
    }
  }
});

test("coordinator Multi Review action reconciles a mounted renderer and survives inactive cancellation and reload", async ({
  page,
}) => {
  test.skip(
    process.env.ORKESTRATOR_AGENT_TEST_REVIEW !== "1",
    "opt-in live review against the isolated fixture",
  );
  test.setTimeout(180_000);
  const status = await profileStatus();
  expect(status.status).toBe("ready");
  const invoke = await authenticatedInvoke(page, status);
  const fixture = (await invoke<Project[]>("get_projects")).find(
    (project) => project.localPath === status.testProject,
  );
  expect(fixture).toBeTruthy();
  const coordinator = await invoke<{
    workspace: { id: string; conversations: Array<{ id: string }> };
  }>("ensure_project_coordinator", { projectId: fixture!.id });
  const scope = {
    projectId: fixture!.id,
    coordinatorId: coordinator.workspace.id,
    conversationId: coordinator.workspace.conversations[0]!.id,
  };
  const environments: Environment[] = [];
  try {
    for (const name of ["review-action", "review-inactive"]) {
      const environment = await invoke<Environment>("create_environment", {
        projectId: fixture!.id,
        name: `${name}-${Date.now()}`,
        environmentType: "local",
        networkAccessMode: "restricted",
      });
      environments.push(environment);
      await invoke("start_environment", { environmentId: environment.id });
    }
    const [target, other] = environments;
    await page.goto(status.browserUrl!);
    const expand = page.getByRole("button", { name: `Expand project ${fixture!.name}` });
    await expect(expand).toBeVisible({ timeout: 30_000 });
    await expand.click();
    await page.getByText(target!.name, { exact: true }).first().click();
    const input = {
      requestId: `browser-review-${target!.id}`,
      environmentId: target!.id,
      reviewers: [{ agent: "codex", model: "default" }],
      fixModel: { agent: "codex", model: "default" },
    };
    const launched = await invoke<MultiReviewActionResult>(
      "launch_coordinator_multi_review_action",
      { scope, input },
    );
    expect(launched.outcome).toBe("opened");
    await expect(page.getByRole("heading", { name: "Multi Review", exact: true })).toBeVisible({
      timeout: 30_000,
    });
    const retried = await invoke<MultiReviewActionResult>(
      "launch_coordinator_multi_review_action",
      { scope, input },
    );
    expect(retried.workflow.id).toBe(launched.workflow.id);
    expect(retried.ui.tabId).toBe(launched.ui.tabId);
    await expect
      .poll(
        async () => {
          const saved = await invoke<{ snapshot: MultiReviewWorkflow }>(
            "get_multi_review_workflow",
            { workflowId: launched.workflow.id },
          );
          if (saved.snapshot.phase === "failed")
            throw new Error(saved.snapshot.error ?? "Preparation failed");
          return saved.snapshot.validationRun?.status;
        },
        { timeout: 90_000 },
      )
      .toBeDefined();
    await expect(page.getByRole("region", { name: "Review validation" })).toBeVisible();
    // Leave the previous row before crossing the sidebar's hover-detail card.
    await page.mouse.move(1100, 20);
    await page.getByText(other!.name, { exact: true }).first().click({ timeout: 10_000 });
    await expect(page.getByRole("heading", { name: "Multi Review", exact: true })).toHaveCount(0);
    await expect
      .poll(
        async () => {
          const saved = await invoke<{ snapshot: MultiReviewWorkflow }>(
            "get_multi_review_workflow",
            { workflowId: launched.workflow.id },
          );
          return saved.snapshot.validationRun?.status;
        },
        { timeout: 30_000 },
      )
      .toBe("completed");
    await invoke("cancel_multi_review", { workflowId: launched.workflow.id });
    await expect
      .poll(
        async () => {
          const saved = await invoke<{ snapshot: MultiReviewWorkflow }>(
            "get_multi_review_workflow",
            { workflowId: launched.workflow.id },
          );
          return saved.snapshot.phase;
        },
        { timeout: 60_000 },
      )
      .toBe("cancelled");
    await page.mouse.move(1100, 20);
    await page.getByText(target!.name, { exact: true }).first().click({ timeout: 10_000 });
    await expect(page.getByRole("heading", { name: "Multi Review", exact: true })).toBeVisible({
      timeout: 30_000,
    });
    await expect(page.getByText("Cancelled", { exact: true }).first()).toBeVisible();
    await page.reload();
    const expandAgain = page.getByRole("button", { name: `Expand project ${fixture!.name}` });
    await expect(expandAgain).toBeVisible({ timeout: 30_000 });
    await expandAgain.click();
    await page.getByText(target!.name, { exact: true }).first().click();
    await expect(page.getByRole("heading", { name: "Multi Review", exact: true })).toBeVisible({
      timeout: 30_000,
    });
    await expect(page.getByText("Cancelled", { exact: true }).first()).toBeVisible();
    const opened = await invoke<MultiReviewActionResult>("open_coordinator_multi_review", {
      scope,
      workflowId: launched.workflow.id,
    });
    expect(opened.ui.tabId).toBe(launched.ui.tabId);
  } finally {
    for (const environment of environments) {
      await invoke("stop_environment", { environmentId: environment.id }).catch(() => undefined);
      await invoke("delete_environment", { environmentId: environment.id }).catch(() => undefined);
    }
  }
});

test("Docker fixture rejects containers owned by another profile", async ({ page }) => {
  test.skip(
    process.env.ORKESTRATOR_AGENT_TEST_DOCKER !== "1",
    "requires an agent-test profile seeded with a container fixture",
  );

  const status = await profileStatus();
  expect(status.status).toBe("ready");
  expect(status.browserUrl).toBeTruthy();
  expect(status.authFile).toBeTruthy();
  expect(status.testProject).toBeTruthy();
  const invoke = await authenticatedInvoke(page, status);
  const projects = await invoke<Project[]>("get_projects");
  const fixture = projects.find((project) => project.localPath === status.testProject);
  expect(fixture).toBeTruthy();
  const environments = await invoke<Environment[]>("get_environments", { projectId: fixture!.id });
  const containerFixture = environments.find(
    (environment) => environment.name === "fixture-container",
  );
  expect(containerFixture?.containerId).toBeTruthy();
  expect(containerFixture?.status).toBe("running");

  const runtime = resolveRuntimeProfile({
    repositoryRoot,
    requestedId: profile,
    flavor: "agent-test",
  });
  const foreign = spawnSync(
    "docker",
    [
      "create",
      "--label",
      "app=orkestrator-v2",
      "--label",
      "orkestrator-owner=foreign-agent-test-profile",
      runtime.dockerImage,
      "true",
    ],
    { encoding: "utf8" },
  );
  expect(foreign.status, foreign.stderr).toBe(0);
  const foreignContainerId = foreign.stdout.trim();
  expect(foreignContainerId).toBeTruthy();
  try {
    const response = await page.request.post(
      new URL("/__orkestrator/invoke", status.browserUrl!).href,
      {
        data: { command: "get_container_logs", args: { containerId: foreignContainerId } },
      },
    );
    expect(response.ok()).toBe(false);
    expect(await response.text()).toContain("not owned by this development profile");

    const ownedLogs = await invoke<string>("get_container_logs", {
      containerId: containerFixture!.containerId,
      tail: "1",
    });
    expect(typeof ownedLogs).toBe("string");

    const terminal = await invoke<{ sessionId: string }>("create_terminal_session", {
      containerId: containerFixture!.containerId,
      environmentId: containerFixture!.id,
      terminalKey: "agent-docker-history",
      cols: 80,
      rows: 24,
      trackEnvironmentActivity: true,
    });
    try {
      await invoke("start_terminal_session", { sessionId: terminal.sessionId });
      await invoke("terminal_write", {
        sessionId: terminal.sessionId,
        data: "sleep 1; printf 'docker-background-done\\n'\n",
      });
      await invoke("get_projects");
      await expect
        .poll(
          async () => {
            const snapshot = await invoke<{ output: string } | null>(
              "get_terminal_state_snapshot",
              { sessionId: terminal.sessionId },
            );
            return snapshot?.output.includes("docker-background-done") ?? false;
          },
          { timeout: 30_000 },
        )
        .toBe(true);
    } finally {
      await invoke("detach_terminal", { sessionId: terminal.sessionId }).catch(() => undefined);
    }
  } finally {
    spawnSync("docker", ["rm", "-f", foreignContainerId], { encoding: "utf8" });
  }
});

test("Docker fixture ships a Playwright browser that launches for both container users", async ({
  page,
}) => {
  test.skip(
    process.env.ORKESTRATOR_AGENT_TEST_DOCKER !== "1",
    "requires an agent-test profile seeded with a container fixture",
  );
  // Chromium's first launch pays for process startup in a cold container.
  test.setTimeout(180_000);

  const status = await profileStatus();
  expect(status.status).toBe("ready");
  const invoke = await authenticatedInvoke(page, status);
  const projects = await invoke<Project[]>("get_projects");
  const fixture = projects.find((project) => project.localPath === status.testProject);
  expect(fixture).toBeTruthy();
  const environments = await invoke<Environment[]>("get_environments", { projectId: fixture!.id });
  const containerFixture = environments.find(
    (environment) => environment.name === "fixture-container",
  );
  expect(containerFixture?.containerId).toBeTruthy();
  expect(containerFixture?.status).toBe("running");
  const containerId = containerFixture!.containerId!;

  // Chromium puts renderer shared memory in /dev/shm. Docker's 64MB default is
  // well under what a real page needs and fails as a mid-run renderer crash, so
  // assert the mount the container was actually created with rather than the
  // argv that asked for it.
  const shm = spawnSync(
    "docker",
    ["exec", containerId, "sh", "-c", "df -k /dev/shm | awk 'NR==2 {print $2}'"],
    { encoding: "utf8", timeout: 30_000, killSignal: "SIGKILL" },
  );
  expect(shm.error, shm.stderr).toBeUndefined();
  expect(shm.status, shm.stderr).toBe(0);
  const shmMegabytes = Number(shm.stdout.trim()) / 1024;
  expect(shmMegabytes).toBeGreaterThanOrEqual(512);

  // The image build proves the browser starts at build time; this proves it in a
  // running container, where the firewall is up and the workspace is mounted —
  // and for both identities, because Chromium refuses to run as uid 0 unless
  // Playwright's default `chromiumSandbox: false` supplies --no-sandbox.
  for (const user of ["node", "orkroot"]) {
    const launch = spawnSync(
      "docker",
      [
        "exec",
        "-u",
        user,
        "-e",
        "NODE_PATH=/usr/local/share/npm-global/lib/node_modules",
        containerId,
        "node",
        "/usr/local/share/verify-playwright.cjs",
      ],
      { encoding: "utf8", timeout: 60_000, killSignal: "SIGKILL" },
    );
    expect(launch.error, `${user}: ${launch.stderr}`).toBeUndefined();
    expect(launch.status, `${user}: ${launch.stderr}`).toBe(0);
    expect(launch.stdout).toContain("chromium launch verified");
  }
});

test("review validation queues across worktrees and runs while its environment is inactive", async ({
  page,
}) => {
  const status = await profileStatus();
  const invoke = await authenticatedInvoke(page, status);
  const fixture = (await invoke<Project[]>("get_projects")).find(
    (project) => project.localPath === status.testProject,
  )!;
  const environments: Environment[] = [];
  let run: ReviewValidationRun | undefined;
  let blocker: ReviewValidationRun | undefined;
  try {
    for (const name of ["validation-active", "validation-other"]) {
      const environment = await invoke<Environment>("create_environment", {
        projectId: fixture.id,
        name: `${name}-${Date.now()}`,
        environmentType: "local",
        networkAccessMode: "restricted",
      });
      environments.push(environment);
      await invoke("start_environment", { environmentId: environment.id });
    }
    const [target, other] = environments;
    await page.goto(status.browserUrl!);
    await page.getByRole("button", { name: `Expand project ${fixture.name}` }).click();
    await page.getByText(target!.name, { exact: true }).first().click();
    const snapshot = await invoke<{ head: string; paths: string[] }>(
      "get_environment_uncommitted_paths",
      { environmentId: target!.id },
    );
    expect(snapshot.paths).toEqual([]);
    const otherSnapshot = await invoke<{ head: string; paths: string[] }>(
      "get_environment_uncommitted_paths",
      { environmentId: other!.id },
    );
    blocker = newReviewValidationRun(`review-validation-blocker-${Date.now()}`, {
      headRef: otherSnapshot.head,
      limitations: [],
      commands: [
        {
          id: "host-capacity",
          command: "sleep 6",
          cwd: ".",
          dependsOn: [],
          resources: [],
          weight: 2,
          timeoutMs: 10000,
        },
      ],
    });
    blocker = await invoke<ReviewValidationRun>("start_review_validation", {
      environmentId: other!.id,
      run: blocker,
    });
    await expect
      .poll(async () => {
        blocker = await invoke<ReviewValidationRun>("status_review_validation", {
          environmentId: other!.id,
          run: blocker,
        });
        return blocker.results[0]!.status;
      })
      .toBe("running");
    run = newReviewValidationRun(`review-validation-browser-${Date.now()}`, {
      headRef: snapshot.head,
      limitations: [],
      commands: [
        {
          id: "first",
          command: "sleep 2; printf validated",
          cwd: ".",
          dependsOn: [],
          resources: [],
          weight: 1,
          timeoutMs: 10000,
        },
        {
          id: "second",
          command: "printf independent",
          cwd: ".",
          dependsOn: [],
          resources: [],
          weight: 1,
          timeoutMs: 10000,
        },
      ],
    });
    run = await invoke<ReviewValidationRun>("start_review_validation", {
      environmentId: target!.id,
      run,
    });
    await expect
      .poll(async () => {
        run = await invoke<ReviewValidationRun>("status_review_validation", {
          environmentId: target!.id,
          run,
        });
        return run.results[0]!.status;
      })
      .toBe("queued");
    await page.mouse.move(1100, 20);
    await page.getByText(other!.name, { exact: true }).first().click();
    await expect
      .poll(
        async () => {
          run = await invoke<ReviewValidationRun>("status_review_validation", {
            environmentId: target!.id,
            run,
          });
          return run.status;
        },
        { timeout: 15000 },
      )
      .toBe("completed");
    expect(run.results.map((result) => result.status)).toEqual(["passed", "passed"]);
    expect(run.results[0]!.queuedMs).toBeGreaterThan(0);
    const completed = run;
    await page.reload();
    await page.getByRole("button", { name: `Expand project ${fixture.name}` }).click();
    await page.getByText(target!.name, { exact: true }).first().click();
    const restored = await invoke<ReviewValidationRun>("status_review_validation", {
      environmentId: target!.id,
      run,
    });
    expect(restored).toEqual(completed);
    expect(restored.results.every((result) => result.stdoutSha256?.length === 64)).toBe(true);
  } finally {
    if (blocker)
      await invoke("cancel_review_validation", {
        environmentId: environments[1]!.id,
        run: blocker,
      }).catch(() => undefined);
    if (run)
      await invoke("cancel_review_validation", { environmentId: environments[0]!.id, run }).catch(
        () => undefined,
      );
    for (const environment of environments) {
      await invoke("stop_environment", { environmentId: environment.id }).catch(() => undefined);
      await invoke("delete_environment", { environmentId: environment.id }).catch(() => undefined);
    }
  }
});
