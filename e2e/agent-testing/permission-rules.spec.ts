import { expect, test, type Page, type TestInfo } from "@playwright/test";
import { spawn, spawnSync } from "node:child_process";
import { openSync, closeSync } from "node:fs";
import { PANE_LAYOUT_VERSION } from "@orkestrator/protocol/pane-layout";
import { ensureProjectExpanded } from "./sidebar-project";
import { resolveRuntimeProfile } from "../../apps/desktop/electron/runtime-profile";
import { dismissSidebarTooltip } from "./sidebar-tooltip";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { loadAppWithDevRetry } from "./dev-startup-retry";

/**
 * Settings → Permissions against the real backend (todo 0723): a rule the
 * backend holds is listed with its pattern, scope and use, and removing it
 * from the page removes it from the backend's store. Rules are staged straight
 * into the profile's database because only an approval card can create one,
 * and a card needs a real, billed provider turn.
 */

const repositoryRoot = path.resolve(import.meta.dirname, "../..");
const profile = process.env.ORKESTRATOR_AGENT_TEST_PROFILE ?? "codex-qa";

function rulesStore(dataDir: string, action: "list" | "create", value?: unknown): unknown {
  const result = spawnSync(
    "bun",
    [path.join(import.meta.dirname, "permission-rules-store.ts"), dataDir, action],
    {
      cwd: repositoryRoot,
      encoding: "utf8",
      input: value === undefined ? undefined : JSON.stringify(value),
    },
  );
  if (result.status !== 0) throw new Error(result.stderr || `permission rules ${action} failed`);
  return action === "list" ? JSON.parse(result.stdout) : null;
}

