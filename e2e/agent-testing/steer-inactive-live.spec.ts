/**
 * Queued native steering on the inactive path (todo 0005 task 7): a prompt
 * queued behind a running turn is steered into it from the Queued Prompts
 * dialog, the renderer loses the command's response, the user switches to
 * another environment while the steer takes effect, then returns and reloads.
 * The queue must show the steered prompt gone and the next one still waiting,
 * from the backend's own snapshot, and the steer must have reached the agent
 * exactly once.
 *
 * One case per platform, each opt-in:
 *
 * - Codex, on a real model (`ORKESTRATOR_AGENT_TEST_REVIEW=1`, Codex
 *   credentials; `ORKESTRATOR_AGENT_TEST_MODEL` overrides `gpt-6.1-sol`).
 *   The model writes `.qa-queued-ready`, and appends the steer's marker to
 *   `.qa-queued-received`. Claude and Cursor take the same real-model path
 *   when `ORKESTRATOR_AGENT_TEST_STEER_REAL_PLATFORMS` names them (billed,
 *   with the profile's logins; the manual-test checklist's run).
 * - Claude and Cursor, on scripted models with no login and nothing billed
 *   (`ORKESTRATOR_AGENT_TEST_STEER_FAKE_MODELS=1`;
 *   `ORKESTRATOR_AGENT_TEST_STEER_PLATFORMS` narrows `claude,cursor`):
 *   - Claude: the profile's real Claude CLI, bridge and backend, with the
 *     model replaced by `steer-inactive-fake-claude.ts`, which makes the same
 *     two file effects through the CLI's own `Bash` tool.
 *   - Cursor: the profile's real backend and Cursor bridge over the bridge's
 *     fake SDK (`bridges/cursor-bridge/src/testing/host-fake-engine-server.ts`,
 *     swapped in for the bridge entry for the length of the case). The fake
 *     holds the run open and records every steer it accepted, so the check
 *     reads the vendor's store instead of a file.
 *
 *   mise run dev:test --profile steer7 --fixture --no-agent-credentials --no-host-seed \
 *     --agent-platforms claude,cursor --headless
 *   ORKESTRATOR_AGENT_TEST_PROFILE=steer7 ORKESTRATOR_AGENT_TEST_STEER_FAKE_MODELS=1 \
 *     mise run test:logged -- --name steer-inactive -- mise run test:agent:browser -- \
 *     e2e/agent-testing/steer-inactive-live.spec.ts
 *
 * A platform the profile has not enabled is skipped with that reason.
 */
import { waitForGatewayRenderer } from "./gateway-renderer-ready";
import { expect, test, type Page } from "./browser-test";
import { spawnSync } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { dismissSidebarTooltip } from "./sidebar-tooltip";
import { PANE_LAYOUT_VERSION } from "@orkestrator/protocol/pane-layout";
import { startLocalFakeModel, type FakeModelHandle } from "./idle-observation-fake-models";
import { dispatchProbeTurn } from "./mcp-apply-live-support";
import {
  bundleHostFakeCursorBridge,
  cursorBridgeEntry,
  fakeCursorTurns,
  readyPrompt,
  selectedSteerPlatforms,
  STEER_PLATFORM_LABELS,
  steerPrompt,
  steersCarrying,
  swapBridgeEntry,
  type SteerEngine,
  type SteerPlatform,
} from "./steer-inactive-live-support";

type Status = {
  status: string;
  profile?: string;
  flavor?: string;
  browserUrl?: string;
  dataDir?: string;
  testProject?: string;
};
type Project = { id: string; name: string; localPath: string | null };
type Environment = { id: string; name: string; worktreePath?: string | null };

const repositoryRoot = path.resolve(import.meta.dirname, "../..");
const profile = process.env.ORKESTRATOR_AGENT_TEST_PROFILE ?? "codex-qa";
const SELECTED = selectedSteerPlatforms(process.env);
const FAKE_CLAUDE = path.join(import.meta.dirname, "steer-inactive-fake-claude.ts");
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

// Backend calls carry the disposable profile's token; keep it out of traces.
test.use({ trace: "off" });

