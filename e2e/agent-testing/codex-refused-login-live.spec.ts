/** Opt-in live check of a Codex turn refused for its login (todo 0235).
 *
 * Run against a disposable profile whose Codex login is a made-up API key
 * (`CODEX_HOME=<throwaway dir holding the key> mise run dev:test … --credential-source
 * codex`). One prompt; app-server retries the refused request, then fails the
 * turn with a 401. Checks the failure's reason and the sign-in banner in the
 * tab, before and after a reload. With
 * `ORKESTRATOR_AGENT_TEST_PROFILE_CODEX_HOME` (the profile's own
 * `agent-credentials/codex`, never a real Codex home) it then replaces the key
 * and checks the notice clears. Never point it at a real login.
 */
import { randomBytes } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
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
  sessionId?: string;
  turn: { phase: string; error?: string };
  messages: Array<{ id: string }>;
  notices?: Array<{ kind: string; state?: string; message: string }>;
};
const profile = process.env.ORKESTRATOR_AGENT_TEST_PROFILE ?? "codex-refused-qa";
// The profile's login is an API key, so the notice names it (`account/read`).
const REFUSED_NOTICE =
  "Codex's API key was refused. Replace it with codex login --with-api-key, or sign in to Codex with ChatGPT instead.";

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
      expect(failed).not.toBeNull();
      expect(failed!.sessionId).toBeTruthy();
      expect(failed!.messages.length).toBeGreaterThan(0);
      expect(failed?.turn.error).toContain("401");
      // The login kind can arrive just after the failure and reword the notice.
      await expect
        .poll(async () => (await projection())?.notices ?? [], {
          timeout: 60_000,
          intervals: [1_000],
        })
        .toContainEqual(
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

      // Optional: replace the key the way `codex login --with-api-key` stores
      // it, in the profile's own Codex home, and expect the notice to clear
      // without a sign-in. The new key is made up too, so only the clearing is
      // checked, not a working turn.
      const profileCodexHome = process.env.ORKESTRATOR_AGENT_TEST_PROFILE_CODEX_HOME;
      if (profileCodexHome) {
        const authFile = path.join(profileCodexHome, "auth.json");
        expect(JSON.parse(readFileSync(authFile, "utf8")).auth_mode).toBe("apikey");
        writeFileSync(
          authFile,
          JSON.stringify({
            auth_mode: "apikey",
            OPENAI_API_KEY: `sk-proj-replaced-${randomBytes(18).toString("hex")}`,
          }),
          { mode: 0o600 },
        );
        await page.reload();
        await openEnvironment(environment.name);
        await expect
          .poll(
            async () => {
              const restored = await projection();
              return restored && { ...restored, notices: restored.notices ?? [] };
            },
            { timeout: 120_000, intervals: [2_000] },
          )
          .toMatchObject({
            sessionId: failed!.sessionId,
            turn: failed!.turn,
            messages: expect.arrayContaining(
              failed!.messages.map(({ id }) => expect.objectContaining({ id })),
            ),
            notices: expect.not.arrayContaining([expect.objectContaining({ kind: "auth" })]),
          });
        await expect(page.getByText(REFUSED_NOTICE)).toHaveCount(0, { timeout: 60_000 });
        await expect(page.getByText(/401 Unauthorized/).first()).toBeVisible();
        await expect(input).toBeEnabled();
        await input.fill("Reply with only OK. Do not call tools.");
        await expect(compose.getByRole("button", { name: "Send", exact: true })).toBeEnabled({
          timeout: 60_000,
        });
        await page.screenshot({ path: test.info().outputPath("refused-after-key-replaced.png") });
      }
    } finally {
      await invoke("stop_environment", { environmentId: environment.id }).catch(() => undefined);
      await invoke("delete_environment", { environmentId: environment.id }).catch(() => undefined);
    }
  });
});
