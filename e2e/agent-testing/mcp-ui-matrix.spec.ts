/**
 * MCP settings and live-panel UI against a real `dev:test --fixture` profile,
 * with no model turn that can reach a provider (docs/todo/mcp/0039, task 8).
 *
 * - The editor's conflict recovery: a save whose source file changed under the
 *   open review is refused, "Reload latest and review again" carries the draft
 *   onto the new revision, and the second save keeps the outside change.
 * - Secret replacement on a backend-user (`~/.claude.json`) server: the saved
 *   value is shown only as "Value saved", replacing it writes the new value,
 *   and neither value is rendered back, before or after a reload.
 * - A Claude session with one healthy and one failing stdio server: reconnect
 *   from the live MCP panel, then a page reload, with the panel matching the
 *   backend's projection.
 *
 * Both editor flows run at a desktop and a 390-pixel viewport. The live-panel
 * case starts Claude's CLI with a turn, so it runs only on a profile that
 * authorizes no Claude credentials (`--no-agent-credentials`): the CLI
 * connects its MCP servers, reports them, then ends the turn "Not logged in"
 * without a model call. Every write goes to a file inside the profile: a
 * disposable environment's `.mcp.json` and the profile's isolated
 * `~/.claude.json`. Opt-in, so a credentialed default run never starts it:
 *
 *   mise run dev:test --profile mcp-ui --fixture --no-agent-credentials --agent-platforms claude
 *   ORKESTRATOR_AGENT_TEST_PROFILE=mcp-ui ORKESTRATOR_AGENT_TEST_MCP_UI=1 \
 *     mise run test:agent:browser -- e2e/agent-testing/mcp-ui-matrix.spec.ts
 */
