import { expect, test, type Page } from "@playwright/test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * The public CLI and the real UI observe one backend: changes made through
 * the packaged `orkestrator` client against this profile appear in an open
 * renderer without a reload, and a reload rehydrates the same values.
 */

type Status = {
  status: string;
  browserUrl?: string;
  testProject?: string;
};
type Envelope<T> = {
  ok: boolean;
  result: T;
  error?: { code: string; message: string };
};
type ProjectSummary = { id: string; name: string; localPath: string | null };
type SettingsSnapshot = {
  revision: string;
  settings: Array<{ key: string; value: unknown }>;
};

const repositoryRoot = path.resolve(import.meta.dirname, "../..");
const profile = process.env.ORKESTRATOR_AGENT_TEST_PROFILE ?? "codex-qa";
const launcher = path.join(repositoryRoot, "packages", "cli", "bin", "orkestrator.js");

function profileStatus(): Status {
  const command = spawnSync("mise", ["run", "dev:status", "--profile", profile, "--json"], {
    cwd: repositoryRoot,
    encoding: "utf8",
  });
  if (!command.stdout.trim()) throw new Error(command.stderr || "dev:status returned no manifest");
  return JSON.parse(command.stdout) as Status;
}

/** Runs the packaged client against this profile; argv only, one JSON envelope. */
function cliRun<T>(configDir: string, args: string[]): { code: number; envelope: Envelope<T> } {
  const run = spawnSync("bun", [launcher, "--json", "--profile", profile, ...args], {
    cwd: repositoryRoot,
    encoding: "utf8",
    env: { ...process.env, ORKESTRATOR_CLI_CONFIG_DIR: configDir },
    timeout: 10 * 60_000,
  });
  try {
    return {
      code: run.status ?? -1,
      envelope: JSON.parse(run.stdout) as Envelope<T>,
    };
  } catch {
    throw new Error(
      `orkestrator ${args.slice(0, 2).join(" ")} printed no envelope (${run.status})`,
    );
  }
}

function cli<T>(configDir: string, args: string[]): T {
  const { code, envelope } = cliRun<T>(configDir, args);
  if (code !== 0 || !envelope.ok) {
    throw new Error(
      `orkestrator ${args.slice(0, 2).join(" ")} failed: ${envelope.error?.code ?? code}`,
    );
  }
  return envelope.result;
}

function deleteQuietly(configDir: string, environmentId: string) {
  spawnSync(
    "bun",
    [
      launcher,
      "--json",
      "--profile",
      profile,
      "environment",
      "delete",
      environmentId,
      "--wait",
      "deleted",
      "--timeout",
      "5m",
    ],
    {
      env: { ...process.env, ORKESTRATOR_CLI_CONFIG_DIR: configDir },
      timeout: 6 * 60_000,
    },
  );
}

async function fixtureProject(configDir: string, status: Status): Promise<ProjectSummary> {
  const { items } = cli<{ items: ProjectSummary[] }>(configDir, [
    "project",
    "list",
    "--limit",
    "100",
  ]);
  const fixture = items.find((project) => project.localPath === status.testProject);
  expect(fixture).toBeTruthy();
  return fixture!;
}

function readyEnvironment(configDir: string, projectId: string, name: string): string {
  const created = cli<{ environment: { id: string } }>(configDir, [
    "environment",
    "create",
    "--project",
    projectId,
    "--type",
    "local",
    "--name",
    name,
    "--request-id",
    name,
  ]);
  cli(configDir, [
    "environment",
    "start",
    created.environment.id,
    "--wait",
    "ready",
    "--timeout",
    "5m",
  ]);
  return created.environment.id;
}

async function login(page: Page) {
  // The one-shot login URL is parsed in memory and never copied into output.
  const command = spawnSync("mise", ["run", "dev:login", "--profile", profile, "--json"], {
    cwd: repositoryRoot,
    encoding: "utf8",
  });
  if (command.status !== 0) throw new Error(command.stderr || "dev:login failed");
  const { loginUrl } = JSON.parse(command.stdout) as { loginUrl?: unknown };
  if (typeof loginUrl !== "string") throw new Error("dev:login returned no login URL");
  const response = await page.goto(loginUrl, { waitUntil: "domcontentloaded" });
  expect(response?.ok() ?? false).toBe(true);
}