async function login(page: Page, testInfo: TestInfo): Promise<void> {
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

test("Settings lists the backend's permission rules and removes one", async ({
  page,
}, testInfo) => {
  const statusCommand = spawnSync("mise", ["run", "dev:status", "--profile", profile, "--json"], {
    cwd: repositoryRoot,
    encoding: "utf8",
  });
  if (statusCommand.status !== 0) throw new Error(statusCommand.stderr || "dev:status failed");
  const status = JSON.parse(statusCommand.stdout) as { status: string; dataDir: string };
  expect(status.status).toBe("ready");

  const ruleId = randomUUID();
  const pattern = `npm run e2e-${ruleId.slice(0, 8)}`;
  rulesStore(status.dataDir, "create", {
    id: ruleId,
    provider: "codex",
    scope: "project",
    projectId: `e2e-permission-${ruleId.slice(0, 8)}`,
    kind: "command-prefix",
    pattern,
    createdAt: Date.now(),
    createdFrom: { environmentId: "e2e-environment", agent: "codex", interactionId: "e2e" },
    lastUsedAt: Date.now(),
    useCount: 2,
  });

  // This check uses no agent, Docker or GitHub: let credential-free profiles
  // reach the workspace through the ordinary optional-tool dialogs.
  for (const name of [
    "Continue Without Claude",
    "Continue Without Docker",
    "Continue Without GitHub CLI",
  ]) {
    await page.addLocatorHandler(page.getByRole("button", { name, exact: true }), (button) =>
      button.click(),
    );
  }
  await login(page, testInfo);
  await page.getByRole("button", { name: "Global settings" }).click();
  await page
    .getByRole("navigation", { name: "Settings sections" })
    .getByRole("button", { name: "Permissions", exact: true })
    .click();
  const row = page.getByTestId("permission-rule-row").filter({ hasText: pattern });
  await expect(row).toBeVisible();
  await expect(row).toContainText("Whole project");
  await expect(row).toContainText("Used 2 times");
  await expect(page.getByRole("region", { name: "Rules outside Orkestrator" })).toBeVisible();

  await row.getByRole("button", { name: `Remove rule ${pattern}` }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Remove" }).click();
  await expect(row).toHaveCount(0);
  const remaining = rulesStore(status.dataDir, "list") as Array<{ id: string }>;
  expect(remaining.some((rule) => rule.id === ruleId)).toBe(false);
});

// Billed turns and a graceful profile restart: run this file by itself against
// dev:test --fixture --credential-source claude --agent-platforms claude.
test("approval card remembers, auto-applies in the background, survives restart and asks after removal", async ({
  page,
}, testInfo) => {
  test.skip(
    process.env.ORKESTRATOR_AGENT_TEST_LIVE_PERMISSION_RULES !== "1",
    "live permission-rule lifecycle opt-in required",
  );
  test.setTimeout(12 * 60_000);
  page.setDefaultTimeout(15_000);
  const status = () => {
    const command = spawnSync("mise", ["run", "dev:status", "--profile", profile, "--json"], {
      cwd: repositoryRoot,
      encoding: "utf8",
    });
    if (!command.stdout.trim()) throw new Error("dev:status returned no status");
    return JSON.parse(command.stdout) as {
      status: string;
      browserUrl: string;
      testProject?: string;
    };
  };
  let current = status();
  for (const name of [
    "Continue Without Claude",
    "Continue Without Docker",
    "Continue Without GitHub CLI",
  ]) {
    await page.addLocatorHandler(page.getByRole("button", { name, exact: true }), (button) =>
      button.click(),
    );
  }
  await login(page, testInfo);
  const invoke = async <T>(command: string, args: Record<string, unknown> = {}): Promise<T> => {
    const response = await page.request.post(
      new URL("/__orkestrator/invoke", current.browserUrl).href,
      { data: { command, args } },
    );
    if (!response.ok()) throw new Error(`${command} failed (${response.status()})`);
    return ((await response.json()) as { result: T }).result;
  };
  const fixture = (
    await invoke<Array<{ id: string; name: string; localPath: string }>>("get_projects")
  ).find(
    (project) =>
      project.localPath ===
      (current.testProject ??
        path.join(
          resolveRuntimeProfile({ repositoryRoot, requestedId: profile, flavor: "agent-test" })
            .profileRoot,
          "fixtures",
          "test-project",
        )),
  );
  expect(fixture).toBeTruthy();
  const environment = await invoke<{ id: string; name: string }>("create_environment", {
    projectId: fixture!.id,
    name: `permission-lifecycle-${Date.now()}`,
    environmentType: "local",
  });
  const tabId = "permission-lifecycle";
  const identity = {
    environmentId: environment.id,
    agent: "claude",
    logicalSessionKey: `env-${environment.id}:${tabId}`,
  };
  type Projection = {
    turn: { phase: string };
    messages: Array<{ role: string; content?: string }>;
    interactions: Array<{
      id: string;
      state: string;
      presentation: { ruleOffer?: { patterns: string[] } };
    }>;
  };
  const projection = () => invoke<Projection>("get_native_agent_projection", identity);
  const pattern = `touch permission-${randomUUID().slice(0, 8)}`;
  const prompt = `Use the Bash tool once to run exactly: ${pattern}\nDo not use other tools or change the command. After it finishes, reply DONE.`;
  let savedRuleId: string | undefined;
  let backgroundEnvironmentId: string | undefined;
  let sent = 0;
  const openEnvironment = async (name: string) => {
    await ensureProjectExpanded(page, fixture!.name);
    await dismissSidebarTooltip(page, fixture!.name);
    await page.getByText(name, { exact: true }).first().click();
  };
  try {
    await invoke("update_environment_agent_settings", {
      environmentId: environment.id,
      agentSettings: { executionPolicy: { approvals: "ask" } },
    });
    await invoke("start_environment", { environmentId: environment.id });
    await invoke("ensure_native_agent_session", {
      ...identity,
      origin: "interactive-native",
      sessionMode: "build",
      ...(process.env.ORKESTRATOR_AGENT_TEST_PERMISSION_MODEL
        ? { model: process.env.ORKESTRATOR_AGENT_TEST_PERMISSION_MODEL }
        : {}),
    });
    await invoke("save_pane_layout", {
      environmentId: environment.id,
      expectedRevision: 0,
      layout: {
        version: PANE_LAYOUT_VERSION,
        containerId: null,
        activePaneId: "permission-pane",
        root: {
          kind: "leaf",
          id: "permission-pane",
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
    await page.goto(current.browserUrl);
    await openEnvironment(environment.name);
    const send = async () => {
      const bar = page.getByTestId("shared-native-compose-bar");
      const composer = bar.getByRole("textbox", { name: /^Message Claude/ });
      await expect(composer).toBeVisible({ timeout: 90_000 });
      await composer.fill(prompt);
      await expect(bar.getByRole("button", { name: "Send", exact: true })).toBeEnabled({
        timeout: 90_000,
      });
      await composer.press("Enter");
      await expect(composer).toHaveText("");
      sent += 1;
    };
    const settled = async () =>
      expect
        .poll(
          async () => {
            const snapshot = await projection();
            return (
              ["completed", "idle"].includes(snapshot.turn.phase) &&
              snapshot.interactions.length === 0 &&
              snapshot.messages.filter(
                (message) => message.role === "assistant" && message.content?.trim() === "DONE",
              ).length >= sent
            );
          },
          { timeout: 180_000, intervals: [1000] },
        )
        .toBe(true);
    await send();
    await expect
      .poll(
        async () =>
          (await projection()).interactions.some((request) =>
            request.presentation.ruleOffer?.patterns.includes(pattern),
          ),
        { timeout: 180_000 },
      )
      .toBe(true);
    await page.getByRole("button", { name: "Approve and remember…", exact: true }).click();
    await page
      .getByTestId("remember-rule-panel")
      .getByRole("button", { name: "Approve and remember", exact: true })
      .click();
    await settled();
    const rules = () =>
      invoke<{
        rules: Array<{ id: string; pattern: string; useCount: number }>;
        applications: unknown[];
      }>("list_permission_rules", { projectId: fixture!.id, ...identity });
    const saved = (await rules()).rules.find((rule) => rule.pattern === pattern);
    expect(saved).toBeTruthy();
    savedRuleId = saved!.id;

    await send();
    let other = (
      await invoke<Array<{ id: string; name: string }>>("get_environments", {
        projectId: fixture!.id,
      })
    ).find((entry) => entry.id !== environment.id && entry.name !== "project-home");
    if (!other) {
      other = await invoke<{ id: string; name: string }>("create_environment", {
        projectId: fixture!.id,
        name: `permission-background-${Date.now()}`,
        environmentType: "local",
      });
      backgroundEnvironmentId = other.id;
    }
    expect(other).toBeTruthy();
    await openEnvironment(other!.name);
    await settled();
    await expect
      .poll(async () => (await rules()).rules.find((rule) => rule.id === saved!.id)?.useCount, {
        timeout: 30_000,
      })
      .toBe(1);
    await openEnvironment(environment.name);
    await expect(
      page.getByTestId("permission-rule-note").filter({ hasText: pattern }),
    ).toBeVisible();
    await page.reload();
    await openEnvironment(environment.name);
    await expect(
      page.getByTestId("permission-rule-note").filter({ hasText: pattern }),
    ).toBeVisible();

    // Stop only this profile. The restart launcher has its own process handle.
    const stop = spawn("mise", ["run", "dev:stop", "--profile", profile], {
      cwd: repositoryRoot,
      stdio: "ignore",
    });
    expect(await new Promise((resolve) => stop.once("close", resolve))).toBe(0);
    const log = openSync(testInfo.outputPath("permission-profile-restart.log"), "a");
    const launcher = spawn(
      "bun",
      [
        "apps/desktop/scripts/dev-test.ts",
        "--profile",
        profile,
        "--credential-source",
        "claude",
        "--agent-platforms",
        "claude",
      ],
      { cwd: repositoryRoot, detached: true, stdio: ["ignore", log, log] },
    );
    closeSync(log);
    launcher.unref();
    await expect
      .poll(
        () => {
          current = status();
          return current.status;
        },
        { timeout: 240_000, intervals: [2000] },
      )
      .toBe("ready");
    await login(page, testInfo);
    await openEnvironment(environment.name);
    expect((await rules()).rules.find((rule) => rule.id === saved!.id)?.useCount).toBe(1);
    const note = page.getByTestId("permission-rule-note").filter({ hasText: pattern });
    await expect(note).toBeVisible({ timeout: 90_000 });
    await note.getByRole("button", { name: "Remove rule", exact: true }).click();
    await expect
      .poll(async () => (await rules()).rules.some((rule) => rule.id === saved!.id))
      .toBe(false);
    await send();
    await expect
      .poll(
        async () =>
          (await projection()).interactions.some(
            (request) =>
              request.state === "pending" &&
              request.presentation.ruleOffer?.patterns.includes(pattern),
          ),
        { timeout: 180_000 },
      )
      .toBe(true);
    await expect(
      page.getByRole("button", { name: "Approve and remember…", exact: true }),
    ).toBeVisible();
  } finally {
    await invoke("stop_native_agent_session", identity).catch(() => undefined);
    if (savedRuleId)
      await invoke("delete_permission_rule", { id: savedRuleId }).catch(() => undefined);
    await invoke("delete_environment", { environmentId: environment.id }).catch(() => undefined);
    if (backgroundEnvironmentId)
      await invoke("delete_environment", { environmentId: backgroundEnvironmentId }).catch(
        () => undefined,
      );
  }
});