function profileStatus(): Status {
  const command = spawnSync("mise", ["run", "dev:status", "--profile", profile, "--json"], {
    cwd: repositoryRoot,
    encoding: "utf8",
  });
  if (!command.stdout.trim()) throw new Error(command.stderr || "dev:status returned no manifest");
  return JSON.parse(command.stdout) as Status;
}

async function authenticatedInvoke(page: Page, status: Status) {
  // The one-shot login URL is parsed in memory and never copied into output.
  const command = spawnSync("mise", ["run", "dev:login", "--profile", profile, "--json"], {
    cwd: repositoryRoot,
    encoding: "utf8",
  });
  if (command.status !== 0) throw new Error(command.stderr || "dev:login failed");
  const login = JSON.parse(command.stdout) as { loginUrl?: unknown };
  if (typeof login.loginUrl !== "string") throw new Error("dev:login returned no login URL");
  const response = await page.goto(login.loginUrl, { waitUntil: "load" });
  expect(response?.ok() ?? false).toBe(true);
  await waitForGatewayRenderer(page);
  return async <T>(command: string, args: Record<string, unknown> = {}): Promise<T> => {
    const invokeResponse = await page.request.post(
      new URL("/__orkestrator/invoke", status.browserUrl!).href,
      { data: { command, args } },
    );
    expect(invokeResponse.ok(), `${command}: ${await invokeResponse.text()}`).toBe(true);
    return ((await invokeResponse.json()) as { result: T }).result;
  };
}

// This host-specific notice can arrive after login, on top of any surface.
test.beforeEach(async ({ page }) => {
  const notice = page.getByRole("dialog", {
    name: "Docker containers can't reach Orkestrator",
    exact: true,
  });
  await page.addLocatorHandler(notice, async () => {
    await notice.getByRole("button", { name: "Close", exact: true }).first().click();
  });
  // A credential-free profile has no Claude login; only the Claude case
  // points Claude at a model, so the other cases meet this startup check.
  const claudeLogin = page.getByRole("alertdialog", { name: "Claude Code Is Not Logged In" });
  await page.addLocatorHandler(claudeLogin, async () => {
    await claudeLogin.getByRole("button", { name: "Continue Without Claude", exact: true }).click();
  });
});

/** The platform's scripted-model wiring; the returned function undoes it. */
async function prepareEngine(
  platform: SteerPlatform,
  engine: SteerEngine,
  status: Status,
): Promise<() => Promise<void>> {
  if (engine === "real") return async () => undefined;
  if (platform === "claude") {
    const fake: FakeModelHandle = await startLocalFakeModel("claude", status.dataDir!, {
      script: FAKE_CLAUDE,
    });
    return () => fake.stop();
  }
  if (platform === "cursor") {
    const restore = swapBridgeEntry(
      cursorBridgeEntry(repositoryRoot),
      bundleHostFakeCursorBridge(repositoryRoot),
    );
    return async () => restore();
  }
  return async () => undefined;
}

