/**
 * The design-tool cycle with a real Claude or Codex, in the real app.
 *
 * Opt-in (`ORKESTRATOR_AGENT_TEST_LIVE_DESIGN=1`) against a running
 * `dev:test --fixture` profile with host credentials. Each provider in
 * `ORKESTRATOR_AGENT_TEST_DESIGN_PROVIDERS` (default `claude,codex`) runs one
 * fixture-scoped cycle in its own pair of disposable environments
 * (docs/todo/design-canvas/0036-design-canvas-qualification.md, "Live agents"):
 *
 * 1. **Launch.** New design workspace with the provider. The brief asks the
 *    agent to create, inspect, refine, capture and `save_canvas` through the
 *    `orkestrator-design` MCP server. The launch must link the conversation
 *    to the canvas. The test switches environment as soon as the opening
 *    prompt is accepted, so the rest of the turn runs while the canvas is
 *    inactive. A renderer reload on return must restore the canvas and session link.
 * 2. **Ask agent, stale.** The toolbar's Ask agent dialog captures the
 *    selection, then another client edits the frame before the context is
 *    added to the design conversation's draft. The agent must re-read: the
 *    other client's edit survives and the requested edit lands on top.
 * 3. **Approval.** The composer's approval mode is set to the provider's Ask
 *    mode and the agent is asked to run one shell command before an edit. The
 *    test switches environment and reloads while the approval is pending, returns, checks
 *    that the request is still pending and the canvas untouched, approves, and
 *    waits for the edit.
 * 4. **Handoff.** Ask agent with the Implement scope starts a new
 *    conversation whose draft holds the handoff. Nothing may be sent, and the
 *    draft survives an environment switch and renderer reload.
 *
 * Nonces exist only in the prompts, so finding one in the canvas proves the
 * agent wrote it. The MCP call count and response bytes for the cycle are
 * read from the backend's transcript and attached as `design-mcp-usage`.
 *
 * A provider is skipped, with its reason, when the profile has not enabled
 * it. Anything else fails. Real turns cost tokens; this spec runs only when
 * asked for. Nothing at module scope spawns `mise`, so the file stays inert in
 * profile-free runs.
 */
import { expect, test, type Locator, type Page, type TestInfo } from "@playwright/test";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { withDesignLiveHeartbeat } from "./design-live-heartbeat";
import { detailBytes, summarizeDesignToolCalls, type TranscriptMessage } from "./design-live-usage";

type Status = {
  status: string;
  profile?: string;
  flavor?: string;
  browserUrl?: string;
  testProject?: string;
};
type Project = { id: string; name: string; localPath: string | null };
type Environment = { id: string; name: string; worktreePath?: string | null };
type Interaction = {
  id: string;
  kind: string;
  state: string;
  presentation: { confirmLabel?: string };
};
type Projection = {
  turn: { phase: string; error?: string };
  messages?: TranscriptMessage[];
  interactions?: Interaction[];
  recoverableDispatch?: unknown;
} | null;
type Frame = { id: string; name: string; revision: number; html: string };
type Summary = { id: string; revision: number; frames: Array<{ id: string; name: string }> };
type LayoutTab = {
  id: string;
  type: string;
  nativeAgentData?: { platform?: string };
  designCanvasData?: { canvasId: string };
};
type LayoutNode = { kind: "leaf"; tabs: LayoutTab[] } | { kind: "split"; children: LayoutNode[] };
type SessionLink = { tabId: string; platform: string; role: string };
type Invoke = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;

const repositoryRoot = path.resolve(import.meta.dirname, "../..");
const profile = process.env.ORKESTRATOR_AGENT_TEST_PROFILE ?? "codex-qa";
const LIVE_OPT_IN = process.env.ORKESTRATOR_AGENT_TEST_LIVE_DESIGN === "1";
const TURN_TIMEOUT_MS = Number(
  process.env.ORKESTRATOR_AGENT_TEST_DESIGN_TURN_TIMEOUT_MS ?? "420000",
);