/**
 * Show a project's environments. A freshly started profile can take a while
 * to serve its first render, and a reused one may already be expanded.
 */
async function openProject(page: Page, projectName: string, timeout = 30_000) {
  const expand = page.getByRole("button", { name: `Expand project ${projectName}` });
  const collapse = page.getByRole("button", { name: `Collapse project ${projectName}` });
  await expect(expand.or(collapse)).toBeVisible({ timeout });
  if (await expand.isVisible()) await expand.click();
  await expect(collapse).toBeVisible();
}

async function prBaseBranchInDialog(page: Page, projectName: string): Promise<string> {
  await page.getByText(projectName, { exact: true }).first().click({ button: "right" });
  await page.getByRole("menuitem", { name: "Repository Settings" }).click();
  await page.getByText("Branches", { exact: true }).click();
  const field = page.locator("#prBaseBranch");
  await expect(field).toBeVisible({ timeout: 15_000 });
  const value = await field.inputValue();
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(field).toHaveCount(0);
  return value;
}

test("CLI changes reach an open renderer and survive a reload", async ({ page }) => {
  const status = profileStatus();
  expect(status.status).toBe("ready");
  expect(status.testProject).toBeTruthy();
  const configDir = mkdtempSync(path.join(os.tmpdir(), "ork-cli-ui-"));
  const suffix = Date.now().toString(36);
  let environmentId: string | undefined;
  let projectId: string | undefined;
  let restoreBase: string[] | undefined;
  try {
    // An explicit profile resolves through the running backend's descriptor.
    const fixture = await fixtureProject(configDir, status);
    projectId = fixture.id;

    await login(page);
    await page.goto(status.browserUrl!);
    await openProject(page, fixture.name, 120_000);

    const name = `cli-ui-${suffix}`;
    environmentId = readyEnvironment(configDir, projectId, name);
    // No reload: the open renderer picks the new environment up by itself.
    await expect(page.getByText(name, { exact: true }).first()).toBeVisible({
      timeout: 30_000,
    });

    const renamed = `cli-ui-renamed-${suffix}`;
    cli(configDir, ["environment", "rename", environmentId, renamed]);
    await expect(page.getByText(renamed, { exact: true }).first()).toBeVisible({
      timeout: 30_000,
    });
    await expect(page.getByText(name, { exact: true })).toHaveCount(0);

    const before = cli<SettingsSnapshot>(configDir, ["project", "config", "get", projectId]);
    const previous = before.settings.find((entry) => entry.key === "prBaseBranch")?.value;
    restoreBase =
      typeof previous === "string"
        ? ["--set", `prBaseBranch=${previous}`]
        : ["--unset", "prBaseBranch"];
    const branch = `cli-ui-base-${suffix}`;
    cli(configDir, [
      "project",
      "config",
      "set",
      projectId,
      "--set",
      `prBaseBranch=${branch}`,
      "--expected-revision",
      before.revision,
    ]);
    // The mounted renderer shows the CLI's value, and so does a fresh load.
    await expect
      .poll(() => prBaseBranchInDialog(page, fixture.name), { timeout: 30_000 })
      .toBe(branch);
    await page.reload();
    await openProject(page, fixture.name);
    expect(await prBaseBranchInDialog(page, fixture.name)).toBe(branch);
    await expect(page.getByText(renamed, { exact: true }).first()).toBeVisible({
      timeout: 30_000,
    });

    cli(configDir, [
      "environment",
      "delete",
      environmentId,
      "--wait",
      "deleted",
      "--timeout",
      "5m",
    ]);
    environmentId = undefined;
    await expect(page.getByText(renamed, { exact: true })).toHaveCount(0, {
      timeout: 30_000,
    });
  } finally {
    if (environmentId) deleteQuietly(configDir, environmentId);
    if (projectId && restoreBase) {
      spawnSync(
        "bun",
        [
          launcher,
          "--json",
          "--profile",
          profile,
          "project",
          "config",
          "set",
          projectId,
          ...restoreBase,
        ],
        {
          env: { ...process.env, ORKESTRATOR_CLI_CONFIG_DIR: configDir },
          timeout: 60_000,
        },
      );
    }
    rmSync(configDir, { recursive: true, force: true });
  }
});