import { expect, test, type Locator, type Page, type TestInfo } from "@playwright/test";
import { spawnSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

import type {
  McpConfigSource,
  McpManagementSnapshot,
  McpManagementTarget,
  McpMutationOperation,
  McpMutationResult,
} from "@orkestrator/protocol/mcp-management";
import type { NativeAgentMcpServer } from "@orkestrator/protocol/native-agent";
import { PANE_LAYOUT_VERSION } from "@orkestrator/protocol/pane-layout";
import { loadAppWithDevRetry } from "./dev-startup-retry";
import { writableSourcePath } from "./mcp-apply-live-safety";
import { dismissSidebarTooltip } from "./sidebar-tooltip";

type Status = {
  status: string;
  profile?: string;
  flavor?: string;
  browserUrl?: string;
  testProject?: string;
  dataDir?: string;
};
type Project = { id: string; name: string; localPath: string | null };
type Environment = { id: string; name: string; worktreePath?: string | null };
type Projection = {
  turn: { phase: string; error?: string };
  runtime?: { mcp?: NativeAgentMcpServer[] };
} | null;
type Invoke = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;

const repositoryRoot = path.resolve(import.meta.dirname, "../..");
const profile = process.env.ORKESTRATOR_AGENT_TEST_PROFILE ?? "codex-qa";
const runId = process.env.ORKESTRATOR_AGENT_TEST_RUN_ID ?? profile;
const OPT_IN = process.env.ORKESTRATOR_AGENT_TEST_MCP_UI === "1";
const DESKTOP = { width: 1440, height: 1000 };
const VIEWPORTS = [
  { label: "desktop", size: DESKTOP },
  { label: "narrow", size: { width: 390, height: 844 } },
] as const;
const PROBE_SERVER = path.join(import.meta.dirname, "mcp-probe-server.mjs");

function manifest<T>(task: string): T {
  const command = spawnSync("mise", ["run", task, "--profile", profile, "--json"], {
    cwd: repositoryRoot,
    encoding: "utf8",
    timeout: 60_000,
  });
  if (command.status !== 0 || !command.stdout.trim()) {
    throw new Error(`${task} for profile "${profile}" failed: ${command.stderr.trim()}`);
  }
  return JSON.parse(command.stdout) as T;
}

/** The host credential sources the profile was started with (`profile.json`). */
function profileCredentialSources(status: Status): string[] | null {
  const file = path.join(path.dirname(status.dataDir!), "profile.json");
  if (!existsSync(file)) return null;
  const record = JSON.parse(readFileSync(file, "utf8")) as { credentialSources?: unknown };
  return Array.isArray(record.credentialSources)
    ? record.credentialSources.filter((value): value is string => typeof value === "string")
    : null;
}

/**
 * Close the notices a credential-free local profile opens on: the optional
 * tools and, on a host whose firewall drops container traffic, the container
 * notice. None gates a local worktree. They can stack, so the handler closes
 * whichever is on top until none is left.
 */
async function closeStartupNotices(page: Page) {
  const notices = [
    page.getByRole("button", { name: "Continue Without Claude", exact: true }),
    page.getByRole("button", { name: "Continue Without Docker", exact: true }),
    page.getByRole("button", { name: "Continue Without GitHub CLI", exact: true }),
    page
      .getByRole("dialog", { name: "Docker containers can't reach Orkestrator", exact: true })
      .getByRole("button", { name: "Close", exact: true })
      .last(),
  ];
  const anyNotice = notices.slice(1).reduce((all, notice) => all.or(notice), notices[0]!);
  await page.addLocatorHandler(
    anyNotice.first(),
    async () => {
      for (let round = 0; round < 8; round += 1) {
        let closed = false;
        for (const notice of notices) {
          if (!(await notice.isVisible())) continue;
          closed = await notice
            .click({ timeout: 2_000 })
            .then(() => true)
            .catch(() => false);
          if (closed) break;
        }
        if (!closed) return;
      }
    },
    { noWaitAfter: true },
  );
}

/** Sign in through a single-use login URL (never the gateway token) and return an invoker. */
async function signIn(page: Page, testInfo: TestInfo, status: Status): Promise<Invoke> {
  const login = manifest<{ loginUrl?: unknown }>("dev:login");
  if (typeof login.loginUrl !== "string") throw new Error("dev:login returned no login URL");
  const loginUrl = login.loginUrl;
  await closeStartupNotices(page);
  await loadAppWithDevRetry(page, testInfo, () => page.goto(loginUrl));
  return async <T>(command: string, args: Record<string, unknown> = {}): Promise<T> => {
    const response = await page.request.post(
      new URL("/__orkestrator/invoke", status.browserUrl!).href,
      { data: { command, args }, timeout: 120_000 },
    );
    expect(response.ok(), `${command}: ${await response.text()}`).toBe(true);
    return ((await response.json()) as { result: T }).result;
  };
}

/** A disposable local environment with one Claude tab, as the UI would persist it. */
async function claudeEnvironment(invoke: Invoke, project: Project, prefix: string) {
  const environment = await invoke<Environment>("create_environment", {
    projectId: project.id,
    name: `${prefix}-${Date.now()}`,
    networkAccessMode: "restricted",
    environmentType: "local",
    agentSettings: { executionPolicy: { projectResources: true, approvals: "auto-approve" } },
  });
  await invoke("start_environment", { environmentId: environment.id });
  const worktree = (await invoke<Environment>("get_environment", { environmentId: environment.id }))
    .worktreePath;
  expect(worktree, "a local environment has a worktree").toBeTruthy();
  const tabId = `mcpui-${environment.id.slice(0, 8)}`;
  const layout = await invoke<{ revision?: number } | null>("get_pane_layout", {
    environmentId: environment.id,
  });
  await invoke("save_pane_layout", {
    environmentId: environment.id,
    expectedRevision: layout?.revision ?? 0,
    layout: {
      version: PANE_LAYOUT_VERSION,
      containerId: null,
      activePaneId: "pane-mcpui",
      root: {
        kind: "leaf",
        id: "pane-mcpui",
        activeTabId: tabId,
        tabs: [
          {
            id: tabId,
            type: "agent-native",
            nativeAgentData: { environmentId: environment.id, platform: "claude", isLocal: true },
          },
        ],
      },
    },
  });
  return {
    environment,
    worktree: worktree!,
    identity: {
      environmentId: environment.id,
      agent: "claude",
      logicalSessionKey: `env-${environment.id}:${tabId}`,
    },
  };
}

/** The MCP-management commands the settings UI itself uses. */
function mcpCommands(invoke: Invoke) {
  const target = async (environmentId: string) => {
    const list = await invoke<{ targets: McpManagementTarget[] }>("list_mcp_management_targets", {
      environmentId,
    });
    const found = list.targets.find(
      (candidate) =>
        candidate.provider === "claude" &&
        candidate.context.kind === "environment" &&
        candidate.context.environmentId === environmentId,
    );
    expect(found, `no Claude MCP target for ${environmentId}`).toBeTruthy();
    return found!;
  };
  const snapshot = (targetId: string) =>
    invoke<McpManagementSnapshot>("get_mcp_management_snapshot", { targetId });
  const source = async (targetId: string, scope: McpConfigSource["scope"]) => {
    const found = (await snapshot(targetId)).sources.find((candidate) => candidate.scope === scope);
    expect(found, `no ${scope} source`).toBeTruthy();
    expect(found!.writable, `${scope} source is read-only: ${found!.readOnlyReason}`).toBe(true);
    return found!;
  };
  const save = async (targetId: string, operation: McpMutationOperation) => {
    const result = await invoke<McpMutationResult>("mutate_mcp_definition", {
      mutation: { requestId: `mcpui-${randomUUID()}`, targetId, applyIntent: "save", operation },
    });
    expect(result.operation.phase, result.operation.message).toBe("saved");
    return result;
  };
  const add = async (
    targetId: string,
    scope: McpConfigSource["scope"],
    definition: Extract<McpMutationOperation, { kind: "add" }>["definition"],
  ) => {
    const into = await source(targetId, scope);
    return save(targetId, {
      kind: "add",
      sourceId: into.sourceId,
      expectedRevision: into.revision,
      definition,
    });
  };
  const remove = async (targetId: string, scope: McpConfigSource["scope"], name: string) => {
    const current = await snapshot(targetId);
    const into = current.sources.find((candidate) => candidate.scope === scope);
    const definition = current.definitions.find(
      (candidate) => candidate.sourceId === into?.sourceId && candidate.name === name,
    );
    if (!into?.revision || !definition) return;
    await save(targetId, {
      kind: "remove",
      entryId: definition.entryId,
      expectedRevision: into.revision,
    });
  };
  return { target, source, add, remove };
}

const stdio = (name: string, script: string, extra: string[] = []) => ({
  name,
  transport: "stdio" as const,
  command: process.execPath,
  args: [script, "--label", name, ...extra],
});

/** Open an environment from the sidebar and wait for its Claude tab's composer. */
async function openEnvironment(page: Page, projectName: string, name: string) {
  const expand = page.getByRole("button", { name: `Expand project ${projectName}` });
  const entry = page.getByRole("button", { name: new RegExp(`^${name}\\b`) }).first();
  await expect(async () => {
    await expect(expand.or(entry).first()).toBeVisible();
    if (await expand.isVisible()) await expand.click();
    await dismissSidebarTooltip(page, projectName);
    await entry.click();
    await expect(page.getByTestId("shared-native-compose-bar")).toBeVisible({ timeout: 15_000 });
  }).toPass({ timeout: 120_000 });
}

/** The visible Claude tab's agent panel. */
async function openAgentPanel(page: Page) {
  await page.getByRole("button", { name: "Open agent information" }).first().click();
  const panel = page.getByRole("dialog", { name: "Agent information" });
  await expect(panel).toBeVisible();
  return panel;
}

/**
 * Open MCP settings for this environment from its agent panel. Settings is a
 * lazy chunk; when the dev server drops that one module fetch under load
 * (flake 0167's cause), the boundary offers a reload, and the open is retried.
 */
async function openSettings(page: Page, testInfo: TestInfo, projectName: string, name: string) {
  const reloadApp = page.getByRole("button", { name: "Reload application", exact: true });
  await expect(async () => {
    if (await reloadApp.isVisible()) {
      testInfo.annotations.push({ type: "retry", description: "lazy settings chunk reloaded" });
      await loadAppWithDevRetry(page, testInfo, () => reloadApp.click());
    }
    await openEnvironment(page, projectName, name);
    await openAgentPanel(page);
    await page.getByRole("button", { name: "Manage saved MCP servers…" }).click();
    await expect(page.getByRole("heading", { name: "MCP servers for your agents" })).toBeVisible({
      timeout: 15_000,
    });
  }).toPass({ timeout: 180_000 });
  await expect(page.getByRole("combobox", { name: "Configuration for" })).toHaveText(
    `${name} (worktree)`,
    { timeout: 30_000 },
  );
}

/** One server row of the live MCP panel. */
const panelRow = (panel: Locator, name: string) =>
  panel.locator("div.flex.flex-col").filter({ hasText: name }).first();

/** Fixture secrets: random, typed only into the field under test, never printed. */
const secret = (tag: string) => `mcpui-${tag}-${randomBytes(9).toString("hex")}`;

test.describe("MCP settings and live panel UI matrix (claude)", () => {
  test.skip(!OPT_IN, "opt-in: set ORKESTRATOR_AGENT_TEST_MCP_UI=1");

  let status: Status;
  let runDir: string;
  test.beforeEach(() => {
    status = manifest<Status>("dev:status");
    expect(status.profile, "dev:status answered for a different profile").toBe(profile);
    expect(status.status, `profile "${profile}" is not running`).toBe("ready");
    expect(status.flavor).toBe("agent-test");
    runDir = path.join(repositoryRoot, "output", "agent-testing", runId, "mcp-ui-matrix");
    mkdirSync(runDir, { recursive: true });
  });

  test("editor: conflict recovery and secret replacement at desktop and narrow widths", async ({
    page,
  }, testInfo) => {
    test.setTimeout(600_000);
    page.setDefaultTimeout(15_000);
    await page.setViewportSize(DESKTOP);
    const invoke = await signIn(page, testInfo, status);
    const project = (await invoke<Project[]>("get_projects")).find(
      (candidate) => candidate.localPath === status.testProject,
    );
    expect(project, "the fixture project is missing").toBeTruthy();
    const mcp = mcpCommands(invoke);
    const { environment, worktree } = await claudeEnvironment(invoke, project!, "mcpui-editor");
    const boundary = { flavor: status.flavor, dataDir: status.dataDir!, worktree };
    const removals: Array<() => Promise<void>> = [];
    let userFile: string | null = null;
    let userBefore: string | undefined;
    try {
      const target = await mcp.target(environment.id);
      const projectSource = await mcp.source(target.targetId, "project");
      const userSource = await mcp.source(target.targetId, "backend-user");
      // Writes land only in this environment's worktree or the profile's HOME.
      const projectFile = writableSourcePath(projectSource, boundary);
      userFile = writableSourcePath(userSource, boundary);
      expect(projectFile, `${projectSource.displayPath} is outside the worktree`).toBeTruthy();
      expect(projectFile!.startsWith(worktree)).toBe(true);
      expect(userFile, `${userSource.displayPath} is outside the profile`).toBeTruthy();
      expect(userFile!.startsWith(status.dataDir!), "the user file is not the profile's").toBe(
        true,
      );
      userBefore = existsSync(userFile!) ? readFileSync(userFile!, "utf8") : undefined;

      const editor = page
        .getByRole("dialog")
        .filter({ has: page.getByRole("heading", { name: /^Edit / }) });
      const saveButton = editor.getByRole("button", { name: "Save", exact: true });
      const reviewButton = editor.getByRole("button", { name: "Review change" });
      const settingsHeading = page.getByRole("heading", { name: "MCP servers for your agents" });

      for (const viewport of VIEWPORTS) {
        const shot = (name: string) =>
          page.screenshot({ path: path.join(runDir, `editor-${viewport.label}-${name}.png`) });
        const conflictName = `mcpui-conflict-${viewport.label}`;
        const outsideName = `mcpui-outside-${viewport.label}`;
        const secretName = `mcpui-secret-${viewport.label}`;
        const oldSecret = secret("old");
        const newSecret = secret("new");
        await mcp.add(
          target.targetId,
          "project",
          stdio(conflictName, PROBE_SERVER, ["--tag", "v1"]),
        );
        await mcp.add(target.targetId, "backend-user", {
          ...stdio(secretName, PROBE_SERVER),
          env: [{ key: "MCPUI_TOKEN", value: oldSecret }],
        });
        removals.push(() => mcp.remove(target.targetId, "backend-user", secretName));
        const neverShown = async (where: string) => {
          // The serialized DOM, attributes included, not just visible text.
          const html = await page.content();
          expect(html.includes(oldSecret), `the saved secret is in the page (${where})`).toBe(
            false,
          );
          expect(html.includes(newSecret), `the new secret is in the page (${where})`).toBe(false);
        };
        const editServer = async (name: string) => {
          await page.getByRole("button", { name: `Edit ${name}` }).click();
          await expect(editor).toBeVisible();
        };

        // The sidebar is a drawer at phone width, so settings are opened at
        // desktop width and the page is then narrowed under them.
        await page.setViewportSize(DESKTOP);
        await loadAppWithDevRetry(page, testInfo, () => page.goto(status.browserUrl!));
        await openSettings(page, testInfo, project!.name, environment.name);
        await page.setViewportSize(viewport.size);
        await expect(settingsHeading).toBeVisible();

        await test.step(`${viewport.label}: a save over a changed file reloads and keeps both changes`, async () => {
          await editServer(conflictName);
          // Arguments: script, --label, name, --tag, v1.
          const tagArgument = editor.getByRole("textbox", { name: "Argument 5" });
          await expect(tagArgument).toHaveValue("v1");
          await tagArgument.fill("v2");
          await reviewButton.click();
          await expect(saveButton).toBeVisible();
          // Another writer changes the same file while the review is open.
          const onDisk = JSON.parse(readFileSync(projectFile!, "utf8")) as {
            mcpServers: Record<string, unknown>;
          };
          onDisk.mcpServers[outsideName] = {
            command: process.execPath,
            args: [PROBE_SERVER, "--label", outsideName],
          };
          writeFileSync(projectFile!, `${JSON.stringify(onDisk, null, 2)}\n`);
          await saveButton.click();
          const reload = editor.getByRole("button", { name: "Reload latest and review again" });
          await expect(reload).toBeVisible();
          await expect(editor.getByRole("alert")).toBeVisible();
          // Refused: the file still has v1 next to the outside entry.
          const refused = JSON.parse(readFileSync(projectFile!, "utf8")) as {
            mcpServers: Record<string, { args?: string[] }>;
          };
          expect(refused.mcpServers[conflictName]?.args?.[4]).toBe("v1");
          await shot("conflict");
          await reload.click();
          // The edit is carried onto the latest revision, not dropped.
          await expect(tagArgument).toHaveValue("v2");
          await expect(reload).toBeHidden();
          await shot("conflict-reloaded");
          await reviewButton.click();
          await saveButton.click();
          await expect(editor).toBeHidden();
          const saved = JSON.parse(readFileSync(projectFile!, "utf8")) as {
            mcpServers: Record<string, { args?: string[] }>;
          };
          expect(saved.mcpServers[conflictName]?.args?.[4]).toBe("v2");
          expect(saved.mcpServers[outsideName], "the outside change was lost").toBeTruthy();
          await expect(page.getByRole("button", { name: `Edit ${outsideName}` })).toBeVisible({
            timeout: 30_000,
          });
          await shot("conflict-saved");
        });

        await test.step(`${viewport.label}: replacing a saved secret never shows either value`, async () => {
          await neverShown("settings list");
          await editServer(secretName);
          await expect(
            editor.getByRole("textbox", { name: "Environment variables name 1" }),
          ).toHaveValue("MCPUI_TOKEN");
          await expect(editor.getByText("Value saved", { exact: true })).toBeVisible();
          await expect(
            editor.getByRole("textbox", { name: "Environment variables value 1" }),
          ).toHaveCount(0);
          await neverShown("editor, before replacing");
          await shot("secret-saved");
          await editor.getByRole("button", { name: "Replace", exact: true }).click();
          const value = editor.getByRole("textbox", { name: "Environment variables value 1" });
          await expect(value).toHaveValue("");
          await value.fill(newSecret);
          await reviewButton.click();
          await expect(saveButton).toBeVisible();
          await neverShown("review");
          await shot("secret-review");
          await saveButton.click();
          await expect(editor).toBeHidden();
          await neverShown("after save");
          const written = JSON.parse(readFileSync(userFile!, "utf8")) as {
            mcpServers?: Record<string, { env?: Record<string, string> }>;
          };
          // Compared in memory, never printed.
          expect(
            written.mcpServers?.[secretName]?.env?.MCPUI_TOKEN === newSecret,
            "the replaced value did not reach the user file",
          ).toBe(true);
          await editServer(secretName);
          await expect(editor.getByText("Value saved", { exact: true })).toBeVisible();
          await neverShown("editor, reopened");
          await shot("secret-reopened");
          await editor.getByRole("button", { name: "Cancel" }).click();
          await expect(editor).toBeHidden();
        });

        await test.step(`${viewport.label}: after a reload both rows read back from the backend`, async () => {
          await loadAppWithDevRetry(page, testInfo, () => page.reload());
          await neverShown("reloaded page");
          await page.setViewportSize(DESKTOP);
          await openSettings(page, testInfo, project!.name, environment.name);
          await page.setViewportSize(viewport.size);
          await editServer(conflictName);
          await expect(editor.getByRole("textbox", { name: "Argument 5" })).toHaveValue("v2");
          await editor.getByRole("button", { name: "Cancel" }).click();
          await editServer(secretName);
          await expect(editor.getByText("Value saved", { exact: true })).toBeVisible();
          await neverShown("editor after reload");
          await shot("after-reload");
          await editor.getByRole("button", { name: "Cancel" }).click();
          await page.getByRole("button", { name: "Close settings" }).click();
        });
      }
    } finally {
      for (const removal of removals) await removal().catch(() => undefined);
      // A user file this case created is removed again once it holds nothing.
      if (userFile && userBefore === undefined && existsSync(userFile)) {
        const left = JSON.parse(readFileSync(userFile, "utf8")) as Record<string, unknown>;
        const servers = left.mcpServers as Record<string, unknown> | undefined;
        if (servers && Object.keys(servers).length === 0) delete left.mcpServers;
        if (Object.keys(left).length === 0) rmSync(userFile);
      }
      await invoke("stop_environment", { environmentId: environment.id }).catch(() => undefined);
      await invoke("delete_environment", { environmentId: environment.id }).catch(() => undefined);
    }
  });

  test("live panel: reconnect a failing server beside a healthy one, then reload", async ({
    page,
  }, testInfo) => {
    test.setTimeout(420_000);
    page.setDefaultTimeout(15_000);
    const sources = profileCredentialSources(status);
    // The turn below must not be able to reach a model.
    test.skip(
      sources === null || sources.includes("claude"),
      "starts Claude's CLI with a turn: needs a profile started with --no-agent-credentials",
    );
    await page.setViewportSize(DESKTOP);
    const invoke = await signIn(page, testInfo, status);
    const project = (await invoke<Project[]>("get_projects")).find(
      (candidate) => candidate.localPath === status.testProject,
    );
    expect(project, "the fixture project is missing").toBeTruthy();
    const mcp = mcpCommands(invoke);
    const { environment, worktree, identity } = await claudeEnvironment(
      invoke,
      project!,
      "mcpui-live",
    );
    const probeLog = path.join(runDir, `live-${environment.id.slice(0, 8)}.jsonl`);
    // Missing until the step that brings the server back, so node exits at once.
    const lateScript = path.join(runDir, `late-server-${environment.id.slice(0, 8)}.mjs`);
    rmSync(lateScript, { force: true });
    const shot = (name: string) => page.screenshot({ path: path.join(runDir, `live-${name}.png`) });
    const record = (type: string, description: string) =>
      testInfo.annotations.push({ type, description });
    try {
      const target = await mcp.target(environment.id);
      const projectSource = await mcp.source(target.targetId, "project");
      const projectFile = writableSourcePath(projectSource, {
        flavor: status.flavor,
        dataDir: status.dataDir!,
        worktree,
      });
      expect(projectFile?.startsWith(worktree), "the project file is outside the worktree").toBe(
        true,
      );
      await mcp.add(
        target.targetId,
        "project",
        stdio("mcpui-ok", PROBE_SERVER, ["--log", probeLog]),
      );
      await mcp.add(
        target.targetId,
        "project",
        stdio("mcpui-late", lateScript, ["--log", probeLog]),
      );

      const projection = () => invoke<Projection>("get_native_agent_projection", identity);
      const liveServers = async () => (await projection())?.runtime?.mcp ?? [];
      const describe = (servers: NativeAgentMcpServer[]) =>
        servers.map((server) => `${server.id}:${server.status}:${server.scope}`).join(", ");
      const statusOf = async (name: string) =>
        (await liveServers()).find((server) => server.id === name)?.status;
      const mcpPanel = async () => {
        const panel = (await openAgentPanel(page)).getByLabel("MCP servers", { exact: true });
        await expect(panel).toBeVisible({ timeout: 60_000 });
        // The section re-renders as the projection refreshes; retry the expand.
        const toggle = panel.getByRole("button", { name: /^Tools / });
        await expect(async () => {
          if ((await toggle.getAttribute("aria-expanded")) !== "true") {
            await toggle.click({ timeout: 3_000 });
          }
          await expect(toggle).toHaveAttribute("aria-expanded", "true", { timeout: 2_000 });
        }).toPass({ timeout: 30_000 });
        await panel.scrollIntoViewIfNeeded();
        return panel;
      };

      await loadAppWithDevRetry(page, testInfo, () => page.goto(status.browserUrl!));
      await openEnvironment(page, project!.name, environment.name);
      await expect.poll(async () => (await projection()) !== null, { timeout: 120_000 }).toBe(true);
      expect(await liveServers(), "a live inventory before Claude's CLI ran").toEqual([]);

      await test.step("a turn starts the CLI, which reports one server up and one down", async () => {
        // No Claude login exists in this profile: the CLI connects its MCP
        // servers, reports them, and answers "Not logged in" without a model call.
        const dispatched = await invoke<{ outcome: string; error?: string }>(
          "dispatch_native_agent_intent",
          { ...identity, prompt: "Reply with OK.", requestId: randomUUID() },
        );
        expect(dispatched.outcome, dispatched.error).toBe("accepted");
        await expect
          .poll(async () => (await projection())?.turn.phase, { timeout: 120_000 })
          .toMatch(/^(idle|error)$/);
        const after = await projection();
        record("turn", `${after?.turn.phase}: ${after?.turn.error ?? ""}`);
        await expect.poll(() => statusOf("mcpui-ok"), { timeout: 60_000 }).toBe("connected");
        await expect.poll(() => statusOf("mcpui-late"), { timeout: 60_000 }).toBe("failed");
        record("inventory-after-turn", describe(await liveServers()));
        const panel = await mcpPanel();
        await expect(panel).toContainText("1 down");
        await expect(panelRow(panel, "mcpui-late")).toContainText("failed");
        await shot("before-reconnect");
      });

      await test.step("reconnect from the panel brings the failing server up", async () => {
        copyFileSync(PROBE_SERVER, lateScript);
        const panel = page.getByLabel("MCP servers", { exact: true });
        const reconnect = page.waitForRequest((request) => {
          if (!request.url().endsWith("/__orkestrator/invoke")) return false;
          const body = request.postDataJSON() as {
            command?: string;
            args?: Record<string, unknown>;
          };
          return (
            body.command === "perform_native_agent_mcp_action" &&
            body.args?.serverId === "mcpui-late" &&
            body.args?.action === "reconnect"
          );
        });
        // A failed row's own click is its primary action: reconnect.
        await panel
          .getByRole("button", { name: /^mcpui-late/ })
          .first()
          .click();
        await reconnect;
        await expect.poll(() => statusOf("mcpui-late"), { timeout: 60_000 }).toBe("connected");
        await expect(panel).not.toContainText("down", { timeout: 30_000 });
        record("inventory-after-reconnect", describe(await liveServers()));
        await shot("after-reconnect");
      });

      await test.step("after a reload the panel shows the backend's inventory", async () => {
        const backend = await liveServers();
        await loadAppWithDevRetry(page, testInfo, () => page.reload());
        await openEnvironment(page, project!.name, environment.name);
        const panel = await mcpPanel();
        await expect(panel).not.toContainText("down");
        await expect(panel).toContainText(
          `${backend.length} server${backend.length === 1 ? "" : "s"}`,
        );
        for (const server of backend) {
          await expect(panelRow(panel, server.name)).toContainText(
            server.status === "connected" ? String(server.toolCount ?? "—") : server.status,
          );
        }
        record("inventory-after-reload", describe(await liveServers()));
        await shot("after-reload");
      });
      const lateStarts = readFileSync(probeLog, "utf8")
        .split("\n")
        .filter((line) => line.includes('"event":"start"') && line.includes('"mcpui-late"')).length;
      expect(lateStarts, "the late server never started after the reconnect").toBeGreaterThan(0);
    } finally {
      await invoke("stop_environment", { environmentId: environment.id }).catch(() => undefined);
      await invoke("delete_environment", { environmentId: environment.id }).catch(() => undefined);
      rmSync(lateScript, { force: true });
    }
  });
});
