/**
 * Closing a native agent tab keeps the conversation: live, in the real app.
 *
 * Opt-in (`ORKESTRATOR_AGENT_TEST_LIVE_CLOSE_RETENTION=1`) against a running
 * agent-test profile with host credentials. For each platform in
 * `ORKESTRATOR_AGENT_TEST_CLOSE_RETENTION_PLATFORMS` (default
 * `cursor,pi,opencode,grok`):
 *
 * 1. A launched agent tab on that platform is asked to remember a codeword.
 * 2. The tab is closed with its close button, and a reload must not bring it
 *    back.
 * 3. A new agent tab from the toolbar opens the resume list, where the
 *    conversation is found and resumed. The transcript must show the first
 *    turn once.
 * 4. The next prompt asks for the codeword. Only a model that still holds the
 *    first turn's context can answer, so the reply proves the same native
 *    conversation continued. The backend transcript must then hold the first
 *    prompt exactly once.
 *
 * The deterministic version of this flow, for every platform and without
 * credentials, is `e2e/CloseRetention.spec.ts`. This one proves the vendor
 * side: that a real provider keeps the closed conversation and resumes it.
 *
 * A platform is skipped, with its reason, when the profile has not enabled it
 * or its login is missing. Anything else fails. Real turns cost tokens; this
 * spec runs only when asked for.
 */
import { expect, test, type Page } from "@playwright/test";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { PANE_LAYOUT_VERSION } from "@orkestrator/protocol/pane-layout";
import { hasNewCompletedReply, type RetentionMessage } from "./close-retention-replies";
import { dismissSidebarTooltip } from "./sidebar-tooltip";

type Status = {
  status: string;
  profile?: string;
  browserUrl?: string;
  testProject?: string;
};
type Project = { id: string; name: string; localPath: string | null };
type Environment = { id: string; name: string };
type Message = RetentionMessage;
type Projection = {
  sessionId?: string;
  turn: { phase: string; error?: string };
  messages: Message[];
};
type Platform = "cursor" | "pi" | "opencode" | "grok";
type LayoutNode =
  | { kind: "leaf"; tabs: Array<{ id: string; nativeAgentData?: { platform?: string } }> }
  | { kind: "split"; children: LayoutNode[] };

const repositoryRoot = path.resolve(import.meta.dirname, "../..");
const profile = process.env.ORKESTRATOR_AGENT_TEST_PROFILE ?? "codex-qa";
const LIVE_OPT_IN = process.env.ORKESTRATOR_AGENT_TEST_LIVE_CLOSE_RETENTION === "1";
const LABELS: Record<Platform, string> = {
  cursor: "Cursor",
  pi: "Pi",
  opencode: "OpenCode",
  grok: "Grok",
};
const PLATFORMS = (process.env.ORKESTRATOR_AGENT_TEST_CLOSE_RETENTION_PLATFORMS ?? "")
  .split(",")
  .map((entry) => entry.trim())
  .filter(Boolean);
const SELECTED = (PLATFORMS.length > 0 ? PLATFORMS : Object.keys(LABELS)) as Platform[];
/**
 * An optional launch model per platform, `<platform>=<model>` comma-separated
 * in `ORKESTRATOR_AGENT_TEST_CLOSE_RETENTION_MODELS`. OpenCode needs one when
 * its configured default belongs to a provider the login has not connected.
 */
const MODELS = new Map(
  (process.env.ORKESTRATOR_AGENT_TEST_CLOSE_RETENTION_MODELS ?? "")
    .split(",")
    .map((entry) => entry.trim().split("="))
    .filter((pair): pair is [string, string] => pair.length === 2 && Boolean(pair[1])),
);
const TURN_TIMEOUT_MS = Number(
  process.env.ORKESTRATOR_AGENT_TEST_CLOSE_RETENTION_TURN_TIMEOUT_MS ?? "300000",
);

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

async function signIn(page: Page, status: Status) {
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
    await expect(expand.or(entry)).toBeVisible({ timeout: 30_000 });
    for (const label of ["Continue Without Docker", "Continue Without GitHub CLI"]) {
      const continueButton = page.getByRole("button", { name: label, exact: true });
      if (await continueButton.isVisible()) await continueButton.click();
    }
    if (await expand.isVisible()) await expand.click();
    // A sidebar tooltip from the previous hover can sit over the entry.
    await dismissSidebarTooltip(page, projectName);
    await entry.click();
  };
}

function agentTabs(node: LayoutNode | undefined): Array<{ id: string; platform?: string }> {
  if (!node) return [];
  if (node.kind === "split") return node.children.flatMap(agentTabs);
  return node.tabs.map((tab) => ({ id: tab.id, platform: tab.nativeAgentData?.platform }));
}

