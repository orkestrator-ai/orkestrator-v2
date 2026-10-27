/** Opt-in live check of a Codex turn refused for its login (todo 0235).
 *
 * Run against a disposable profile whose Codex login is a made-up API key
 * (`CODEX_HOME=<throwaway dir holding the key> mise run dev:test … --credential-source
 * codex`). One prompt; app-server retries the refused request, then fails the
 * turn with a 401. Checks the failure's reason and the sign-in banner in the
 * tab, before and after a reload. Never point it at a real login.
 */
import { expect, test } from "@playwright/test";
import { PANE_LAYOUT_VERSION } from "@orkestrator/protocol/pane-layout";
import {
  authenticatedInvoke,
  profileStatus,
  sidebarNavigator,
  type Environment,
  type Project,
} from "./slash-command-live-support";

type Projection = {
  turn: { phase: string; error?: string };
  notices?: Array<{ kind: string; state?: string; message: string }>;
};
const profile = process.env.ORKESTRATOR_AGENT_TEST_PROFILE ?? "codex-refused-qa";
const REFUSED_NOTICE = "Codex's login was refused. Sign in to Codex again to keep working.";

test.use({ trace: "off", screenshot: "off" });

test.describe("Codex turn refused for its login", () => {
  test.skip(
    process.env.ORKESTRATOR_AGENT_TEST_LIVE_REFUSED_LOGIN !== "1",
    "opt-in live Codex turn against a made-up API key in a disposable profile",
  );

  test("shows the 401 and the sign-in banner, before and after a reload", async ({ page }) => {
    test.setTimeout(900_000);
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
      name: `refused-login-${Date.now()}`,
      environmentType: "local",
      networkAccessMode: "restricted",
    });
    try {
      await invoke("start_environment", { environmentId: environment.id });
      const tabId = "refused-login-tab";
      const layout = await invoke<{ revision?: number } | null>("get_pane_layout", {
        environmentId: environment.id,
      });
      await invoke("save_pane_layout", {
        environmentId: environment.id,
        expectedRevision: layout?.revision ?? 0,
        layout: {
          version: PANE_LAYOUT_VERSION,
          containerId: null,
          activePaneId: "refused-pane",
          root: {
            kind: "leaf",
            id: "refused-pane",
            activeTabId: tabId,
            tabs: [
              {
                id: tabId,
                type: "agent-native",
                displayTitle: "Codex refused login",
                nativeAgentData: {
                  environmentId: environment.id,
                  platform: "codex",
                  isLocal: true,
                },
              },
            ],
          },
        },
      });
      const projection = () =>
        invoke<Projection | null>("get_native_agent_projection", {
          environmentId: environment.id,
          agent: "codex",
          logicalSessionKey: `env-${environment.id}:${tabId}`,
        });
      const openEnvironment = sidebarNavigator(page, fixture.name);
      await page.goto(status.browserUrl!);
      await openEnvironment(environment.name);
      const compose = page.getByTestId("shared-native-compose-bar");
      const input = compose.getByRole("textbox", { name: /^Message Codex/ });
      await expect(input).toBeVisible({ timeout: 90_000 });
      await input.fill("Reply with only OK. Do not call tools.");
      await expect(compose.getByRole("button", { name: "Send", exact: true })).toBeEnabled({
        timeout: 90_000,
      });
      await input.press("Enter");
      await expect(input).toHaveText("", { timeout: 30_000 });
      await expect
        .poll(async () => (await projection())?.turn.phase, {
          timeout: 600_000,
          intervals: [2_000],
        })
        .toBe("error");
      const failed = await projection();
      expect(failed?.turn.error).toContain("401");
      expect(failed?.notices).toContainEqual(
        expect.objectContaining({ kind: "auth", state: "needs-auth", message: REFUSED_NOTICE }),
      );

      const assertVisible = async () => {
        await expect(page.getByText(/401 Unauthorized/).first()).toBeVisible({ timeout: 60_000 });
        await expect(page.getByText(REFUSED_NOTICE).first()).toBeVisible({ timeout: 60_000 });
      };
      await assertVisible();
      await page.screenshot({ path: test.info().outputPath("refused-before-reload.png") });
      await page.reload();
      await openEnvironment(environment.name);
      await assertVisible();
      await page.screenshot({ path: test.info().outputPath("refused-after-reload.png") });
    } finally {
      await invoke("stop_environment", { environmentId: environment.id }).catch(() => undefined);
      await invoke("delete_environment", { environmentId: environment.id }).catch(() => undefined);
    }
  });
});
