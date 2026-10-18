import { expect, test, type Page, type TestInfo } from "@playwright/test";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { PANE_LAYOUT_VERSION } from "@orkestrator/protocol/pane-layout";
import { loadAppWithDevRetry } from "./dev-startup-retry";
import { dismissSidebarTooltip } from "./sidebar-tooltip";

/**
 * C11, approval half, with a real Claude turn against a profile started with
 * `--fixture-environments local,container --credential-source claude`: a
 * Claude tab in the fixture container asks to run a command, the user switches
 * to another environment, stops the container from the sidebar, comes back to
 * the stopped view (which must offer nothing to approve) and starts it there.
 * The approval must never have been granted: the command's marker file does
 * not exist, no interaction ended `resolved`, and once the session reattaches
 * none is pending. The Claude tab itself must come back with the restart.
 *
 * Opt-in on top of the Docker fixture (`ORKESTRATOR_AGENT_TEST_DOCKER=1`):
 * `ORKESTRATOR_AGENT_TEST_LIVE_CONTAINER_APPROVAL=1`, because the turn uses the
 * host's Claude credentials and may cost money. Nothing at module scope spawns
 * `mise`, so the file stays inert without both opt-ins.
 */

type Project = { id: string; name: string; localPath: string | null };
type Environment = { id: string; name: string; containerId?: string | null; status: string };
type Interaction = {
  id: string;
  kind: string;
  state: string;
  presentation: { confirmLabel?: string };
};
type Projection = {
  turn: { phase: string };
  interactions: Interaction[];
  messages: Array<{ role: string; parts: unknown[] }>;
} | null;
type StoredLayout = {
  version: number;
  containerId: string | null;
  activePaneId: string;
  root: unknown;
  revision?: number;
};

const TOOL_APPROVAL_KINDS = new Set(["command-approval", "file-approval", "permission"]);
const repositoryRoot = path.resolve(import.meta.dirname, "../..");
const profile = process.env.ORKESTRATOR_AGENT_TEST_PROFILE ?? "codex-qa";
const ENABLED =
  process.env.ORKESTRATOR_AGENT_TEST_DOCKER === "1" &&
  process.env.ORKESTRATOR_AGENT_TEST_LIVE_CONTAINER_APPROVAL === "1";

function mise(args: string[]): string {
  const command = spawnSync("mise", ["run", ...args, "--profile", profile, "--json"], {
    cwd: repositoryRoot,
    encoding: "utf8",
  });
  if (command.status !== 0) throw new Error(command.stderr || `${args[0]} failed`);
  return command.stdout;
}

async function signIn(page: Page, testInfo: TestInfo) {
  const status = JSON.parse(mise(["dev:status"])) as {
    status: string;
    browserUrl?: string;
    testProject?: string;
  };
  expect(status.status, `profile "${profile}" is not running`).toBe("ready");
  // The one-shot login URL is parsed in memory and never copied into output.
  const { loginUrl } = JSON.parse(mise(["dev:login"])) as { loginUrl?: unknown };
  if (typeof loginUrl !== "string") throw new Error("dev:login returned no login URL");
  await loadAppWithDevRetry(page, testInfo, () =>
    page.goto(loginUrl, { waitUntil: "domcontentloaded" }),
  );
  const invoke = async <T>(command: string, args: Record<string, unknown> = {}): Promise<T> => {
    const response = await page.request.post(
      new URL("/__orkestrator/invoke", status.browserUrl!).href,
      { data: { command, args } },
    );
    expect(response.ok(), `${command}: ${await response.text()}`).toBe(true);
    return ((await response.json()) as { result: T }).result;
  };
  return { status, invoke };
}

function markerExists(containerId: string, marker: string): boolean {
  const result = spawnSync("docker", ["exec", containerId, "test", "-e", marker]);
  if (result.status !== 0 && result.status !== 1) {
    throw new Error(`docker exec failed: ${result.stderr.toString().slice(0, 300)}`);
  }
  return result.status === 0;
}

test.skip(!ENABLED, "Docker fixture profile and live container approval opt-in required");

