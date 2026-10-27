/** Opt-in real composer → bridge → Codex → reload/resume qualification.
 * Uses only disposable fixture worktrees; three short provider turns.
 */
import { expect, test } from "@playwright/test";
import { PANE_LAYOUT_VERSION } from "@orkestrator/protocol/pane-layout";
import {
  authenticatedInvoke,
  hostWorkspace,
  profileStatus,
  sidebarNavigator,
  type Environment,
  type Project,
} from "./slash-command-live-support";

type Projection = {
  turn: { phase: string; error?: string };
  messages: Array<{ role: string; content: string }>;
  slashCommands?: Array<{ name: string }>;
};
const profile = process.env.ORKESTRATOR_AGENT_TEST_PROFILE ?? "codex-qa";

test.use({ trace: "off", screenshot: "off" });

test.describe("Codex typed prompts through the real composer", () => {
  test.skip(
    process.env.ORKESTRATOR_AGENT_TEST_LIVE_TYPED_PROMPTS !== "1",
    "opt-in real Codex turns in a disposable profile",
  );

  test("plan, skill and template rows survive reload, an inactive environment and picker resume", async ({
    page,
  }) => {
    test.setTimeout(600_000);
    await page.setViewportSize({ width: 1440, height: 1200 });
    const status = profileStatus(profile);
    expect(status.status).toBe("ready");
    expect(status.flavor).toBe("agent-test");
    const invoke = await authenticatedInvoke(page, status, profile);
    const fixture = (await invoke<Project[]>("get_projects")).find(
      (project) => project.localPath === status.testProject,
    )!;
    expect(fixture).toBeTruthy();
    const environment = await invoke<Environment>("create_environment", {
      projectId: fixture.id,
      name: `typed-prompts-${Date.now()}`,
      environmentType: "local",
      networkAccessMode: "restricted",
      agentSettings: { executionPolicy: { projectResources: true } },
    });
    let away: Environment | undefined;
    try {
      await invoke("start_environment", { environmentId: environment.id });
      const started = await invoke<Environment>("get_environment", {
        environmentId: environment.id,
      });
      const workspace = hostWorkspace(started.worktreePath!);
      workspace.write(
        ".codex/skills/typed-probe/SKILL.md",
        "---\nname: typed-probe\ndescription: Reply with OK for transcript qualification.\n---\nReply with only OK. Do not call tools.\n",
      );
      workspace.write(
        ".codex/prompts/typed-template.md",
        "Reply with only OK. Do not call tools. Template argument: $ARGUMENTS\n",
      );
      const catalog = await invoke<Array<{ platform: string; id: string; label: string }>>(
        "get_native_agent_model_catalog",
        { environmentId: environment.id },
      );
      const model = catalog.find(
        (entry) => entry.platform === "codex" && /luna/i.test(`${entry.id} ${entry.label}`),
      )?.id;
      const tabId = "typed-prompts-tab";
      const identity = (tab: string) => ({
        environmentId: environment.id,
        agent: "codex",
        logicalSessionKey: `env-${environment.id}:${tab}`,
      });
      const layout = await invoke<{ revision?: number } | null>("get_pane_layout", {
        environmentId: environment.id,
      });
      await invoke("save_pane_layout", {
        environmentId: environment.id,
        expectedRevision: layout?.revision ?? 0,
        layout: {
          version: PANE_LAYOUT_VERSION,
          containerId: null,
          activePaneId: "typed-pane",
          root: {
            kind: "leaf",
            id: "typed-pane",
            activeTabId: tabId,
            tabs: [
              {
                id: tabId,
                type: "agent-native",
                displayTitle: "Codex typed prompts",
                nativeAgentData: {
                  environmentId: environment.id,
                  platform: "codex",
                  isLocal: true,
                },
                ...(model ? { initialAgentModel: model } : {}),
              },
            ],
          },
        },
      });
      const projection = (tab = tabId) =>
        invoke<Projection | null>("get_native_agent_projection", identity(tab));
      const openEnvironment = sidebarNavigator(page, fixture.name);
      await page.goto(status.browserUrl!);
      await openEnvironment(environment.name);
      const compose = page.getByTestId("shared-native-compose-bar");
      const input = compose.getByRole("textbox", { name: /^Message Codex/ });
      await expect(input).toBeVisible({ timeout: 90_000 });
      const prompts = [
        "Reply with only OK. Do not call tools.",
        "/skill:typed-probe reply",
        "/typed-template sample",
      ];
      const send = async (prompt: string, count: number) => {
        await input.fill(prompt);
        await expect(compose.getByRole("button", { name: "Send", exact: true })).toBeEnabled({
          timeout: 90_000,
        });
        await input.press("Enter");
        await expect(input).toHaveText("", { timeout: 30_000 });
        await expect
          .poll(
            async () => {
              const current = await projection();
              if (current?.turn.phase === "error")
                throw new Error(current.turn.error ?? "Codex turn failed");
              return (
                current?.turn.phase === "idle" &&
                current.messages.filter((row) => row.role === "user").length === count &&
                current.messages.filter((row) => row.role === "assistant").length >= count
              );
            },
            { timeout: 180_000, intervals: [1_000] },
          )
          .toBe(true);
      };
      await page.getByTestId("native-mode-picker").click();
      await page.getByRole("menuitemradio", { name: "Plan", exact: true }).click();
      await send(prompts[0]!, 1);
      await page.getByTestId("native-mode-picker").click();
      await page.getByRole("menuitemradio", { name: "Build", exact: true }).click();
      await send(prompts[1]!, 2);
      await send(prompts[2]!, 3);
      const assertRows = async (tab = tabId) => {
        await expect
          .poll(
            async () =>
              (await projection(tab))?.messages
                .filter((row) => row.role === "user")
                .map((row) => row.content),
            { timeout: 60_000 },
          )
          .toEqual(prompts);
        for (const prompt of prompts)
          await expect(page.getByText(prompt, { exact: true })).toHaveCount(1);
      };
      await assertRows();
      away = await invoke<Environment>("create_environment", {
        projectId: fixture.id,
        name: `typed-away-${Date.now()}`,
        environmentType: "local",
        networkAccessMode: "restricted",
      });
      await openEnvironment(away.name);
      await openEnvironment(environment.name);
      await page.reload();
      await openEnvironment(environment.name);
      await assertRows();
      await page.getByRole("button", { name: /^Close Codex\b/ }).click();
      await expect(input).toHaveCount(0);
      await page.getByRole("button", { name: "New native agent tab" }).click();
      await page.getByRole("button", { name: "Resume Session" }).click();
      await page
        .getByRole("dialog", { name: "Resume a session" })
        .getByRole("button", { name: /^Codex\b.*Choose a previous session/ })
        .click();
      const picker = page.getByRole("dialog", { name: "Resume Session" });
      await picker
        .getByRole("button")
        .filter({ hasNot: page.getByText("Close") })
        .first()
        .click();
      await expect(picker).toHaveCount(0);
      const pane = await invoke<{
        root: { tabs: Array<{ id: string; nativeAgentData?: { platform: string } }> };
      }>("get_pane_layout", { environmentId: environment.id });
      const resumedTab = pane.root.tabs.find((tab) => tab.nativeAgentData?.platform === "codex")!;
      expect(resumedTab).toBeTruthy();
      await assertRows(resumedTab.id);
    } finally {
      for (const item of [away, environment]) {
        if (!item) continue;
        await invoke("stop_environment", { environmentId: item.id }).catch(() => undefined);
        await invoke("delete_environment", { environmentId: item.id }).catch(() => undefined);
      }
    }
  });
});
