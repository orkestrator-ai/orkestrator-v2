/**
 * Shared steps of the Cursor and Pi cells of the Docker fixture: the fake
 * engine cells (`container-fake-engines.spec.ts`, to-do 0001 task 8) and
 * their opt-in real-provider variants (`container-real-engines-live.spec.ts`,
 * to-do 7040 (retired)). Each cell opens one native tab in the fixture
 * container, drives it from the composer and reads the session's projection
 * through the backend.
 */
import { expect, test, type Page } from "./browser-test";
import type { AgentInteractionRequest } from "@orkestrator/protocol/agent-interactions";
import { PANE_LAYOUT_VERSION } from "@orkestrator/protocol/pane-layout";
import { inContainer, invoke, type Environment } from "./container-wiring-support";
import { hasNewCompletedReply, type RetentionMessage } from "./close-retention-replies";
import { approvalOption } from "./paused-interactions-live-support";

export type Platform = "cursor" | "pi";
export type CellMessage = RetentionMessage & { parts?: unknown };
export type Projection = {
  sessionId?: string;
  turn: { phase: string; error?: string };
  messages: CellMessage[];
  interactions: AgentInteractionRequest[];
  policy?: Record<string, unknown>;
} | null;
export type PaneLayout = { revision?: number; [key: string]: unknown };

export const TURN_TIMEOUT_MS = 90_000;
/** Not on any default allowlist. */
export const BLOCKED_URL = "https://example.com/";
/** GitHub's published ranges are always allowed. */
export const ALLOWED_URL = "https://api.github.com/zen";

export const PLATFORMS: Record<
  Platform,
  { label: string; bridge: string; externals: string[]; fakeRoot: string }
> = {
  cursor: {
    label: "Cursor",
    bridge: "cursor-bridge",
    externals: ["@cursor/sdk"],
    fakeRoot: "/tmp/orkestrator-qa-fake-cursor",
  },
  pi: {
    label: "Pi",
    bridge: "pi-bridge",
    externals: [
      "@earendil-works/pi-coding-agent",
      "@earendil-works/pi-ai",
      "@earendil-works/pi-agent-core",
    ],
    fakeRoot: "/tmp/orkestrator-qa-fake-pi",
  },
};

export function entryDirectory(platform: Platform) {
  return `/opt/${PLATFORMS[platform].bridge}/dist`;
}

/**
 * Puts the image's own bridge entry back if a fake cell left its swap in
 * place, and removes the fake's state directory.
 */
export function restoreRealBridge(containerId: string, platform: Platform) {
  const dist = entryDirectory(platform);
  inContainer(
    containerId,
    `if [ -e ${dist}/index.js.qa-real ]; then mv -f ${dist}/index.js.qa-real ${dist}/index.js; fi; ` +
      `rm -rf ${PLATFORMS[platform].fakeRoot}`,
    { user: "root" },
  );
}

export async function enabledPlatforms(): Promise<string[] | undefined> {
  const config = await invoke<{ global?: { enabledAgentPlatforms?: string[] } }>(
    "get_config",
  ).catch(() => null);
  return config?.global?.enabledAgentPlatforms;
}

export async function requireCellPlatform(platform: Platform): Promise<void> {
  test.skip(process.env.ORKESTRATOR_AGENT_TEST_DOCKER !== "1", "Docker fixture profile required");
  const enabled = await enabledPlatforms();
  test.skip(
    Array.isArray(enabled) && !enabled.includes(platform),
    `${PLATFORMS[platform].label} is not enabled in this profile (dev:test --agent-platforms)`,
  );
}

/** One native tab on `platform`, optionally launched on `model`. */
export async function saveSingleTabLayout(
  environment: Environment,
  containerId: string,
  platform: Platform,
  tabId: string,
  model?: string,
) {
  const current = await invoke<PaneLayout | null>("get_pane_layout", {
    environmentId: environment.id,
  });
  await invoke("save_pane_layout", {
    environmentId: environment.id,
    expectedRevision: current?.revision ?? 0,
    layout: {
      version: PANE_LAYOUT_VERSION,
      containerId,
      activePaneId: "pane-fake-engine",
      root: {
        kind: "leaf",
        id: "pane-fake-engine",
        activeTabId: tabId,
        tabs: [
          {
            id: tabId,
            type: "agent-native",
            displayTitle: `${PLATFORMS[platform].label} container cell`,
            nativeAgentData: { environmentId: environment.id, platform },
            ...(model ? { initialAgentModel: model } : {}),
          },
        ],
      },
    },
  });
}

export async function restoreLayout(
  environment: Environment,
  containerId: string,
  previous: PaneLayout | null,
) {
  const current = await invoke<PaneLayout | null>("get_pane_layout", {
    environmentId: environment.id,
  });
  const { revision: _revision, ...layout } = previous ?? {
    version: PANE_LAYOUT_VERSION,
    containerId,
    activePaneId: "pane-main",
    root: { kind: "leaf", id: "pane-main", tabs: [], activeTabId: null },
  };
  await invoke("save_pane_layout", {
    environmentId: environment.id,
    expectedRevision: current?.revision ?? 0,
    layout,
  });
}