/** The Ask approval mode each provider's composer offers, by its label. */
const PROVIDERS = {
  claude: { label: "Claude", askMode: "Ask" },
  codex: { label: "Codex", askMode: "Untrusted" },
} as const;
type Provider = keyof typeof PROVIDERS;
/**
 * Requests a tool call can wait on. Codex asks an `mcp-form` before an MCP tool
 * call when the approval mode is not auto-approve.
 */
const TOOL_APPROVAL_KINDS = new Set([
  "command-approval",
  "file-approval",
  "permission",
  "mcp-form",
]);
/** The interaction card's confirm button (`NativeAgentInteractionCard`). */
const confirmLabel = (item: Interaction) => item.presentation.confirmLabel ?? "Continue";

/**
 * `ORKESTRATOR_AGENT_TEST_DESIGN_MODELS`: `<platform>=<model id>` pairs, for
 * example `claude=claude-haiku-4-5` when a busy account rate-limits the default.
 */
function selectedModel(provider: Provider): string | undefined {
  for (const pair of (process.env.ORKESTRATOR_AGENT_TEST_DESIGN_MODELS ?? "").split(",")) {
    const [platform, model] = pair.split("=").map((value) => value.trim());
    if (platform === provider && model) return model;
  }
  return undefined;
}

function selectedProviders(): Provider[] {
  const raw = process.env.ORKESTRATOR_AGENT_TEST_DESIGN_PROVIDERS?.trim() || "claude,codex";
  return raw.split(",").map((value) => {
    const provider = value.trim();
    if (!(provider in PROVIDERS)) {
      throw new Error(
        `ORKESTRATOR_AGENT_TEST_DESIGN_PROVIDERS: unsupported provider "${provider}" ` +
          `(supported: ${Object.keys(PROVIDERS).join(", ")})`,
      );
    }
    return provider as Provider;
  });
}

function profileStatus(): Status {
  const command = spawnSync("mise", ["run", "dev:status", "--profile", profile, "--json"], {
    cwd: repositoryRoot,
    encoding: "utf8",
  });
  if (!command.stdout.trim()) {
    throw new Error(
      `dev:status for profile "${profile}" returned no manifest: ${command.stderr.trim()}`,
    );
  }
  return JSON.parse(command.stdout) as Status;
}

async function authenticatedInvoke(page: Page, status: Status): Promise<Invoke> {
  // The one-shot login URL is parsed in memory and never copied into output.
  const command = spawnSync("mise", ["run", "dev:login", "--profile", profile, "--json"], {
    cwd: repositoryRoot,
    encoding: "utf8",
  });
  if (command.status !== 0) throw new Error(command.stderr || "dev:login failed");
  const login = JSON.parse(command.stdout) as { loginUrl?: unknown };
  if (typeof login.loginUrl !== "string") throw new Error("dev:login returned no login URL");
  const response = await page.goto(login.loginUrl, { waitUntil: "domcontentloaded" });
  expect(response?.ok() ?? false).toBe(true);
  return async <T>(command: string, args: Record<string, unknown> = {}): Promise<T> => {
    const invokeResponse = await page.request.post(
      new URL("/__orkestrator/invoke", status.browserUrl!).href,
      { data: { command, args } },
    );
    expect(invokeResponse.ok(), `${command}: ${await invokeResponse.text()}`).toBe(true);
    return ((await invokeResponse.json()) as { result: T }).result;
  };
}

function sidebarNavigator(page: Page, projectName: string) {
  return async (name: string) => {
    const expand = page.getByRole("button", { name: `Expand project ${projectName}` });
    const entry = page.getByText(name, { exact: true }).first();
    await expect(expand.or(entry).first()).toBeVisible({ timeout: 30_000 });
    for (const label of ["Continue Without Docker", "Continue Without GitHub CLI"]) {
      const continueButton = page.getByRole("button", { name: label, exact: true });
      if (await continueButton.isVisible()) await continueButton.click();
    }
    if (await expand.isVisible()) await expand.click();
    // A sidebar tooltip from the previous hover can sit over the entry. Never
    // press Escape to clear it: with nothing focused, Escape stops the active
    // tab's running turn (useEscapeToStop).
    await page.mouse.move(0, 0);
    await entry.click();
  };
}