function textOf(message: Message): string {
  return typeof message.content === "string" ? message.content : "";
}

/** True when an auth status or provider error means "not signed in", not a failure. */
function signedOut(value: unknown): boolean {
  return /sign(ed)? ?(in|out)|not authenticated|needs? auth|login|expired|credential/i.test(
    typeof value === "string" ? value : JSON.stringify(value ?? ""),
  );
}

test.describe("live close retention", () => {
  test.skip(
    !LIVE_OPT_IN,
    "opt-in live turns against the isolated fixture; set ORKESTRATOR_AGENT_TEST_LIVE_CLOSE_RETENTION=1",
  );

  for (const platform of SELECTED) {
    const label = LABELS[platform];
    test(`closing a ${label} tab keeps the live conversation; resume continues it`, async ({
      page,
    }, testInfo) => {
      test.setTimeout(TURN_TIMEOUT_MS * 2 + 180_000);
      testInfo.annotations.push({ type: "profile", description: profile });
      await page.setViewportSize({ width: 1440, height: 1200 });
      const status = profileStatus();
      expect(status.profile, "dev:status answered for a different profile").toBe(profile);
      expect(status.status, `profile "${profile}" is not running`).toBe("ready");
      const invoke = await signIn(page, status);
      const config = await invoke<{ global?: { enabledAgentPlatforms?: string[] } }>(
        "get_config",
      ).catch(() => null);
      const enabled = config?.global?.enabledAgentPlatforms;
      test.skip(
        Array.isArray(enabled) && !enabled.includes(platform),
        `${label} is not enabled in profile "${profile}" (dev:test --agent-platforms)`,
      );
      const fixture = (await invoke<Project[]>("get_projects")).find(
        (project) => project.localPath === status.testProject,
      );
      expect(fixture, `the ${profile} fixture project is missing`).toBeTruthy();

      const environment = await invoke<Environment>("create_environment", {
        projectId: fixture!.id,
        name: `close-live-${platform}-${Date.now()}`,
        networkAccessMode: "restricted",
        environmentType: "local",
      });
      try {
        await invoke("start_environment", { environmentId: environment.id });
        // A launched tab on this platform, as the launcher leaves one.
        const firstTab = `close-live-${platform}`;
        const layout = await invoke<{ revision?: number } | null>("get_pane_layout", {
          environmentId: environment.id,
        });
        const model = MODELS.get(platform);
        await invoke("save_pane_layout", {
          environmentId: environment.id,
          expectedRevision: layout?.revision ?? 0,
          layout: {
            version: PANE_LAYOUT_VERSION,
            containerId: null,
            activePaneId: "pane-close-live",
            root: {
              kind: "leaf",
              id: "pane-close-live",
              activeTabId: firstTab,
              tabs: [
                {
                  id: firstTab,
                  type: "agent-native",
                  displayTitle: `${label} close retention`,
                  nativeAgentData: { environmentId: environment.id, platform, isLocal: true },
                  ...(model ? { initialAgentModel: model } : {}),
                },
              ],
            },
          },
        });

        const projection = (tabId: string) =>
          invoke<Projection | null>("get_native_agent_projection", {
            environmentId: environment.id,
            agent: platform,
            logicalSessionKey: `env-${environment.id}:${tabId}`,
          });
        /** Backend truth: the turn settled and an assistant reply matched. */
        const waitForReply = async (
          tabId: string,
          previousMessageIds: ReadonlySet<string>,
          matches: (reply: string) => boolean,
        ) => {
          await expect
            .poll(
              async () => {
                const current = await projection(tabId);
                if (current?.turn.phase === "error") {
                  if (signedOut(current.turn.error)) {
                    testInfo.skip(true, `${label} is not signed in: ${current.turn.error}`);
                  }
                  throw new Error(`${label} turn failed: ${current.turn.error ?? "no error"}`);
                }
                return hasNewCompletedReply(current, previousMessageIds, matches);
              },
              { timeout: TURN_TIMEOUT_MS, message: `${label} never answered` },
            )
            .toBe(true);
        };

        const openEnvironment = sidebarNavigator(page, fixture!.name);
        await page.goto(status.browserUrl!);
        await openEnvironment(environment.name);
        const composeBar = page.getByTestId("shared-native-compose-bar");
        const composer = composeBar.getByRole("textbox", { name: new RegExp(`^Message ${label}`) });
        // Sending waits for the session to be ready: Enter before then is
        // ignored, so wait for the enabled send button as a user would.
        const sendButton = composeBar.getByRole("button", { name: "Send", exact: true });
        const send = async (tabId: string, prompt: string) => {
          await expect(composer).toBeVisible({ timeout: 90_000 });
          await composer.fill(prompt);
          // A composer whose provider has no login offers sign-in instead of send.
          const signInFirst = composeBar.getByRole("button", {
            name: /^Sign in to .* before sending/,
          });
          await expect(sendButton.or(signInFirst).first()).toBeVisible({ timeout: 90_000 });
          if (await signInFirst.isVisible()) {
            testInfo.skip(true, `${label} is not signed in in profile "${profile}"`);
          }
          await expect(sendButton).toBeEnabled({ timeout: 90_000 });
          const before = await projection(tabId);
          expect(before, "capture the transcript before sending").toBeTruthy();
          const previousMessageIds = new Set(before!.messages.map((message) => message.id));
          // Enter rather than a click: a development "page is out of date"
          // toast can sit over the send button in a long-lived profile.
          await composer.press("Enter");
          await expect(composer).toHaveText("", { timeout: 30_000 });
          return previousMessageIds;
        };

        const codeword = `ORK${Math.floor(100_000 + Math.random() * 900_000)}`;
        const first = `Remember this codeword for later: ${codeword}. Reply with only the word OK. Do not use any tools.`;
        const beforeFirst = await send(firstTab, first);
        await waitForReply(firstTab, beforeFirst, (reply) => /\bok\b/i.test(reply));
        const firstSessionId = (await projection(firstTab))?.sessionId;
        expect(firstSessionId, "the original provider session has an identity").toBeTruthy();

        await page.getByRole("button", { name: new RegExp(`^Close ${label}\\b`) }).click();
        await expect(composer).toHaveCount(0);
        await page.reload();
        await openEnvironment(environment.name);
        await expect(
          page.getByRole("button", { name: new RegExp(`^Close ${label}\\b`) }),
        ).toHaveCount(0);

        await page.getByRole("button", { name: "New native agent tab" }).click();
        await page.getByRole("button", { name: "Resume Session" }).click();
        await page
          .getByRole("dialog", { name: "Resume a session" })
          .getByRole("button", { name: new RegExp(`^${label}\\b.*Choose a previous session`) })
          .click();
        const picker = page.getByRole("dialog", { name: "Resume Session" });
        // The environment is a fresh worktree and every provider scopes its
        // list to the workspace, so the newest row is the conversation just
        // closed. Its title is the provider's own (often generated), so the
        // row is not matched by prompt text; the transcript check below is
        // what proves it was the right one.
        const rows = picker.getByRole("button").filter({ hasNot: page.getByText("Close") });
        await expect(rows.first()).toBeVisible({ timeout: 60_000 });
        testInfo.annotations.push({
          type: "resume rows",
          description: JSON.stringify(
            (await rows.allInnerTexts()).map((text) => text.replace(/\s+/g, " ").slice(0, 80)),
          ),
        });
        await rows.first().click();
        await expect(picker).toHaveCount(0);
        await expect(page.getByText(first, { exact: true })).toHaveCount(1, { timeout: 60_000 });

        const pane = await invoke<{ root: LayoutNode }>("get_pane_layout", {
          environmentId: environment.id,
        });
        const resumedTab = agentTabs(pane.root).find((tab) => tab.platform === platform);
        expect(resumedTab, "the resumed tab is in the saved layout").toBeTruthy();
        // OpenCode resumes the same session id. Cursor, Pi and Grok resume the
        // same vendor conversation into a new bridge session, so for them the
        // codeword below is what proves the conversation is the original one.
        const sameSessionId = platform === "opencode";
        const resumedSessionId = (await projection(resumedTab!.id))?.sessionId;
        if (sameSessionId) expect(resumedSessionId).toBe(firstSessionId);
        else expect(resumedSessionId).not.toBe(firstSessionId);

        const second =
          "What codeword did I ask you to remember? Reply with only the codeword. Do not use any tools.";
        const beforeSecond = await send(resumedTab!.id, second);
        await waitForReply(resumedTab!.id, beforeSecond, (reply) => reply.includes(codeword));
        const resumed = await projection(resumedTab!.id);
        expect(resumed?.sessionId).toBe(resumedSessionId);
        const userPrompts = resumed!.messages
          .filter((message) => message.role === "user")
          .map(textOf);
        // The first turn once, then the second: nothing duplicated or lost.
        expect(userPrompts.filter((prompt) => prompt.includes(codeword))).toHaveLength(1);
        expect(userPrompts.at(-1)).toBe(second);
        await expect(page.getByText(second, { exact: true })).toHaveCount(1);
      } finally {
        await invoke("stop_environment", { environmentId: environment.id }).catch(() => undefined);
        await invoke("delete_environment", { environmentId: environment.id }).catch(
          () => undefined,
        );
      }
    });
  }
});