test("a CLI-initialized project and its cascade removal reach an open renderer", async ({
  page,
}) => {
  const status = profileStatus();
  expect(status.status).toBe("ready");
  const configDir = mkdtempSync(path.join(os.tmpdir(), "ork-cli-ui-"));
  // The backend shares this machine, so a temporary directory is a backend path.
  const parent = mkdtempSync(path.join(os.tmpdir(), "ork-cli-ui-init-"));
  const suffix = Date.now().toString(36);
  const projectName = `cli-init-${suffix}`;
  let projectId: string | undefined;
  try {
    await login(page);
    await page.goto(status.browserUrl!);
    const created = cli<{ project: ProjectSummary }>(configDir, [
      "project",
      "init",
      "--path",
      path.join(parent, projectName),
      "--request-id",
      `init-${suffix}`,
    ]);
    projectId = created.project.id;
    // No reload: the new local-only project appears by itself.
    await openProject(page, created.project.name, 120_000);

    const environmentName = `cli-cascade-${suffix}`;
    readyEnvironment(configDir, projectId, environmentName);
    await expect(page.getByText(environmentName, { exact: true }).first()).toBeVisible({
      timeout: 30_000,
    });

    const refused = cliRun(configDir, ["project", "remove", projectId]);
    expect(refused.code).toBe(8);
    expect(refused.envelope.error?.code).toBe("not-empty");
    cli(configDir, [
      "project",
      "remove",
      projectId,
      "--cascade",
      "--wait",
      "--timeout",
      "5m",
      "--request-id",
      `cascade-${suffix}`,
    ]);
    projectId = undefined;
    // The open renderer drops both, and a fresh load does not bring them back.
    await expect(page.getByText(environmentName, { exact: true })).toHaveCount(0, {
      timeout: 30_000,
    });
    await expect(
      page.getByRole("button", { name: `Collapse project ${created.project.name}` }),
    ).toHaveCount(0, { timeout: 30_000 });
    await page.reload();
    // The sidebar has rendered once the profile's own fixture project shows.
    await openProject(page, (await fixtureProject(configDir, status)).name, 120_000);
    await expect(page.getByText(environmentName, { exact: true })).toHaveCount(0);
    await expect(
      page.getByRole("button", {
        name: new RegExp(`(Expand|Collapse) project ${created.project.name}$`),
      }),
    ).toHaveCount(0, { timeout: 30_000 });
  } finally {
    if (projectId) {
      spawnSync(
        "bun",
        [
          launcher,
          "--json",
          "--profile",
          profile,
          "project",
          "remove",
          projectId,
          "--cascade",
          "--wait",
          "--timeout",
          "5m",
        ],
        {
          env: { ...process.env, ORKESTRATOR_CLI_CONFIG_DIR: configDir },
          timeout: 6 * 60_000,
        },
      );
    }
    rmSync(parent, { recursive: true, force: true });
    rmSync(configDir, { recursive: true, force: true });
  }
});