function layoutTabs(node: LayoutNode | undefined): LayoutTab[] {
  if (!node) return [];
  if (node.kind === "split") return node.children.flatMap(layoutTabs);
  return node.tabs;
}

/** Seven random digits: unique per run, and never part of the visible UI. */
const nonce = (tag: string) => `${tag}${Math.floor(1_000_000 + Math.random() * 9_000_000)}`;

function launchBrief(saveTo: string, marker: string) {
  return [
    "This is an automated qualification run of the design tools. Do exactly these steps with the orkestrator-design tools, and nothing else:",
    '1. Create one frame named "Card" (480 x 320) whose body holds',
    `   <h1 id="title">${marker}</h1><p id="tagline">Draft tagline</p>`,
    "   with any simple inline styling.",
    "2. Inspect the #title element with inspect_element.",
    '3. Refine: set the #tagline text to "Refined tagline" with replace_element_html.',
    "4. Capture the frame once with capture_frame.",
    `5. Save the canvas with save_canvas to ${saveTo}.`,
    "Do not read or change any repository file and do not run shell commands. Reply with one short sentence when done.",
  ].join("\n");
}

// A full cycle's trace outgrows the 16 MiB artifact sanitization bound, and
// global teardown then fails the run. Each step takes a screenshot instead.
test.use({ trace: "off" });

