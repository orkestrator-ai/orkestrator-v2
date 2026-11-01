/** Opt-in live check of a real Codex approval card and saved rules (todo 0160).
 *
 * Run against a disposable profile whose Codex login is a made-up API key:
 *
 *   CODEX_HOME=<throwaway dir holding the key> mise run dev:test --profile codex-rules-qa \
 *     --fixture --credential-source codex --agent-platforms codex
 *   ORKESTRATOR_AGENT_TEST_LIVE_CODEX_RULES=1 ORKESTRATOR_AGENT_TEST_PROFILE=codex-rules-qa \
 *     bunx playwright test --config e2e/agent-testing/playwright.browser.config.ts \
 *     codex-saved-rules-live.spec.ts
 *
 * The spec points the profile's own Codex home at a loopback model
 * (`codex-saved-rules-model.ts`), so the real pinned app-server asks for real
 * and no credits are spent. Never point it at a real login.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";
import { expect, test, type Page } from "@playwright/test";
import { PANE_LAYOUT_VERSION } from "@orkestrator/protocol/pane-layout";
import {
  authenticatedInvoke,
  profileStatus,
  sidebarNavigator,
  type Environment,
  type Project,
} from "./slash-command-live-support";

type Projection = { turn: { phase: string } };

const profile = process.env.ORKESTRATOR_AGENT_TEST_PROFILE ?? "codex-rules-qa";
const PROBE_FILE = "saved-rules-probe.txt";
// Each exactly as the pinned Codex 0.166.0 writes it.
const COMMAND_RULE = `prefix_rule(pattern=["touch", "${PROBE_FILE}"], decision="allow")`;
const NETWORK_RULE =
  'network_rule(host="probe-host.example.test", protocol="http", decision="allow", justification="Allow http access to probe-host.example.test")';

async function startModel(): Promise<{ baseUrl: string; child: ChildProcess }> {
  const child = spawn(
    "bun",
    [path.join(import.meta.dirname, "codex-saved-rules-model.ts"), `touch ${PROBE_FILE}`],
    { stdio: ["ignore", "pipe", "inherit"] },
  );
  const lines = createInterface({ input: child.stdout! });
  const baseUrl = await new Promise<string>((resolve, reject) => {
    lines.once("line", resolve);
    child.once("exit", () => reject(new Error("the loopback model exited")));
  });
  return { baseUrl, child };
}

test.use({ trace: "off" });

test.describe("Codex approval card and saved rules", () => {
  test.skip(
    process.env.ORKESTRATOR_AGENT_TEST_LIVE_CODEX_RULES !== "1",
    "opt-in live Codex turns against a loopback model in a disposable profile",
  );

  test("the card saves nothing; a saved rule is listed, applies, and asks again once removed", async ({
    page,
  }) => {
    test.setTimeout(600_000);
    await page.setViewportSize({ width: 1440, height: 1200 });
    const status = profileStatus(profile);
    expect(status.status).toBe("ready");
    expect(status.flavor).toBe("agent-test");
    const { dataDir } = status as unknown as { dataDir: string };
    const codexHome = path.join(dataDir, "agent-credentials", "codex");
    const rulesDir = path.join(codexHome, "rules");
    const invoke = await authenticatedInvoke(page, status, profile);
    const fixture = (await invoke<Project[]>("get_projects")).find(
      (project) => project.localPath === status.testProject,
    )!;
    expect(fixture).toBeTruthy();
    const model = await startModel();
    // A top-level key, so it goes before any table Codex has added.
    const configFile = path.join(codexHome, "config.toml");
    const earlierConfig = existsSync(configFile)
      ? readFileSync(configFile, "utf8").replace(/^openai_base_url = .*\n/m, "")
      : "";
    writeFileSync(
      configFile,
      `openai_base_url = ${JSON.stringify(model.baseUrl)}\n${earlierConfig}`,
      { mode: 0o600 },
    );
    const environments: string[] = [];
    const openEnvironment = sidebarNavigator(page, fixture.name);
    const rulesFiles = () => (existsSync(rulesDir) ? readdirSync(rulesDir) : []);

    /** A new environment under an Ask policy, whose Codex thread starts now. */
    const openCodex = async (name: string) => {
      const environment = await invoke<Environment>("create_environment", {
        projectId: fixture.id,
        name: `${name}-${Date.now()}`,
        environmentType: "local",
      });
      environments.push(environment.id);
      await invoke("update_environment_agent_settings", {
        environmentId: environment.id,
        agentSettings: { executionPolicy: { approvals: "ask" } },
      });
      await invoke("start_environment", { environmentId: environment.id });
      const tabId = `${name}-tab`;
      const layout = await invoke<{ revision?: number } | null>("get_pane_layout", {
        environmentId: environment.id,
      });
      await invoke("save_pane_layout", {
        environmentId: environment.id,
        expectedRevision: layout?.revision ?? 0,
        layout: {
          version: PANE_LAYOUT_VERSION,
          containerId: null,
          activePaneId: `${name}-pane`,
          root: {
            kind: "leaf",
            id: `${name}-pane`,
            activeTabId: tabId,
            tabs: [
              {
                id: tabId,
                type: "agent-native",
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
      const identity = {
        environmentId: environment.id,
        agent: "codex",
        logicalSessionKey: `env-${environment.id}:${tabId}`,
      };
      const projection = () => invoke<Projection | null>("get_native_agent_projection", identity);
      await page.goto(status.browserUrl!);
      await openEnvironment(environment.name);
      await expect(page.getByTestId("shared-native-compose-bar")).toBeVisible({ timeout: 90_000 });
      let sent = 0;
      return {
        send: async () => {
          sent += 1;
          const dispatched = await invoke<{ outcome: string; error?: string }>(
            "dispatch_native_agent_intent",
            {
              ...identity,
              requestId: `${name}-${sent}-${Date.now()}`,
              mode: "build",
              prompt: "Run the probe.",
            },
          );
          expect(dispatched.outcome, dispatched.error).not.toBe("rejected");
          await expect
            .poll(async () => (await projection())?.turn.phase, { timeout: 60_000 })
            .not.toBe("idle");
        },
        finished: () =>
          expect
            .poll(async () => (await projection())?.turn.phase, {
              timeout: 120_000,
              intervals: [1_000],
            })
            .toBe("idle"),
      };
    };
    const approve = (target: Page) => target.getByRole("button", { name: "Approve", exact: true });
    const openPermissions = async () => {
      await page.getByRole("button", { name: "Global settings" }).click();
      await page
        .getByRole("navigation", { name: "Settings sections" })
        .getByRole("button", { name: "Permissions", exact: true })
        .click();
      const region = page.getByRole("region", { name: "Rules outside Orkestrator" });
      await expect(region).toBeVisible({ timeout: 30_000 });
      return region;
    };

    try {
      await test.step("the card offers plain approval, and Approve saves no rule", async () => {
        const codex = await openCodex("rules-card");
        await codex.send();
        await expect(approve(page)).toBeVisible({ timeout: 120_000 });
        await expect(page.getByRole("button", { name: "Approve for session" })).toBeVisible();
        await expect(page.getByRole("button", { name: "Approve and remember…" })).toBeVisible();
        await expect(page.getByRole("button", { name: "Deny", exact: true })).toBeVisible();
        await expect(page.getByText(/command policy|network policy|Broader approval/)).toHaveCount(
          0,
        );
        await page.screenshot({ path: test.info().outputPath("codex-card.png") });
        await approve(page).click();
        await codex.finished();
        expect(rulesFiles()).toEqual([]);

        // Nothing was remembered: the identical command asks again.
        await codex.send();
        await expect(approve(page)).toBeVisible({ timeout: 120_000 });
        await page.getByRole("button", { name: "Deny", exact: true }).click();
        await codex.finished();
        expect(rulesFiles()).toEqual([]);
      });

      await test.step("a rule Codex saved is listed read-only and applies", async () => {
        mkdirSync(rulesDir, { recursive: true });
        writeFileSync(path.join(rulesDir, "default.rules"), `${COMMAND_RULE}\n${NETWORK_RULE}\n`);
        const region = await openPermissions();
        const file = region
          .getByTestId("external-rule-file")
          .filter({ hasText: "Host Codex home" });
        await expect(file).toContainText(COMMAND_RULE);
        await expect(file).toContainText(NETWORK_RULE);
        await expect(file).toContainText("new Codex sessions ask again");
        await expect(file).toContainText("a session already running keeps the rule");
        await expect(file.getByRole("button")).toHaveCount(0);
        await page.screenshot({ path: test.info().outputPath("rules-outside-orkestrator.png") });

        const codex = await openCodex("rules-saved");
        await codex.send();
        await codex.finished();
        await expect(approve(page)).toHaveCount(0);
      });

      await test.step("removed from the file, it is gone and a new session asks again", async () => {
        rmSync(path.join(rulesDir, "default.rules"));
        const region = await openPermissions();
        await expect(region).not.toContainText(COMMAND_RULE);
        await expect(region).not.toContainText(NETWORK_RULE);

        const codex = await openCodex("rules-removed");
        await codex.send();
        await expect(approve(page)).toBeVisible({ timeout: 120_000 });
        await page.getByRole("button", { name: "Deny", exact: true }).click();
        await codex.finished();
        expect(rulesFiles()).toEqual([]);
      });
    } finally {
      model.child.kill();
      for (const environmentId of environments) {
        await invoke("stop_environment", { environmentId }).catch(() => undefined);
        await invoke("delete_environment", { environmentId }).catch(() => undefined);
      }
    }
  });
});
