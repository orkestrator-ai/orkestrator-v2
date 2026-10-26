/**
 * Two live clients press Resume on one closed design conversation at the same
 * moment, in the real app with a real Claude or Codex.
 *
 * Opt-in (`ORKESTRATOR_AGENT_TEST_LIVE_DESIGN_RESUME=1`) against a running
 * `dev:test --fixture` profile with host credentials. Each provider in
 * `ORKESTRATOR_AGENT_TEST_DESIGN_PROVIDERS` (default `claude`) gets one
 * disposable environment, on the model `ORKESTRATOR_AGENT_TEST_DESIGN_MODELS`
 * names for it, if any:
 *
 * 1. **Launch.** New design workspace with a one-line brief, so the design
 *    conversation exists and is linked to the canvas after one short turn.
 * 2. **Close.** The conversation's tab is closed, and the link must record the
 *    session a resume names.
 * 3. **Resume twice at once.** Two signed-in browser clients open Ask agent on
 *    the canvas and press **Resume conversation** together. Both must get the
 *    same resume tab and the same live provider session back from
 *    `design_session_resume`, the shared pane layout must hold exactly one
 *    `design-resume-…` tab, the link must name it, and the transcript must
 *    keep its user turns: nothing is sent.
 *
 * The deterministic halves (backend lane, two simulated clients) are in
 * `session-links.test.ts`, `commands-registry-design.test.ts` and
 * `design-session-links.test.ts`
 * (docs/todo/design-canvas/0038-design-agent-conversation-links.md).
 *
 * A provider is skipped, with its reason, when the profile has not enabled
 * it. Real turns cost tokens; this spec runs only when asked for. Nothing at
 * module scope spawns `mise`.
 */
import { expect, test, type Response } from "@playwright/test";
import { withDesignLiveHeartbeat } from "./design-live-heartbeat";
import {
  authenticatedInvoke,
  layoutTabs,
  profileStatus,
  selectedModel,
  sidebarNavigator,
  type Environment,
  type LayoutNode,
  type Project,
  type SessionLink,
} from "./design-live-support";

type Message = { role?: string; content?: unknown };
type Projection = { turn: { phase: string; error?: string }; messages?: Message[] } | null;
type ResumeAnswer = {
  ok: boolean;
  value?: { link: SessionLink; providerSessionId: string };
  failure?: { code?: string; message?: string };
};

const profile = process.env.ORKESTRATOR_AGENT_TEST_PROFILE ?? "codex-qa";
const LIVE_OPT_IN = process.env.ORKESTRATOR_AGENT_TEST_LIVE_DESIGN_RESUME === "1";
const TURN_TIMEOUT_MS = Number(
  process.env.ORKESTRATOR_AGENT_TEST_DESIGN_TURN_TIMEOUT_MS ?? "420000",
);
const LABELS = { claude: "Claude", codex: "Codex" } as const;
type Provider = keyof typeof LABELS;

function selectedProviders(): Provider[] {
  const raw = process.env.ORKESTRATOR_AGENT_TEST_DESIGN_PROVIDERS?.trim() || "claude";
  return raw.split(",").map((value) => {
    const provider = value.trim();
    if (!(provider in LABELS)) {
      throw new Error(
        `ORKESTRATOR_AGENT_TEST_DESIGN_PROVIDERS: unsupported provider "${provider}" ` +
          `(supported: ${Object.keys(LABELS).join(", ")})`,
      );
    }
    return provider as Provider;
  });
}

const userTurns = (current: Projection) =>
  (current?.messages ?? []).filter((message) => message.role === "user").length;

const isResume = (response: Response) =>
  response.url().endsWith("/__orkestrator/invoke") &&
  (response.request().postData() ?? "").includes('"design_session_resume"');

test.use({ trace: "off" });