export function tabSession(environment: Environment, platform: Platform, tabId: string) {
  const label = PLATFORMS[platform].label;
  const identity = {
    environmentId: environment.id,
    agent: platform,
    logicalSessionKey: `env-${environment.id}:${tabId}`,
  };
  const projection = () => invoke<Projection>("get_native_agent_projection", identity);
  /** A projection's tool card carries `detailRef`; its output is read here. */
  const toolDetails = (detailRef: string) =>
    invoke<{ toolOutput?: string; toolError?: string } | null>("get_native_agent_tool_details", {
      ...identity,
      detailRef,
    });
  return { label, projection, toolDetails };
}

/** The composer of the only native tab on screen, as a user reaches it. */
export async function sendPrompt(
  page: Page,
  label: string,
  projection: () => Promise<Projection>,
  prompt: string,
) {
  const composeBar = page.getByTestId("shared-native-compose-bar");
  const composer = composeBar.getByRole("textbox", { name: new RegExp(`^Message ${label}`) });
  const sendButton = composeBar.getByRole("button", { name: "Send", exact: true });
  await expect(composer).toBeVisible({ timeout: 90_000 });
  await composer.fill(prompt);
  await expect(sendButton).toBeEnabled({ timeout: 90_000 });
  const before = await projection();
  const previous = new Set((before?.messages ?? []).map((message) => message.id));
  const reached = async () =>
    ((await projection())?.messages ?? []).some(
      (message) =>
        message.role === "user" && !previous.has(message.id) && String(message.content) === prompt,
    );
  // Enter rather than a click: a development toast can cover the button.
  await composer.press("Enter");
  const sent = async () => (await composer.textContent())?.trim() === "" || (await reached());
  await expect
    .poll(sent, { timeout: 30_000 })
    .toBe(true)
    .catch(async (error: unknown) => {
      // The composer kept the draft and the session holds no such message, so
      // first send was refused. Keep diagnostics, but fail this qualification
      // rather than allowing a retry to conceal a dispatch regression.
      const shown = await page
        .getByRole("alert")
        .allTextContents()
        .catch(() => [] as string[]);
      const current = await projection();
      test.info().annotations.push({
        type: "send-refused",
        description: JSON.stringify({
          label,
          shown: shown.map((text) => text.trim()).filter(Boolean),
          phase: current?.turn.phase,
          error: current?.turn.error,
        }),
      });
      throw error;
    });
  return previous;
}

/** Waits for a new, completed assistant reply that `matches`; returns its text. */
export async function waitForReply(
  label: string,
  projection: () => Promise<Projection>,
  previous: ReadonlySet<string>,
  matches: (reply: string) => boolean,
  timeout = TURN_TIMEOUT_MS,
): Promise<string> {
  let reply = "";
  await expect
    .poll(
      async () => {
        const current = await projection();
        if (current?.turn.phase === "error") {
          throw new Error(`${label} turn failed: ${current.turn.error ?? "no error"}`);
        }
        if (!hasNewCompletedReply(current, previous, matches)) return false;
        reply = String(
          current!.messages.findLast(
            (message) => message.role === "assistant" && !previous.has(message.id),
          )?.content ?? "",
        );
        return true;
      },
      { timeout, message: `${label} never answered` },
    )
    .toBe(true);
  return reply;
}

export async function ask(
  page: Page,
  label: string,
  projection: () => Promise<Projection>,
  prompt: string,
  matches: (reply: string) => boolean,
) {
  const previous = await sendPrompt(page, label, projection, prompt);
  return waitForReply(label, projection, previous, matches);
}

export function expectContainerPolicy(
  policy: Record<string, unknown> | undefined,
  approvals: string,
) {
  expect(policy, "the session reports its execution policy").toMatchObject({
    id: "interactive-container",
    sandbox: "container",
    approvals,
    networkAccess: "restricted",
  });
}

/** One `curl` whose output carries its HTTP status and exit code. */
export function curlCommand(url: string): string {
  return `curl -sS -m 10 -o /dev/null -w 'http=%{http_code}' ${url}; echo " exit=$?"`;
}

/** Answers a pending approval card with its allow option, as a user does. */
export async function approveFromCard(page: Page, pending: AgentInteractionRequest) {
  const allow = approvalOption(pending.presentation.questions[0]);
  if (allow) {
    await page
      .getByRole("button", { name: new RegExp(`^${escapeRegExp(allow.label)}`) })
      .first()
      .click();
  }
  await page
    .getByRole("button", {
      name: pending.presentation.confirmLabel ?? "Continue",
      exact: true,
    })
    .click();
}

/** Polls until the session holds a pending interaction; returns it. */
export async function waitForPendingInteraction(
  projection: () => Promise<Projection>,
  message: string,
  timeout = TURN_TIMEOUT_MS,
): Promise<AgentInteractionRequest> {
  let pending: AgentInteractionRequest | undefined;
  await expect
    .poll(
      async () => {
        const current = await projection();
        if (current?.turn.phase === "error") {
          throw new Error(`turn failed: ${current.turn.error ?? "no error"}`);
        }
        pending = current?.interactions.find((request) => request.state === "pending");
        return pending?.kind;
      },
      { timeout, message },
    )
    .toBeTruthy();
  return pending!;
}

export function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