test("a CLI-started question rehydrates in an inactive, reloaded renderer and takes the UI's answer", async ({
  page,
}, testInfo) => {
  test.skip(
    process.env.ORKESTRATOR_AGENT_TEST_LIVE_CLI !== "1",
    "Needs ORKESTRATOR_AGENT_TEST_LIVE_CLI=1 and a profile started with --credential-source claude",
  );
  testInfo.setTimeout(900_000);
  const status = profileStatus();
  expect(status.status).toBe("ready");
  const configDir = mkdtempSync(path.join(os.tmpdir(), "ork-cli-ui-live-"));
  const suffix = Date.now().toString(36);
  const created: string[] = [];
  try {
    const fixture = await fixtureProject(configDir, status);
    const asking = readyEnvironment(configDir, fixture.id, `cli-ask-${suffix}`);
    created.push(asking);
    const other = readyEnvironment(configDir, fixture.id, `cli-other-${suffix}`);
    created.push(other);

    // The renderer shows another environment while the question arrives.
    await login(page);
    await page.goto(status.browserUrl!);
    await openProject(page, fixture.name, 120_000);
    await page.getByText(`cli-other-${suffix}`, { exact: true }).first().click();

    const prompt = path.join(configDir, "prompt.txt");
    writeFileSync(
      prompt,
      "Use your AskUserQuestion tool to ask me one question: which colour should be used, " +
        "with exactly two options labelled red and blue. After I answer, create a file named " +
        "colour.txt in the repository root containing only the chosen colour in lowercase. " +
        "Do nothing else.\n",
    );
    const started = cliRun(configDir, [
      "session",
      "start",
      "--environment",
      asking,
      "--agent",
      "claude",
      "--mode",
      "build",
      "--prompt-file",
      prompt,
      "--request-id",
      `cli-ask-${suffix}`,
      "--wait",
      "--timeout",
      "5m",
    ]);
    // Exit 6: the run is waiting for an answer, which the CLI reports as such.
    expect(started.code).toBe(6);
    // The receipt, not a result, identifies the run and session here.
    const receipt = (
      started.envelope as unknown as {
        receipt: {
          operationId: string;
          resources: { sessionId?: string };
          execution?: {
            interactions?: Array<{ id: string; revision: number }>;
          };
        };
      }
    ).receipt;
    const pending = receipt.execution?.interactions?.[0];
    expect(pending).toBeTruthy();
    const runId = receipt.operationId;
    const sessionId = receipt.resources.sessionId!;
    expect(sessionId).toBeTruthy();

    // Reload while the asking environment is not mounted, then open it.
    await page.reload();
    await openProject(page, fixture.name);
    await page.getByText(`cli-other-${suffix}`, { exact: true }).first().click();
    await page.getByText(`cli-ask-${suffix}`, { exact: true }).first().click();
    // Option names carry their descriptions ("blue Use blue").
    const card = page.getByRole("group", { name: "Claude needs input" });
    await expect(card).toBeVisible({ timeout: 60_000 });
    await card.getByRole("button", { name: /^blue\b/ }).click();
    await card.getByRole("button", { name: "Submit", exact: true }).click();

    const settled = cliRun(configDir, ["run", "wait", runId, "--timeout", "5m"]);
    expect(settled.code).toBe(0);
    const cat = cliRun(configDir, [
      "environment",
      "exec",
      asking,
      "--wait",
      "--",
      "cat",
      "colour.txt",
    ]);
    expect(cat.code).toBe(0);
    const operation = (cat.envelope as unknown as { receipt: { operationId: string } }).receipt
      .operationId;
    const output = cli<{ text: string }>(configDir, ["run", "output", operation]);
    expect(output.text.trim()).toBe("blue");

    // The answered question cannot be answered again, even with its exact revision.
    const stale = cliRun(configDir, [
      "session",
      "interactions",
      "resolve",
      sessionId,
      pending!.id,
      "--revision",
      String(pending!.revision),
      "--action",
      "cancel",
    ]);
    expect(stale.envelope.ok).toBe(false);
    expect(stale.code).not.toBe(0);

    await page.reload();
    await openProject(page, fixture.name);
    await page.getByText(`cli-ask-${suffix}`, { exact: true }).first().click();
    // The transcript is back and the answered question is gone.
    await expect(page.getByText("Which colour", { exact: false }).first()).toBeVisible({
      timeout: 30_000,
    });
    await expect(page.getByRole("group", { name: "Claude needs input" })).toHaveCount(0);
  } finally {
    for (const environmentId of created) deleteQuietly(configDir, environmentId);
    rmSync(configDir, { recursive: true, force: true });
  }
});