for (const provider of LIVE_OPT_IN ? selectedProviders() : (["claude"] as Provider[])) {
  const label = LABELS[provider];

  test.describe(`live design Resume from two clients (${provider})`, () => {
    test.skip(
      !LIVE_OPT_IN,
      "opt-in live design turns against the isolated fixture; set ORKESTRATOR_AGENT_TEST_LIVE_DESIGN_RESUME=1",
    );

    test(`two clients resuming one closed ${label} design conversation converge on one tab and one session`, async ({
      page,
      browser,
    }, testInfo) =>
      withDesignLiveHeartbeat(provider, async () => {
        test.setTimeout(TURN_TIMEOUT_MS + 300_000);
        const status = profileStatus(profile);
        expect(status.profile, "dev:status answered for a different profile").toBe(profile);
        expect(status.status, `profile "${profile}" is not running`).toBe("ready");
        expect(status.flavor).toBe("agent-test");
        const second = await browser.newContext();
        try {
          const other = await second.newPage();
          const clients = [page, other];
          for (const client of clients) {
            client.setDefaultTimeout(15_000);
            await client.setViewportSize({ width: 1600, height: 1000 });
            await client.addLocatorHandler(
              client.getByText("Reload to use the matching version."),
              async (reminder) => {
                await reminder.click();
              },
            );
          }
          const invoke = await authenticatedInvoke(page, status, profile);
          await authenticatedInvoke(other, status, profile);
          const config = await invoke<{ global?: { enabledAgentPlatforms?: string[] } }>(
            "get_config",
          ).catch(() => null);
          const enabled = config?.global?.enabledAgentPlatforms;
          test.skip(
            Array.isArray(enabled) && !enabled.includes(provider),
            `${label} is not enabled in profile "${profile}" (dev:test --agent-platforms)`,
          );
          const fixture = (await invoke<Project[]>("get_projects")).find(
            (project) => project.localPath === status.testProject,
          );
          expect(fixture, `the ${profile} fixture project is missing`).toBeTruthy();

          let environment: Environment | undefined;
          try {
            environment = await invoke<Environment>("create_environment", {
              projectId: fixture!.id,
              name: `design-resume-${provider}-${Date.now()}`,
              networkAccessMode: "restricted",
              environmentType: "local",
            });
            const target = environment;
            const model = selectedModel(provider);
            if (model) {
              // The design tab takes the environment's model for its platform.
              await invoke("update_environment_agent_settings", {
                environmentId: target.id,
                agentSettings: { platforms: { [provider]: { model } } },
              });
            }
            await invoke("start_environment", { environmentId: target.id });

            const layout = async () =>
              layoutTabs(
                (
                  await invoke<{ root?: LayoutNode } | null>("get_pane_layout", {
                    environmentId: target.id,
                  })
                )?.root,
              );
            const agentTabs = async () =>
              (await layout()).filter((tab) => tab.type === "agent-native");

            // -- 1. Launch a design conversation with one short turn --------
            await page.goto(status.browserUrl!);
            await sidebarNavigator(page, fixture!.name)(target.name);
            await page.getByRole("button", { name: "New design workspace" }).click();
            await page
              .getByRole("textbox", { name: "Name", exact: true })
              .fill(`Resume ${label} design`);
            await page.getByRole("combobox", { name: "Design agent", exact: true }).click();
            await page.getByRole("option", { name: label, exact: true }).click();
            await page.getByRole("combobox", { name: "Initial frame", exact: true }).click();
            await page.getByRole("option", { name: "No initial frame", exact: true }).click();
            await page
              .getByRole("textbox", { name: "Design brief" })
              .fill(
                "This is an automated qualification run. Do not call any tools and do not change the canvas. Reply with the single word: ready.",
              );
            await page
              .getByRole("button", { name: "Create design workspace", exact: true })
              .click();
            await expect.poll(async () => (await agentTabs()).length, { timeout: 30_000 }).toBe(1);
            const designTabId = (await agentTabs())[0]!.id;
            const canvasId = (await layout()).find((tab) => tab.designCanvasData)?.designCanvasData
              ?.canvasId;
            expect(canvasId).toBeTruthy();
            const designLink = async () =>
              (
                await invoke<{ value?: { workspace?: { sessions?: SessionLink[] } } }>(
                  "design_snapshot",
                  { environmentId: target.id, canvasId },
                )
              ).value?.workspace?.sessions?.find((link) => link.role === "design");
            await expect
              .poll(async () => (await designLink())?.tabId ?? "", { timeout: 30_000 })
              .toBe(designTabId);
            const projection = (tabId: string) =>
              invoke<Projection>("get_native_agent_projection", {
                environmentId: target.id,
                agent: provider,
                logicalSessionKey: `env-${target.id}:${tabId}`,
              });
            await expect
              .poll(
                async () => {
                  const current = await projection(designTabId);
                  if (current?.turn.phase === "error")
                    throw new Error(`turn failed: ${current.turn.error}`);
                  return (
                    current?.turn.phase === "idle" &&
                    (current.messages ?? []).some((message) => message.role === "assistant")
                  );
                },
                { timeout: TURN_TIMEOUT_MS, message: "the launch turn never finished" },
              )
              .toBe(true);
            const turnsBefore = userTurns(await projection(designTabId));
            expect(turnsBefore).toBeGreaterThan(0);

            // Exercise a real bridge restart before tab teardown. Current
            // bridges can restore their live registrations from disk; either
            // way the subsequent close and resume must retain the conversation.
            if (provider === "codex") {
              const before = await invoke<{ pid: number | null }>("get_local_codex_server_status", {
                environmentId: target.id,
              });
              expect(before.pid).toBeGreaterThan(0);
              await invoke("stop_local_codex_server_cmd", { environmentId: target.id });
              const restarted = await invoke<{ pid: number }>("start_local_codex_server_cmd", {
                environmentId: target.id,
              });
              expect(restarted.pid).toBeGreaterThan(0);
              expect(restarted.pid).not.toBe(before.pid);
            }

            // -- 2. Close the conversation's tab ----------------------------
            await page
              .getByRole("button", { name: new RegExp(`^Close ${label} \\d+`) })
              .first()
              .click();
            await expect
              .poll(async () => (await designLink())?.sessionId ?? "", {
                timeout: 30_000,
                message: "closing the tab never recorded its session",
              })
              .not.toBe("");
            await expect
              .poll(async () => (await agentTabs()).length, {
                timeout: 30_000,
                message: "the closed conversation tab remained in the shared layout",
              })
              .toBe(0);

            // -- 3. Both clients open Ask agent and press Resume together ---
            const resumeButtons = [];
            for (const client of clients) {
              await client.goto(status.browserUrl!, { waitUntil: "domcontentloaded" });
              await sidebarNavigator(client, fixture!.name)(target.name);
              await client
                .getByRole("button", { name: /^Design \d+ Close Design \d+$/ })
                .first()
                .click({ timeout: 30_000 });
              await client
                .getByRole("button", { name: "Ask agent about the selection" })
                .click({ timeout: 30_000 });
              const resume = client
                .getByRole("dialog", { name: "Ask agent about this design" })
                .getByRole("button", { name: `Resume ${label} design conversation` });
              await expect(resume).toBeVisible({ timeout: 30_000 });
              resumeButtons.push(resume);
            }
            const answers = clients.map((client) =>
              client.waitForResponse(isResume, { timeout: 90_000 }),
            );
            await Promise.all(resumeButtons.map((button) => button.click()));
            const responses = await Promise.all(answers);
            const results = await Promise.all(
              responses.map(
                async (response) => ((await response.json()) as { result: ResumeAnswer }).result,
              ),
            );
            // Content-free timing, relative to the first request: the two
            // requests overlapped when the later one started before the first
            // one was answered.
            await Promise.all(responses.map((response) => response.finished()));
            const timings = responses.map((response) => response.request().timing());
            for (const timing of timings) {
              expect(timing.responseEnd, "the resume response did not finish").toBeGreaterThan(0);
            }
            expect(
              Math.max(...timings.map((timing) => timing.startTime)),
              "the resume requests were serialized; this run did not exercise concurrency",
            ).toBeLessThan(
              Math.min(...timings.map((timing) => timing.startTime + timing.responseEnd)),
            );
            const origin = Math.min(...timings.map((timing) => timing.startTime));
            timings.forEach((timing, index) =>
              console.log(
                `[design-resume] ${provider} client ${index + 1}: sent +${Math.round(
                  timing.startTime - origin,
                )} ms, answered +${Math.round(timing.startTime - origin + timing.responseEnd)} ms`,
              ),
            );
            for (const result of results) {
              expect(result.ok, `a client's resume failed: ${JSON.stringify(result.failure)}`).toBe(
                true,
              );
            }
            const [first, later] = results.map((result) => result.value!);
            expect(first!.link.tabId).toMatch(/^design-resume-/);
            expect(later!.link.tabId, "the clients resumed into different tabs").toBe(
              first!.link.tabId,
            );
            expect(later!.providerSessionId, "the clients resumed different live sessions").toBe(
              first!.providerSessionId,
            );
            for (const client of clients) {
              await expect(
                client.getByRole("dialog", { name: "Ask agent about this design" }),
              ).toBeHidden({ timeout: 60_000 });
            }

            const resumedTabId = first!.link.tabId;
            await expect
              .poll(async () => (await agentTabs()).map((tab) => tab.id), { timeout: 30_000 })
              .toEqual([resumedTabId]);
            expect((await designLink())?.tabId).toBe(resumedTabId);
            await expect
              .poll(async () => userTurns(await projection(resumedTabId)), {
                timeout: 60_000,
                message: "the resumed tab never showed the conversation",
              })
              .toBe(turnsBefore);
            // Give a stray dispatch time to appear before asserting there is none.
            await page.waitForTimeout(5_000);
            const resumed = await projection(resumedTabId);
            expect(userTurns(resumed), "resuming sent a prompt").toBe(turnsBefore);
            expect(resumed?.turn.phase).not.toBe("running");
            expect(await agentTabs()).toHaveLength(1);
            for (const [index, client] of clients.entries()) {
              await client.screenshot({
                path: testInfo.outputPath(`${provider}-client-${index + 1}-resumed.png`),
              });
            }
          } finally {
            if (environment) {
              await invoke("stop_environment", { environmentId: environment.id }).catch(
                () => undefined,
              );
              await invoke("delete_environment", { environmentId: environment.id }).catch(
                () => undefined,
              );
            }
          }
        } finally {
          await second.close();
        }
      }));
  });
}