for (const platform of ["codex", "claude", "cursor"] as const) {
  const label = STEER_PLATFORM_LABELS[platform];
  test(`${label}: queued native steering survives a lost gateway response, inactive environment and reload`, async ({
    page,
  }) => {
    test.skip(
      !SELECTED.has(platform),
      platform === "codex"
        ? "opt-in isolated Codex turn (ORKESTRATOR_AGENT_TEST_REVIEW=1)"
        : "opt-in scripted-model turn (ORKESTRATOR_AGENT_TEST_STEER_FAKE_MODELS=1) or real turn (ORKESTRATOR_AGENT_TEST_STEER_REAL_PLATFORMS)",
    );
    const engine = SELECTED.get(platform)!;
    // Only the fake Cursor SDK holds a run open; every other engine is a model
    // that writes the two files through its own shell tool.
    const fakeCursor = platform === "cursor" && engine === "scripted";
    test.setTimeout(300_000);
    page.setDefaultTimeout(20_000);
    const status = profileStatus();
    expect(status.status).toBe("ready");
    expect(status.flavor).toBe("agent-test");
    const invoke = await authenticatedInvoke(page, status);
    const enabled = (
      await invoke<{ global?: { enabledAgentPlatforms?: string[] } }>("get_config").catch(
        () => null,
      )
    )?.global?.enabledAgentPlatforms;
    test.skip(
      enabled !== undefined && !enabled.includes(platform),
      `${label} is not enabled in profile ${profile}`,
    );
    const fixture = (await invoke<Project[]>("get_projects")).find(
      (project) => project.localPath === status.testProject,
    )!;
    expect(fixture).toBeTruthy();
    // Before the environment exists, so its bridge's first process reads it.
    const undoEngine = await prepareEngine(platform, engine, status);
    const environments: Environment[] = [];
    let sessionIdentity:
      { environmentId: string; agent: string; logicalSessionKey: string } | undefined;
    try {
      for (const name of ["queued-steer", "queued-other"])
        environments.push(
          await invoke<Environment>("create_environment", {
            projectId: fixture.id,
            name: `${name}-${platform}-${Date.now()}`,
            environmentType: "local",
          }),
        );
      const [target, other] = environments;
      await invoke("start_environment", { environmentId: target!.id });
      const hydrated = await invoke<Environment>("get_environment", { environmentId: target!.id });
      const tabId = `queued-steer-${platform}-tab`;
      sessionIdentity = {
        environmentId: target!.id,
        agent: platform,
        logicalSessionKey: `env-${target!.id}:${tabId}`,
      };
      const layout = await invoke<{ revision: number } | null>("get_pane_layout", {
        environmentId: target!.id,
      });
      await invoke("save_pane_layout", {
        environmentId: target!.id,
        expectedRevision: layout?.revision ?? 0,
        layout: {
          version: PANE_LAYOUT_VERSION,
          containerId: null,
          activePaneId: "queue-pane",
          root: {
            kind: "leaf",
            id: "queue-pane",
            tabs: [
              {
                id: tabId,
                type: "agent-native",
                nativeAgentData: { environmentId: target!.id, platform, isLocal: true },
              },
            ],
            activeTabId: tabId,
          },
        },
      });
      const readyFile = path.join(hydrated.worktreePath!, ".qa-queued-ready");
      const receivedFile = path.join(hydrated.worktreePath!, ".qa-queued-received");
      const marker = `queued-steer-${Date.now()}`;
      const identity = sessionIdentity;
      const codexModel = process.env.ORKESTRATOR_AGENT_TEST_MODEL ?? "gpt-6.1-sol";
      // A fresh environment's first dispatch can be refused while its bridge
      // starts; a refused request never ran, so it is sent again under a new id.
      let attempt = 0;
      const dispatch = await dispatchProbeTurn(
        (requestId) =>
          invoke<{ outcome: string; error?: string }>("dispatch_native_agent_intent", {
            ...identity,
            ...(platform === "codex" ? { model: codexModel, reasoningEffort: "low" } : {}),
            mode: "build",
            requestId,
            prompt: readyPrompt(platform, engine),
          }),
        () => `ready-${marker}-${(attempt += 1)}`,
        () => sleep(3_000),
      );
      expect(dispatch.outcome, dispatch.error).toBe("accepted");
      if (fakeCursor) {
        await expect
          .poll(
            () =>
              fakeCursorTurns(status.dataDir!, target!.id).filter(
                (turn) => turn.status === "running" && turn.prompt.includes(".qa-queued-ready"),
              ).length,
            { timeout: 120_000 },
          )
          .toBe(1);
      } else {
        await expect
          .poll(() => fs.readFile(readyFile, "utf8").catch(() => ""), { timeout: 120_000 })
          .toContain("ready");
      }
      const queueKey = `${platform}\0${identity.logicalSessionKey}`;
      const queued = {
        id: `source-${marker}`,
        text: steerPrompt(marker),
        ...(platform === "codex" ? { model: codexModel } : {}),
        mode: "build",
      };
      const tail = { id: `tail-${marker}`, text: "Wait for further instructions." };
      for (const message of [queued, tail])
        await invoke("enqueue_prompt_queue_message", {
          queueKey,
          environmentId: target!.id,
          message,
        });
      const openEnvironment = async (name: string) => {
        const expand = page.getByRole("button", { name: `Expand project ${fixture.name}` });
        const entry = page.getByText(name, { exact: true }).first();
        await expect(expand.or(entry)).toBeVisible({ timeout: 30_000 });
        for (const continueLabel of ["Continue Without Docker", "Continue Without GitHub CLI"]) {
          const button = page.getByRole("button", { name: continueLabel, exact: true });
          if (await button.isVisible()) await button.click();
        }
        const versionNotice = page.getByText("Orkestrator has been updated", { exact: true });
        // A startup dialog (the Claude login check) can open at any point and
        // hides the sidebar from the accessibility tree, so "Expand project"
        // reads as absent while it is up. Retry until the entry is clicked.
        await expect(async () => {
          if (await expand.isVisible()) await expand.click();
          if (await versionNotice.isVisible()) {
            await versionNotice.click({ timeout: 2_000 }).catch(() => undefined);
            await expect(versionNotice).toBeHidden();
          }
          await dismissSidebarTooltip(page, fixture.name);
          await entry.click({ timeout: 5_000 });
        }).toPass({ timeout: 60_000 });
      };
      await page.goto(status.browserUrl!);
      await openEnvironment(target!.name);
      await page.getByTitle("View queued prompts").click();
      const dialog = page.getByRole("dialog", { name: "Queued Prompts" });
      await expect(dialog.getByRole("button", { name: "Steer", exact: true })).toHaveCount(2);
      let dropped = false;
      await page.route("**/__orkestrator/invoke", async (route) => {
        if (route.request().postDataJSON()?.command !== "steer_native_agent_queued_prompt")
          return route.continue();
        const response = await route.fetch();
        expect(response.ok()).toBe(true);
        dropped = true;
        await route.abort("failed"); // execution succeeded; only the renderer's acknowledgement is lost
      });
      await dialog.getByRole("button", { name: "Steer", exact: true }).first().click();
      await expect.poll(() => dropped).toBe(true);
      await expect(dialog.getByRole("alert")).toBeVisible();
      await dialog.getByRole("button", { name: "Close", exact: true }).click();
      await openEnvironment(other!.name);
      // The steer reached the agent exactly once while its environment was inactive.
      if (fakeCursor) {
        await expect
          .poll(() => steersCarrying(fakeCursorTurns(status.dataDir!, target!.id), marker), {
            timeout: 120_000,
          })
          .toBe(1);
        // Steered into the held run, not started as a turn of its own.
        expect(fakeCursorTurns(status.dataDir!, target!.id)).toEqual([
          expect.objectContaining({ status: "running", prompt: expect.stringContaining("HOLD") }),
        ]);
      } else {
        await expect
          .poll(
            () =>
              fs
                .readFile(receivedFile, "utf8")
                .then((text) => text.trim())
                .catch(() => ""),
            { timeout: 120_000 },
          )
          .toBe(marker);
      }
      const readQueue = () =>
        invoke<{ messages: unknown[]; inFlight?: unknown }>("get_prompt_queue", { queueKey });
      expect((await readQueue()).messages).toEqual([tail]);
      expect((await readQueue()).inFlight).toBeUndefined();
      await openEnvironment(target!.name);
      await page.getByTitle("View queued prompts").click();
      await expect(dialog.getByRole("button", { name: tail.text, exact: true })).toBeVisible();
      await expect(dialog.getByRole("button", { name: queued.text, exact: true })).toHaveCount(0);
      await dialog.getByRole("button", { name: "Close", exact: true }).click();
      await page.reload();
      await openEnvironment(target!.name);
      await page.getByTitle("View queued prompts").click();
      await expect(dialog.getByRole("button", { name: tail.text, exact: true })).toBeVisible();
      await expect(dialog.getByRole("button", { name: queued.text, exact: true })).toHaveCount(0);
      expect((await readQueue()).messages).toEqual([tail]);
      if (fakeCursor) {
        expect(steersCarrying(fakeCursorTurns(status.dataDir!, target!.id), marker)).toBe(1);
      } else {
        expect((await fs.readFile(receivedFile, "utf8")).trim()).toBe(marker);
      }
    } finally {
      if (sessionIdentity)
        await invoke("stop_native_agent_session", sessionIdentity).catch(() => undefined);
      for (const environment of environments) {
        await invoke("stop_environment", { environmentId: environment.id }).catch(() => undefined);
        await invoke("delete_environment", { environmentId: environment.id }).catch(
          () => undefined,
        );
      }
      await undoEngine();
    }
  });
}