test("live Codex conversation resumes after moving its worktree", async ({ page }, testInfo) => {
  test.skip(
    process.env.ORKESTRATOR_AGENT_TEST_LIVE_MOVE !== "1",
    "Needs a disposable profile with --credential-source codex and ORKESTRATOR_AGENT_TEST_LIVE_MOVE=1",
  );
  testInfo.setTimeout(900_000);
  const status = profileStatus();
  const configDir = mkdtempSync(path.join(os.tmpdir(), "ork-live-move-"));
  let environmentId: string | undefined;
  try {
    const fixture = await fixtureProject(configDir, status);
    const suffix = Date.now().toString(36);
    environmentId = readyEnvironment(configDir, fixture.id, `live-move-${suffix}`);
    await login(page);
    const invoke = async <T>(command: string, args: Record<string, unknown>): Promise<T> => {
      const response = await page.request.post(
        new URL("/__orkestrator/invoke", status.browserUrl!).href,
        { data: { command, args } },
      );
      expect(response.ok(), `Command failed: ${command}`).toBe(true);
      return ((await response.json()) as { result: T }).result;
    };
    const original = (await invoke<{ worktreePath: string }>("get_environment", { environmentId }))
      .worktreePath;
    const prompt = path.join(configDir, "prompt.txt");
    const memory = `move-memory-${suffix}`;
    writeFileSync(
      prompt,
      `Remember this phrase for the next turn: ${memory}. Reply only Ready. Do not create any files.\n`,
    );
    const first = cliRun(configDir, [
      "session",
      "start",
      "--environment",
      environmentId,
      "--agent",
      "codex",
      "--mode",
      "build",
      "--model",
      process.env.ORKESTRATOR_AGENT_TEST_MOVE_MODEL ?? "gpt-6-sol",
      "--prompt-file",
      prompt,
      "--request-id",
      `move-first-${suffix}`,
      "--wait",
      "--timeout",
      "5m",
    ]);
    expect(
      first.code,
      `First turn failure code: ${first.envelope.error?.code ?? "run-failed"}`,
    ).toBe(0);
    const sessionId = (
      first.envelope as unknown as { receipt: { resources: { sessionId: string } } }
    ).receipt.resources.sessionId;
    expect(sessionId).toBeTruthy();
    // Wait for authoritative activity reconciliation before opening settings.
    await expect
      .poll(
        async () =>
          (await invoke<{ agentActivityState?: string }>("get_environment", { environmentId }))
            .agentActivityState ?? "idle",
        { timeout: 30_000 },
      )
      .toBe("idle");
    const moved = await invoke<{ worktreePath: string; lifecycleError?: string }>(
      "move_environment",
      { environmentId, destinationDir: path.join(configDir, "destination") },
    );
    expect(moved.lifecycleError).toBeFalsy();
    await page.reload();
    writeFileSync(
      prompt,
      "Create a file named remembered.txt in your current working directory containing only the phrase I asked you to remember in the preceding turn. Do nothing else.\n",
    );
    const second = cliRun(configDir, [
      "session",
      "prompt",
      sessionId,
      "--prompt-file",
      prompt,
      "--request-id",
      `move-followup-${suffix}`,
      "--wait",
      "--timeout",
      "5m",
    ]);
    expect(
      second.code,
      `Follow-up failure code: ${second.envelope.error?.code ?? "run-failed"}`,
    ).toBe(0);
    const { promises: filesystem } = await import("node:fs");
    expect(
      (await filesystem.readFile(path.join(moved.worktreePath, "remembered.txt"), "utf8")).trim(),
    ).toBe(memory);
    expect(
      await filesystem.stat(original).then(
        () => true,
        () => false,
      ),
    ).toBe(false);
  } finally {
    if (environmentId) deleteQuietly(configDir, environmentId);
    rmSync(configDir, { recursive: true, force: true });
  }
});