test("Docker fixture live Claude approval is never granted by an explicit stop (C11)", async ({
  page,
}, testInfo) => {
  test.setTimeout(10 * 60_000);
  page.setDefaultTimeout(15_000);
  await page.setViewportSize({ width: 1440, height: 1000 });
  const { status, invoke } = await signIn(page, testInfo);
  const fixture = (await invoke<Project[]>("get_projects")).find(
    (project) => project.localPath === status.testProject,
  );
  expect(fixture, "fixture project missing").toBeTruthy();
  const environments = await invoke<Environment[]>("get_environments", { projectId: fixture!.id });
  const target = environments.find((environment) => environment.name === "fixture-container");
  const other = environments.find((environment) => environment.name === "fixture-local");
  expect(target?.containerId, "fixture-container has no runtime").toBeTruthy();
  expect(other).toBeTruthy();
  if (target!.status !== "running") {
    await invoke("start_environment", { environmentId: target!.id });
  }

  const suffix = Date.now();
  testInfo.annotations.push({ type: "c11-tab", description: `c11-approval-${suffix}` });
  const tabId = `c11-approval-${suffix}`;
  const sessionKey = `env-${target!.id}:${tabId}`;
  const marker = `/workspace/.c11-approval-${suffix}`;
  const previousLayout = await invoke<StoredLayout | null>("get_pane_layout", {
    environmentId: target!.id,
  });
  testInfo.annotations.push({
    type: "c11-prior-layout",
    description: previousLayout ? "present" : "absent",
  });
  const projection = () =>
    invoke<Projection>("get_native_agent_projection", {
      environmentId: target!.id,
      agent: "claude",
      logicalSessionKey: sessionKey,
    });
  const mapping = () =>
    invoke<{ providerSessionId: string } | null>("get_native_agent_session", {
      environmentId: target!.id,
      agent: "claude",
      logicalSessionKey: sessionKey,
    });
  let originalSessionId: string | undefined;
  const openEnvironment = async (name: string) => {
    const expand = page.getByRole("button", { name: `Expand project ${fixture!.name}` });
    const entry = page.getByText(name, { exact: true }).first();
    await expect(expand.or(entry)).toBeVisible({ timeout: 30_000 });
    if (await expand.isVisible()) await expand.click();
    await dismissSidebarTooltip(page, fixture!.name);
    await entry.click();
    return entry;
  };
  const environmentStatus = async () =>
    (await invoke<Environment>("get_environment", { environmentId: target!.id })).status;
  // Every interaction state observed, by phase, for the qualification record.
  const seen = new Set<string>();
  const record = (phase: string, current: Projection | Error) => {
    if (current instanceof Error) seen.add(`${phase} projection-unavailable`);
    else if (!current?.interactions.length) seen.add(`${phase} none`);
    for (const interaction of current instanceof Error ? [] : (current?.interactions ?? [])) {
      seen.add(`${phase} ${interaction.kind}:${interaction.state}`);
    }
  };
  const observe = (phase: string) =>
    projection().then(
      (current) => {
        record(phase, current);
        return current;
      },
      (error: unknown) => {
        record(phase, error instanceof Error ? error : new Error(String(error)));
        return null;
      },
    );

  try {
    // An unassigned tab with Claude preselected, so the launcher offers the
    // Approvals picker for the opening prompt.
    await invoke("save_pane_layout", {
      environmentId: target!.id,
      expectedRevision: previousLayout?.revision ?? 0,
      layout: {
        version: PANE_LAYOUT_VERSION,
        containerId: target!.containerId,
        activePaneId: "pane-c11",
        root: {
          kind: "leaf",
          id: "pane-c11",
          tabs: [
            { id: tabId, type: "agent-native", nativeAgentData: { environmentId: target!.id } },
          ],
          activeTabId: tabId,
        },
      },
    });
    await invoke("save_compose_draft", {
      draftKey: `agent-native:${target!.id}:${encodeURIComponent(sessionKey)}`,
      ownerType: "environment",
      ownerId: target!.id,
      value: {
        text:
          `Use the Bash tool to run exactly this command and nothing else: touch ${marker}\n` +
          "Do not use any other tool, and do not retry if it is refused.",
        mentions: [],
        attachments: [],
        annotations: [],
        metadata: { platform: "claude" },
      },
    });
    expect(markerExists(target!.containerId!, marker)).toBe(false);

    await test.step("Claude asks to run the command in Ask mode", async () => {
      await page.goto(status.browserUrl!);
      await openEnvironment(target!.name);
      const launcher = page.getByTestId("unassigned-native-compose-bar");
      await expect(launcher.getByRole("textbox")).toContainText(marker, { timeout: 60_000 });
      // Plan mode would raise a plan approval instead of a command approval.
      await launcher.getByTestId("launch-mode-picker").click();
      await page.getByRole("menuitemradio", { name: "Build" }).click();
      await expect(launcher.getByTestId("launch-mode-picker")).toHaveAccessibleName("Mode: Build");
      await launcher.getByTestId("launch-approval-mode-picker").click();
      await page.getByRole("menuitemradio", { name: "Ask" }).click();
      await expect(launcher.getByTestId("launch-approval-mode-picker")).toHaveAccessibleName(
        "Approvals: Ask",
      );
      await expect(launcher.getByTitle("Start agent")).toBeEnabled({ timeout: 60_000 });
      await launcher.getByTitle("Start agent").click();
      await expect
        .poll(
          async () => {
            const current = await observe("asked");
            return current?.interactions.some(
              (interaction) =>
                interaction.state === "pending" && TOOL_APPROVAL_KINDS.has(interaction.kind),
            );
          },
          { timeout: 180_000, message: "Claude never asked to approve the command" },
        )
        .toBe(true);
      expect(markerExists(target!.containerId!, marker)).toBe(false);
      originalSessionId = (await mapping())?.providerSessionId;
      expect(originalSessionId).toBeTruthy();
    });

    await test.step("switch away and stop the container from the sidebar", async () => {
      const entry = await openEnvironment(other!.name);
      await expect(entry).toBeVisible();
      const containerEntry = page.getByText(target!.name, { exact: true }).first();
      await containerEntry.click({ button: "right" });
      await page.getByRole("menuitem", { name: "Stop", exact: true }).click();
      await expect.poll(environmentStatus, { timeout: 120_000 }).toBe("stopped");
      await observe("stopped");
    });

    await test.step("return while stopped: approving the dead request grants nothing", async () => {
      await openEnvironment(target!.name);
      await page.waitForTimeout(5_000);
      const stale = (await observe("stopped-open"))?.interactions.find(
        (interaction) => interaction.state === "pending",
      );
      const approve = page.getByRole("button", {
        name: stale?.presentation.confirmLabel ?? "Continue",
        exact: true,
      });
      const shown = await approve.isVisible();
      seen.add(`stopped-open approve-button:${shown ? "shown" : "hidden"}`);
      await testInfo.attach("stopped-environment", {
        body: await page.screenshot(),
        contentType: "image/png",
      });
      if (shown && (await approve.isEnabled())) {
        await approve.click();
        await page.waitForTimeout(5_000);
        await observe("stopped-approved");
      }
    });

    await test.step("return and start: the approval was never granted", async () => {
      const containerEntry = page.getByText(target!.name, { exact: true }).first();
      await containerEntry.click({ button: "right" });
      await page.getByRole("menuitem", { name: "Start", exact: true }).click();
      await expect.poll(environmentStatus, { timeout: 180_000 }).toBe("running");
      await openEnvironment(target!.name);
      const composeBar = page.getByTestId("shared-native-compose-bar");
      await expect(composeBar).toBeVisible({ timeout: 90_000 });
      // The restarted bridge has reattached the session, then had long enough
      // to republish or resend anything.
      await expect
        .poll(async () => (await projection().catch(() => null)) !== null, { timeout: 120_000 })
        .toBe(true);
      await page.waitForTimeout(15_000);
      const settled = await observe("returned");
      expect(settled, "the session never reattached after the restart").not.toBeNull();
      seen.add(`returned turn:${settled?.turn.phase ?? "none"}`);
      expect([...seen].filter((state) => state.endsWith(":resolved"))).toEqual([]);
      expect(
        settled?.interactions.filter((interaction) => interaction.state === "pending") ?? [],
      ).toEqual([]);
      // Nothing left on screen that could still approve it.
      await expect(page.getByRole("button", { name: "Deny", exact: true })).toHaveCount(0);
      const current = await invoke<Environment>("get_environment", { environmentId: target!.id });
      expect(markerExists(current.containerId!, marker)).toBe(false);
    });

    await test.step("a new turn survives teardown reconciliation after re-adoption", async () => {
      expect((await mapping())?.providerSessionId).toBe(originalSessionId);
      const environment = await invoke<{ tabTeardownIntents?: Record<string, unknown> }>(
        "get_environment",
        { environmentId: target!.id },
      );
      expect(environment.tabTeardownIntents?.[tabId]).toBeUndefined();
      // Exercise the exact periodic sweep now, rather than depending on its
      // 60-second wall-clock schedule landing inside the reconnect wait.
      await invoke("reconcile_tab_teardowns");
      expect((await mapping())?.providerSessionId).toBe(originalSessionId);
      const reply = `C11_RESTART_OK_${suffix}`;
      await invoke("dispatch_native_agent_intent", {
        environmentId: target!.id,
        agent: "claude",
        logicalSessionKey: sessionKey,
        requestId: `c11-followup-${suffix}`,
        mode: "build",
        prompt: `Do not use tools. Reply with exactly ${reply}`,
      });
      await openEnvironment(other!.name);
      await invoke("reconcile_tab_teardowns");
      await expect
        .poll(
          async () => {
            const current = await projection();
            return (
              current?.turn.phase === "idle" &&
              current.messages.some(
                (message) =>
                  message.role === "assistant" && JSON.stringify(message.parts).includes(reply),
              )
            );
          },
          { timeout: 180_000 },
        )
        .toBe(true);
      expect((await mapping())?.providerSessionId).toBe(originalSessionId);
      await openEnvironment(target!.name);
      await page.reload();
      await openEnvironment(target!.name);
      await expect(page.getByTestId("shared-native-compose-bar")).toBeVisible({ timeout: 90_000 });
      expect((await mapping())?.providerSessionId).toBe(originalSessionId);
    });
  } finally {
    // Recorded on failure too: what the backend held and which tab it named.
    const final = await invoke<StoredLayout | null>("get_pane_layout", {
      environmentId: target!.id,
    }).catch(() => null);
    seen.add(`final layout tabs:${JSON.stringify(final?.root ?? null).match(/c11-approval-\d+/g)}`);
    testInfo.annotations.push({ type: "c11-observed", description: [...seen].join(", ") });
    if ((await environmentStatus().catch(() => "unknown")) === "stopped") {
      await invoke("start_environment", { environmentId: target!.id }).catch(() => undefined);
    }
    // Unmount the renderer before restoring/deleting the durable layout, so
    // its pending writes cannot recreate the injected tab during cleanup.
    await page.goto("about:blank");
    await invoke("teardown_tab", {
      environmentId: target!.id,
      tabId,
      kind: "claude-native",
    });
    const layout = await invoke<{ revision?: number } | null>("get_pane_layout", {
      environmentId: target!.id,
    });
    if (previousLayout) {
      const { version, containerId, activePaneId, root } = previousLayout;
      await invoke("save_pane_layout", {
        environmentId: target!.id,
        expectedRevision: layout?.revision ?? 0,
        layout: { version, containerId, activePaneId, root },
      });
    } else if (!previousLayout && layout) {
      await invoke("delete_pane_layout", {
        environmentId: target!.id,
        expectedRevision: layout.revision ?? 0,
      });
    }
    const restored = await invoke<StoredLayout | null>("get_pane_layout", {
      environmentId: target!.id,
    });
    if (previousLayout) expect(restored?.root).toEqual(previousLayout.root);
    else expect(restored).toBeNull();
    expect(await mapping()).toBeNull();
  }
});
