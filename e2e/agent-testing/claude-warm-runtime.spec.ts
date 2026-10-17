// Live qualification of the warm CLI through the application and its backend.
// Run only in a disposable dev:test --fixture profile with Claude credentials.
import { expect, test, type Page } from "@playwright/test";
import { spawnSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { PANE_LAYOUT_VERSION } from "@orkestrator/protocol/pane-layout";
import type { NativeAgentSessionProjection } from "@orkestrator/protocol/native-agent";

type Environment = { id: string; name: string; worktreePath?: string };
const root = path.resolve(import.meta.dirname, "../..");
const profile = process.env.ORKESTRATOR_AGENT_TEST_PROFILE ?? "codex-qa";

async function connect(page: Page) {
  const run = (task: string) => {
    const result = spawnSync("mise", ["run", task, "--profile", profile, "--json"], {
      cwd: root,
      encoding: "utf8",
      timeout: 30_000,
    });
    if (result.status !== 0) throw new Error(`${task} failed`);
    return JSON.parse(result.stdout);
  };
  const status = run("dev:status") as {
    status: string;
    flavor: string;
    testProject: string;
    browserUrl: string;
  };
  expect(status.status).toBe("ready");
  expect(status.flavor).toBe("agent-test");
  expect(status.testProject).toBeTruthy();
  const login = run("dev:login") as { loginUrl: string };
  await page.goto(login.loginUrl);
  const invoke = async <T>(command: string, args: Record<string, unknown> = {}): Promise<T> => {
    const response = await page.request.post(
      new URL("/__orkestrator/invoke", status.browserUrl).href,
      { data: { command, args } },
    );
    expect(response.ok(), `${command} failed`).toBe(true);
    return ((await response.json()) as { result: T }).result;
  };
  const projects =
    await invoke<Array<{ id: string; name: string; localPath: string }>>("get_projects");
  const fixture = projects.find((project) => project.localPath === status.testProject);
  expect(fixture).toBeTruthy();
  return { invoke, fixture: fixture!, status };
}

function text(projection: NativeAgentSessionProjection | null): string {
  return (projection?.messages ?? [])
    .filter((message) => (message as { role?: string }).role === "assistant")
    .map((message) => (message as { content?: string }).content ?? "")
    .join("\n");
}

test("Claude follow-ups, controls, paused approvals and MCP edits survive inactive environments", async ({
  page,
}, testInfo) => {
  test.skip(
    process.env.ORKESTRATOR_AGENT_TEST_LIVE_CLAUDE !== "1",
    "requires explicit live Claude qualification opt-in",
  );
  page.setDefaultTimeout(15_000);
  const { invoke, fixture, status } = await connect(page);
  const environments: Environment[] = [];
  try {
    for (const name of ["claude-warm", "claude-away"]) {
      environments.push(
        await invoke<Environment>("create_environment", {
          projectId: fixture.id,
          name: `${name}-${Date.now()}`,
          networkAccessMode: "restricted",
          environmentType: "local",
        }),
      );
    }
    const [target, other] = environments as [Environment, Environment];
    // Host sessions exclude project resources by default. Trust only this
    // disposable fixture so its later .mcp.json edit is an admitted source.
    await invoke("update_environment_agent_settings", {
      environmentId: target.id,
      agentSettings: { executionPolicy: { projectResources: true } },
    });
    await invoke("start_environment", { environmentId: target.id });
    const environment = await invoke<Environment>("get_environment", { environmentId: target.id });
    expect(environment.worktreePath).toBeTruthy();
    const tabId = "claude-warm-tab";
    const identity = {
      environmentId: target.id,
      agent: "claude",
      logicalSessionKey: `env-${target.id}:${tabId}`,
    };
    const layout = await invoke<{ revision?: number } | null>("get_pane_layout", {
      environmentId: target.id,
    });
    await invoke("save_pane_layout", {
      environmentId: target.id,
      expectedRevision: layout?.revision ?? 0,
      layout: {
        version: PANE_LAYOUT_VERSION,
        containerId: null,
        activePaneId: "warm-pane",
        root: {
          kind: "leaf",
          id: "warm-pane",
          activeTabId: tabId,
          tabs: [
            {
              id: tabId,
              type: "agent-native",
              nativeAgentData: { environmentId: target.id, platform: "claude", isLocal: true },
              initialAgentModel: "claude-sonnet-4-6",
            },
          ],
        },
      },
    });
    const open = async (name: string) => {
      const expand = page.getByRole("button", { name: `Expand project ${fixture.name}` });
      const entry = page.getByText(name, { exact: true }).first();
      await expect(expand.or(entry)).toBeVisible({ timeout: 90_000 });
      for (const label of ["Continue Without Docker", "Continue Without GitHub CLI"]) {
        const button = page.getByRole("button", { name: label, exact: true });
        if (await button.isVisible()) await button.click();
      }
      if (await expand.isVisible()) await expand.click();
      await page.mouse.move(0, 0);
      await entry.click();
    };
    const read = () =>
      invoke<NativeAgentSessionProjection | null>("get_native_agent_projection", identity);
    const reply = (token: string) =>
      expect
        .poll(
          async () => {
            const projection = await read();
            if (projection?.turn.phase === "error" && projection.turn.error) {
              throw new Error(
                "Claude reported a terminal turn error; inspect the isolated bridge logs",
              );
            }
            return projection?.turn.phase === "idle" && text(projection).includes(token);
          },
          { timeout: 180_000 },
        )
        .toBe(true);
    const choose = async (kind: "mode" | "approval-mode", label: string) => {
      const picker = page.getByTestId(`native-${kind}-picker`);
      await expect(picker).toBeEnabled();
      await picker.press("Enter");
      await page.getByRole("menuitemradio", { name: label, exact: true }).press("Enter");
      await expect(picker).toHaveAttribute(
        "aria-label",
        `${kind === "mode" ? "Mode" : "Approvals"}: ${label}`,
      );
    };
    const compose = page.getByTestId("shared-native-compose-bar");
    const input = compose.getByRole("textbox", { name: "Message Claude", exact: true });
    const send = async (prompt: string) => {
      await expect(input).toBeVisible({ timeout: 90_000 });
      await input.fill(prompt);
      const button = compose.getByRole("button", { name: "Send", exact: true });
      await expect(button).toBeEnabled({ timeout: 60_000 });
      await input.press("Enter");
      await expect(input).toHaveText("");
    };
    await page.goto(status.browserUrl);
    await open(target.name);
    await send("Reply exactly WARM_FIRST. Do not use any tools.");
    await open(other.name);
    console.log("[claude-warm] first turn submitted in inactive environment");
    await reply("WARM_FIRST");
    console.log("[claude-warm] first turn settled");
    const sessionId = (await read())!.sessionId;
    await open(target.name);
    await expect(page.getByText("WARM_FIRST", { exact: true }).last()).toBeVisible();

    await choose("mode", "Plan");
    await send("Reply exactly WARM_PLAN. Do not use tools or create a plan.");
    await reply("WARM_PLAN");
    console.log("[claude-warm] plan follow-up settled");
    expect((await read())!.sessionId).toBe(sessionId);
    await choose("mode", "Build");
    await choose("approval-mode", "Ask");
    await send(
      "Run Bash command `printf warm > claude-warm-canary.txt` exactly once. Do not use other tools. After the result reply exactly WARM_APPROVAL.",
    );
    await expect
      .poll(async () => (await read())?.interactions.length ?? 0, { timeout: 180_000 })
      .toBeGreaterThan(0);
    const request = (await read())!.interactions[0]!;
    expect(["command-approval", "permission"]).toContain(request.kind);
    await page.getByRole("button", { name: /^Pause countdown,/ }).press("Enter");
    await expect(page.getByRole("button", { name: "Resume countdown", exact: true })).toBeVisible();
    await open(other.name);
    await expect.poll(async () => (await read())?.interactions[0]?.hold?.heldAt).toBeTruthy();
    await open(target.name);
    expect((await read())!.interactions[0]!.id).toBe(request.id);
    await expect(page.getByRole("button", { name: "Resume countdown", exact: true })).toBeVisible();
    const approve = page.getByRole("button", { name: "Approve", exact: true });
    await expect(approve).toBeEnabled();
    await approve.press("Enter");
    await reply("WARM_APPROVAL");
    console.log("[claude-warm] paused approval follow-up settled");
    expect((await read())!.interactions).toHaveLength(0);

    // Edit only the fixture worktree. The harmless server answers its own name.
    await choose("approval-mode", "Bypass");
    // Establish the new permission boundary before editing MCP so the MCP
    // follow-up must update an already warm process rather than only launch it.
    await send("Reply exactly WARM_BUILD. Do not use any tools.");
    await reply("WARM_BUILD");
    const marker = path.join(environment.worktreePath!, "warm-mcp-marker.txt");
    await writeFile(
      path.join(environment.worktreePath!, ".mcp.json"),
      JSON.stringify({
        mcpServers: {
          "warm-probe": {
            command: "bun",
            args: [
              path.join(
                root,
                "bridges/claude-bridge/src/services/session-manager-prompt-mcp-sync.live-fixture.ts",
              ),
              "warm",
              "1",
              marker,
            ],
          },
        },
      }),
    );
    await send("Call the warm-probe server's probe_warm tool once, then reply exactly WARM_MCP.");
    await open(other.name);
    await reply("WARM_MCP");
    console.log("[claude-warm] MCP follow-up settled");
    expect(await readFile(marker, "utf8")).toContain("call warm");
    await open(target.name);
    await page.reload();
    await open(target.name);
    await expect(page.getByText("WARM_MCP", { exact: true }).last()).toBeVisible({
      timeout: 90_000,
    });
    expect((await read())!.sessionId).toBe(sessionId);
    expect(text(await read())).toContain("WARM_FIRST");
  } catch (error) {
    if (environments[0])
      await page
        .getByText(environments[0].name, { exact: true })
        .first()
        .click({ timeout: 5_000 })
        .catch(() => undefined);
    await page
      .screenshot({ path: testInfo.outputPath("before-cleanup.png"), fullPage: true })
      .catch(() => undefined);
    throw error;
  } finally {
    for (const environment of environments.reverse()) {
      await invoke("stop_environment", { environmentId: environment.id }).catch(() => undefined);
      await invoke("delete_environment", { environmentId: environment.id }).catch(() => undefined);
    }
  }
});