for (const provider of LIVE_OPT_IN ? selectedProviders() : (["claude"] as Provider[])) {
  const spec = PROVIDERS[provider];

  test.describe(`live design-tool cycle (${provider})`, () => {
    test.skip(
      !LIVE_OPT_IN,
      "opt-in live design turns against the isolated fixture; set ORKESTRATOR_AGENT_TEST_LIVE_DESIGN=1",
    );

    test(`${spec.label} creates, refines and saves a design; Ask agent, approval and handoff survive environment switches`, async ({
      page,
    }, testInfo) => withDesignLiveHeartbeat(provider, () => runCycle(page, testInfo)));

    async function runCycle(page: Page, testInfo: TestInfo) {
      test.setTimeout(TURN_TIMEOUT_MS * 3 + 300_000);
      page.setDefaultTimeout(15_000);
      await page.setViewportSize({ width: 1600, height: 1000 });
      // A dev profile's backend reports the Electron version, so stream
      // reconnects raise this reminder over the composer. Dismiss it.
      await page.addLocatorHandler(
        page.getByText("Reload to use the matching version."),
        async (reminder) => {
          await reminder.click();
        },
      );

      const status = profileStatus();
      expect(status.profile, "dev:status answered for a different profile").toBe(profile);
      expect(status.status, `profile "${profile}" is not running`).toBe("ready");
      expect(status.flavor).toBe("agent-test");
      const invoke = await authenticatedInvoke(page, status);
      const config = await invoke<{ global?: { enabledAgentPlatforms?: string[] } }>(
        "get_config",
      ).catch(() => null);
      const enabled = config?.global?.enabledAgentPlatforms;
      test.skip(
        Array.isArray(enabled) && !enabled.includes(provider),
        `${spec.label} is not enabled in profile "${profile}" (dev:test --agent-platforms)`,
      );
      const fixture = (await invoke<Project[]>("get_projects")).find(
        (project) => project.localPath === status.testProject,
      );
      expect(fixture, `the ${profile} fixture project is missing`).toBeTruthy();

      const environments: Environment[] = [];
      try {
        for (const name of [`design-${provider}`, `design-${provider}-other`]) {
          environments.push(
            await invoke<Environment>("create_environment", {
              projectId: fixture!.id,
              name: `${name}-${Date.now()}`,
              networkAccessMode: "restricted",
              environmentType: "local",
            }),
          );
        }
        const [target, other] = environments as [Environment, Environment];
        const model = selectedModel(provider);
        if (model) {
          // The design tab takes the environment's model for its platform.
          await invoke("update_environment_agent_settings", {
            environmentId: target.id,
            agentSettings: { platforms: { [provider]: { model } } },
          });
        }
        await invoke("start_environment", { environmentId: target.id });
        await invoke("start_environment", { environmentId: other.id });
        const worktree = (
          await invoke<Environment>("get_environment", { environmentId: target.id })
        ).worktreePath!;
        expect(worktree).toBeTruthy();

        const action = <T>(name: string, input: Record<string, unknown>) =>
          invoke<T>("design_action", { environmentId: target.id, action: name, input });
        const openEnvironment = sidebarNavigator(page, fixture!.name);
        const composeBar = page.getByTestId("shared-native-compose-bar");
        const input = composeBar.getByRole("textbox", { name: `Message ${spec.label}` });
        const stop = composeBar.getByTitle("Stop current query");

        const marker = nonce("DESIGNLIVE");
        const saveTo = `designs/live-${provider}-${marker.toLowerCase()}.orkdes`;
        const designName = `Live ${spec.label} design`;

        // -- 1. Launch, then leave while the first turn runs ---------------
        await page.goto(status.browserUrl!);
        await openEnvironment(target.name);
        await page.getByRole("button", { name: "New design workspace" }).click();
        await page.getByRole("textbox", { name: "Name", exact: true }).fill(designName);
        await page.getByRole("combobox", { name: "Design agent", exact: true }).click();
        await page.getByRole("option", { name: spec.label, exact: true }).click();
        await page.getByRole("combobox", { name: "Initial frame", exact: true }).click();
        await page.getByRole("option", { name: "No initial frame", exact: true }).click();
        await page.getByRole("textbox", { name: "Design brief" }).fill(launchBrief(saveTo, marker));
        await page.getByRole("button", { name: "Create design workspace", exact: true }).click();

        const layoutAgentTab = async () => {
          const layout = await invoke<{ root?: LayoutNode } | null>("get_pane_layout", {
            environmentId: target.id,
          });
          const tabs = layoutTabs(layout?.root);
          return {
            canvasId: tabs.find((tab) => tab.designCanvasData)?.designCanvasData?.canvasId,
            agentTabs: tabs
              .filter((tab) => tab.type === "agent-native")
              .map((tab) => ({ id: tab.id, platform: tab.nativeAgentData?.platform })),
          };
        };
        await expect
          .poll(async () => (await layoutAgentTab()).agentTabs.length, { timeout: 30_000 })
          .toBe(1);
        const launched = await layoutAgentTab();
        const canvasId = launched.canvasId!;
        const designTabId = launched.agentTabs[0]!.id;
        expect(canvasId).toBeTruthy();
        expect(launched.agentTabs[0]!.platform).toBe(provider);
        const sessionLinks = async () =>
          (
            await invoke<{ ok: boolean; value?: { workspace?: { sessions?: SessionLink[] } } }>(
              "design_snapshot",
              { environmentId: target.id, canvasId },
            )
          ).value?.workspace?.sessions ?? [];
        // Ask agent can only target the design conversation through this link.
        await expect
          .poll(async () => (await sessionLinks()).map((link) => `${link.role}:${link.tabId}`), {
            timeout: 30_000,
            message: "the launch never linked its agent conversation to the design",
          })
          .toEqual([`design:${designTabId}`]);

        const identity = (tabId: string) => ({
          environmentId: target.id,
          agent: provider,
          logicalSessionKey: `env-${target.id}:${tabId}`,
        });
        const projection = (tabId = designTabId) =>
          invoke<Projection>("get_native_agent_projection", identity(tabId));
        let lastState = "";
        const settled = async (tabId = designTabId) => {
          const current = await projection(tabId);
          const phase = current?.turn.phase;
          if (phase === "error") {
            // Roles, part kinds, tool names and states only, never content.
            const outline = (current?.messages ?? [])
              .map(
                (message) =>
                  `${String(message.role)}[${(Array.isArray(message.parts) ? message.parts : [])
                    .map((part: { type?: string; toolName?: string; toolState?: string }) =>
                      [part.type, part.toolName, part.toolState].filter(Boolean).join(":"),
                    )
                    .join(",")}]`,
              )
              .join(" ");
            throw new Error(`turn failed: ${current?.turn.error}; transcript: ${outline}`);
          }
          // Content-free progress, so a stalled turn shows what it waits on.
          const state = [
            `phase=${phase ?? "none"}`,
            `messages=${current?.messages?.length ?? 0}`,
            `interactions=${(current?.interactions ?? [])
              .map((item) => `${item.kind}:${item.state}`)
              .join("|")}`,
            `dispatch=${current?.recoverableDispatch ? "parked" : "none"}`,
          ].join(" ");
          if (state !== lastState) console.log(`[design-live] ${provider} ${state}`);
          lastState = state;
          return (
            phase === "idle" &&
            !current?.recoverableDispatch &&
            !(current?.interactions ?? []).some((item) => item.state === "pending") &&
            (current?.messages ?? []).some((message) => message.role === "assistant")
          );
        };
        const summary = () => action<Summary>("get_canvas_summary", { canvasId });
        const frameByName = async (name: string) => {
          const found = (await summary()).frames.find((frame) => frame.name === name);
          return found ? action<Frame>("get_frame", { canvasId, frameId: found.id }) : null;
        };
        const userMessages = async () =>
          ((await projection())?.messages ?? []).filter((message) => message.role === "user")
            .length;

        // The mounted tab sends its opening prompt. Leaving before the prompt is
        // accepted defers it until the tab mounts again (a follow-up in
        // docs/todo/design-canvas/0036-design-canvas-qualification.md), so leave once it is.
        await expect
          .poll(userMessages, {
            timeout: 90_000,
            message: "the design tab never sent its opening prompt",
          })
          .toBeGreaterThan(0);
        await openEnvironment(other.name);

        let card!: Frame;
        await test.step("the launch turn completes while the canvas is inactive", async () => {
          await expect
            .poll(() => settled(), {
              timeout: TURN_TIMEOUT_MS,
              message: "the launch turn never settled",
            })
            .toBe(true);
          // Tool names, failures and the export path only, never content.
          const launchUsage = summarizeDesignToolCalls((await projection())?.messages ?? []);
          const exported = await invoke<{
            value?: { workspace?: { export?: { relativePath: string } } };
          }>("design_snapshot", { environmentId: target.id, canvasId });
          const exportPath = exported.value?.workspace?.export?.relativePath;
          console.log(
            `[design-live] ${provider} launch: calls=${launchUsage.calls.join(",")} ` +
              `failed=${launchUsage.failed.join(",")} export=${exportPath ?? "none"}`,
          );
          for (const tool of ["inspect_element", "capture_frame"]) {
            expect(launchUsage.succeeded, `launch must complete ${tool}`).toContain(tool);
          }
          card = (await frameByName("Card"))!;
          expect(card, "the agent never created the Card frame").toBeTruthy();
          expect(card.html).toContain(marker);
          expect(card.html).toContain("Refined tagline");
          expect(
            existsSync(path.join(worktree, saveTo)),
            `${saveTo} was not saved (export association: ${exportPath ?? "none"})`,
          ).toBe(true);
          const saved = JSON.parse(readFileSync(path.join(worktree, saveTo), "utf8")) as {
            format: string;
            frames: Array<{ html: string }>;
          };
          expect(saved.format).toBe("orkdes");
          expect(saved.frames.some((frame) => frame.html.includes(marker))).toBe(true);
        });

        const embedded = page.frameLocator('iframe[title="Card"]');
        await test.step("reloading after launch restores the canvas, session link, transcript and idle controls", async () => {
          await page.reload({ waitUntil: "domcontentloaded" });
          await openEnvironment(target.name);
          expect((await layoutAgentTab()).canvasId).toBe(canvasId);
          expect((await layoutAgentTab()).agentTabs).toEqual(launched.agentTabs);
          expect(await sessionLinks()).toEqual([
            expect.objectContaining({ tabId: designTabId, platform: provider, role: "design" }),
          ]);
          await expect(embedded.locator("#title")).toHaveText(marker, { timeout: 30_000 });
          await expect(embedded.locator("#tagline")).toHaveText("Refined tagline");
          await expect(stop).toBeHidden();
          await expect(input).toBeVisible();
          await expect(page.getByText(marker, { exact: false }).first()).toBeVisible();
          // The provider-only guidance never reaches the transcript.
          await expect(
            page.getByText("Use the orkestrator-design MCP server", { exact: false }),
          ).toHaveCount(0);
          await page.screenshot({ path: testInfo.outputPath(`${provider}-1-launch.png`) });
        });

        await test.step("Ask agent with a stale selection: the agent re-reads, the edit is revision checked", async () => {
          const before = await userMessages();
          await page.getByRole("button", { name: "Move frame Card", exact: false }).click();
          await page.getByRole("button", { name: "Ask agent about the selection" }).click();
          const dialog = page.getByRole("dialog", { name: "Ask agent about this design" });
          await expect(dialog).toBeVisible();
          await expect(dialog.getByTestId("design-context-chip")).toContainText(
            `frame revision ${card.revision}`,
          );
          // Another client edits the frame while the context is open.
          const otherClient = nonce("OTHERCLIENT");
          await action("replace_element_html", {
            canvasId,
            frameId: card.id,
            expectedRevision: card.revision,
            selector: "#tagline",
            html: `<p id="tagline">${otherClient}</p>`,
          });
          await expect(dialog.getByRole("status")).toContainText("The design is now at revision");
          await dialog.getByRole("radio", { name: /^Send to / }).check();
          await dialog.getByRole("button", { name: "Add to composer", exact: true }).click();
          await expect(dialog).toBeHidden();
          await expect(
            composeBar.getByText("Design context", { exact: false }).first(),
          ).toBeVisible();

          const renamed = nonce("ASKAGENT");
          await expect(async () => {
            await input.click();
            await input.fill("");
            await page.keyboard.type(
              `Change only the text of #title to ${renamed}. Keep #tagline exactly as it is now. Reply in one sentence.`,
            );
            await expect(input).toContainText(renamed, { timeout: 2_000 });
          }).toPass({ timeout: 30_000 });
          await input.press("Enter");
          await expect.poll(userMessages, { timeout: 60_000 }).toBe(before + 1);
          await expect
            .poll(() => settled(), {
              timeout: TURN_TIMEOUT_MS,
              message: "the Ask turn never settled",
            })
            .toBe(true);
          card = (await frameByName("Card"))!;
          expect(card.html).toContain(renamed);
          expect(card.html, "the stale context overwrote the other client's edit").toContain(
            otherClient,
          );
          await expect(embedded.locator("#title")).toHaveText(renamed);
          await expect(embedded.locator("#tagline")).toHaveText(otherClient);
          // The agent read the design again after the stale context arrived.
          const turn = summarizeDesignToolCalls((await projection())?.messages ?? [], {
            afterUserMessage: before,
          });
          console.log(
            `[design-live] ${provider} ask: calls=${turn.calls.join(",")} failed=${turn.failed.join(",")}`,
          );
          expect(
            turn.calls.filter((call) => /get_canvas_summary|get_frame|get_canvas\b/.test(call)),
            `tools after Ask: ${turn.calls.join(", ")}`,
          ).not.toHaveLength(0);
          await page.screenshot({ path: testInfo.outputPath(`${provider}-2-ask-agent.png`) });
        });

        await test.step("a pending approval survives an environment switch and reload, then completes", async () => {
          const before = await userMessages();
          const approvalMarker = `.design-approval-${nonce("A")}`;
          const color = "rgb(200, 30, 60)";
          await composeBar.getByTestId("native-approval-mode-picker").click();
          await page.getByRole("menuitemradio", { name: spec.askMode, exact: true }).click();
          await expect(composeBar.getByTestId("native-approval-mode-picker")).toHaveAccessibleName(
            new RegExp(`${spec.askMode}$`),
          );
          await expect(async () => {
            await input.click();
            await input.fill("");
            await page.keyboard.type(
              // One line: typing Enter into the composer sends the message.
              `First use your shell tool to run exactly \`touch ${approvalMarker}\`. ` +
                `Then set the CSS color of #title to ${color} with set_element_styles. ` +
                "Do nothing else and do not retry the command if it is refused.",
            );
            await expect(input).toContainText(approvalMarker, { timeout: 2_000 });
          }).toPass({ timeout: 30_000 });
          await input.press("Enter");
          await expect.poll(userMessages, { timeout: 60_000 }).toBe(before + 1);
          const pending = async () =>
            ((await projection())?.interactions ?? []).filter(
              (item) => item.state === "pending" && TOOL_APPROVAL_KINDS.has(item.kind),
            );
          await expect
            .poll(async () => (await pending()).length, {
              timeout: TURN_TIMEOUT_MS,
              message: `${spec.label} never asked for approval`,
            })
            .toBeGreaterThan(0);
          const waiting = (await pending())[0]!;
          const revisionBefore = (await summary()).revision;

          await openEnvironment(other.name);
          await expect(input).toBeHidden();
          await page.waitForTimeout(15_000);
          expect((await pending()).map((item) => item.id)).toContain(waiting.id);
          expect(existsSync(path.join(worktree, approvalMarker))).toBe(false);

          await page.reload({ waitUntil: "domcontentloaded" });
          await openEnvironment(target.name);
          expect((await pending()).map((item) => item.id)).toContain(waiting.id);
          expect(existsSync(path.join(worktree, approvalMarker))).toBe(false);
          await expect(embedded.locator("#title")).toBeVisible();
          expect((await layoutAgentTab()).canvasId).toBe(canvasId);
          const approve = page.getByRole("button", {
            name: confirmLabel(waiting),
            exact: true,
          });
          await expect(approve.first()).toBeVisible({ timeout: 30_000 });
          // A turn waiting on an approval is blocked: the card is its control,
          // so the composer shows no Stop button.
          expect((await projection())?.turn.phase).toBe("blocked");
          await expect(stop).toBeHidden();
          expect((await summary()).revision).toBe(revisionBefore);
          await page.screenshot({ path: testInfo.outputPath(`${provider}-3-approval.png`) });
          // Approve this and any later tool request of the same turn.
          await expect
            .poll(
              async () => {
                const open = await pending();
                if (open.length > 0) {
                  const button: Locator = page.getByRole("button", {
                    name: confirmLabel(open[0]!),
                    exact: true,
                  });
                  if (await button.first().isVisible()) await button.first().click();
                  return false;
                }
                return settled();
              },
              {
                timeout: TURN_TIMEOUT_MS,
                intervals: [2_000],
                message: "the approval turn never settled",
              },
            )
            .toBe(true);
          expect(existsSync(path.join(worktree, approvalMarker))).toBe(true);
          const approvalTurn = summarizeDesignToolCalls((await projection())?.messages ?? [], {
            afterUserMessage: before,
          });
          console.log(
            `[design-live] ${provider} approval: calls=${approvalTurn.calls.join(",")} ` +
              `failed=${approvalTurn.failed.join(",")}`,
          );
          card = (await frameByName("Card"))!;
          expect(card.html.replaceAll(" ", "")).toContain(`color:${color.replaceAll(" ", "")}`);
        });

        await test.step("handoff prepares an unsent implementation draft that survives a switch and reload", async () => {
          await page.getByRole("button", { name: "Ask agent about the selection" }).click();
          const dialog = page.getByRole("dialog");
          // Scope and Agent are segmented buttons (aria-pressed), not radios.
          await dialog
            .getByRole("group", { name: "Scope" })
            .getByRole("button", { name: "Implement", exact: true })
            .click();
          await expect(
            dialog.getByRole("heading", { name: "Hand off design for implementation" }),
          ).toBeVisible();
          await dialog.getByRole("radio", { name: "New conversation" }).check();
          await dialog
            .getByRole("group", { name: "Agent" })
            .getByRole("button", { name: spec.label, exact: true })
            .click();
          await dialog
            .getByRole("button", { name: "Start a new conversation", exact: true })
            .click();
          await expect(dialog).toBeHidden();
          await expect
            .poll(async () => (await layoutAgentTab()).agentTabs.length, { timeout: 30_000 })
            .toBe(2);
          const handoffTab = (await layoutAgentTab()).agentTabs.find(
            (tab) => tab.id !== designTabId,
          )!;
          // A conversation nothing has been sent to yet shows the unassigned
          // composer, with the chosen provider preselected and Start agent.
          const handoffComposer = page.getByTestId("unassigned-native-compose-bar");
          const draftIsReady = async () => {
            await expect(
              handoffComposer.getByText(designName, { exact: false }).first(),
            ).toBeVisible({ timeout: 30_000 });
          };
          await draftIsReady();
          await page.screenshot({ path: testInfo.outputPath(`${provider}-4-handoff.png`) });
          await openEnvironment(other.name);
          await page.waitForTimeout(5_000);
          // The handoff tab was focused when the test left; the layout restores it.
          await openEnvironment(target.name);
          await draftIsReady();
          await page.reload({ waitUntil: "domcontentloaded" });
          await openEnvironment(target.name);
          await draftIsReady();
          expect((await layoutAgentTab()).agentTabs.map((tab) => tab.id).sort()).toEqual(
            [designTabId, handoffTab.id].sort(),
          );
          const handoff = await projection(handoffTab.id).catch(() => null);
          expect(
            (handoff?.messages ?? []).filter((message) => message.role === "user"),
            "the handoff was sent",
          ).toHaveLength(0);
          expect((await sessionLinks()).map((link) => `${link.role}:${link.tabId}`).sort()).toEqual(
            [`design:${designTabId}`, `implementation:${handoffTab.id}`],
          );
        });

        const usage = summarizeDesignToolCalls((await projection())?.messages ?? []);
        // Transcript reads carry summaries; fetch each call's output to size it.
        let responseBytes = usage.responseBytes;
        for (const detailRef of usage.detailRefs) {
          responseBytes += detailBytes(
            await invoke<{ toolOutput?: string; toolError?: string; fileDataUrl?: string }>(
              "get_native_agent_tool_details",
              { ...identity(designTabId), detailRef },
            ),
          );
        }
        const { detailRefs: _detailRefs, ...counted } = usage;
        await testInfo.attach("design-mcp-usage", {
          body: JSON.stringify({ provider, ...counted, responseBytes }, null, 2),
          contentType: "application/json",
        });
        console.log(
          `[design-live] ${provider}: ${usage.calls.length} design MCP calls ` +
            `(${JSON.stringify(usage.byTool)}), ${usage.failed.length} failed, ` +
            `${responseBytes} response bytes`,
        );
      } finally {
        for (const environment of environments) {
          await invoke("stop_environment", { environmentId: environment.id }).catch(
            () => undefined,
          );
          await invoke("delete_environment", { environmentId: environment.id }).catch(
            () => undefined,
          );
        }
      }
    }
  });
}
