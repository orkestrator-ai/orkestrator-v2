/**
 * Composer command behaviour on the shared native tab.
 *
 * Kept apart from the main tab suite (already far past the file-size
 * guideline): picking a command records its identity in the draft, a command
 * is sent as raw text with an explicit intent, and every refusal keeps the
 * draft. The backend remains authoritative; these tests pin what the composer
 * sends and when it declines to send at all.
 */
import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type {
  NativeAgentCommandCatalogueState,
  NativeAgentDispatchOutcome,
  NativeAgentSessionProjection,
  NativeAgentSlashCommand,
  NativeAgentTabData,
} from "@orkestrator/protocol/native-agent";
import type { AgentPlatform } from "@orkestrator/protocol/agent-platforms";
import type { NativeMessage } from "@/lib/chat/native-message-types";
import * as realBackend from "@/lib/backend";
import * as realPaneLayoutPersistence from "@/lib/pane-layout-persistence";
import * as realNativeComposeBarPaste from "@/hooks/useNativeComposeBarPaste";
import { useEnvironmentStore } from "@/stores/environmentStore";
import { usePaneLayoutStore } from "@/stores/paneLayoutStore";
import {
  useNativeComposeStore,
  type NativeCommandSelection,
  type NativeComposeDraft,
} from "@/stores/nativeComposeStore";
import { useNativeAgentProjectionStore } from "@/stores/nativeAgentProjectionStore";
import { createSessionKey } from "@/lib/utils";

const realBackendSnapshot = { ...realBackend };
const realPaneLayoutPersistenceSnapshot = { ...realPaneLayoutPersistence };
const realNativeComposeBarPasteSnapshot = { ...realNativeComposeBarPaste };

const REVIEW: NativeAgentSlashCommand = {
  name: "/review",
  id: "codex:/review",
  source: "project",
  description: "Review the diff",
  argumentHint: "<path>",
  executionKind: "bridge-template",
  bindingRevision: "rev-1",
  inputPolicy: { arguments: "optional", attachments: "images", busy: "queue" },
};
const SKILL: NativeAgentSlashCommand = {
  name: "$deploy",
  insertText: "$deploy",
  aliases: ["/skills:deploy"],
  id: "codex:skill:deploy",
  source: "skill",
  executionKind: "structured-skill",
  bindingRevision: "skill-1",
};
const LOGIN: NativeAgentSlashCommand = {
  name: "/login",
  id: "codex:/login",
  source: "builtin",
  executionKind: "provider-command",
  availability: {
    state: "unavailable",
    reason: "requires-interactive-ui",
    message: "Sign in from Settings instead.",
  },
};
const COMPACT: NativeAgentSlashCommand = {
  name: "/compact",
  id: "orkestrator:compact",
  source: "orkestrator",
  executionKind: "session-action",
  bindingRevision: "orkestrator:compact",
  inputPolicy: { arguments: "none", attachments: "none", busy: "idle" },
};
const READY: NativeAgentCommandCatalogueState = { status: "ready", revision: 2, enhanced: true };

interface ProjectionOptions {
  commands?: NativeAgentSlashCommand[];
  catalogue?: NativeAgentCommandCatalogueState | null;
  phase?: NativeAgentSessionProjection["turn"]["phase"];
  sessionId?: string;
}
let projectionOptions: ProjectionOptions = {};

function projectionFor(agent: AgentPlatform): NativeAgentSessionProjection<NativeMessage> {
  const catalogue = projectionOptions.catalogue === undefined ? READY : projectionOptions.catalogue;
  const commands = projectionOptions.commands ?? [REVIEW, SKILL, LOGIN, COMPACT];
  return {
    platform: agent,
    environmentId: "env-1",
    sessionId: projectionOptions.sessionId ?? `${agent}-session`,
    connection: "connected",
    turn: { phase: projectionOptions.phase ?? "idle" },
    messages: [],
    interactions: [],
    composerControls: [],
    composer: {
      models: [{ platform: agent, id: "model-a", label: "Model A" }],
      selectedModelId: "model-a",
      fastModeEnabled: false,
      fastModeAvailable: false,
      selectedModeId: "build",
      modes: [{ id: "build", label: "Build" }],
    },
    capabilities: {
      attachments: { files: true, images: true },
      queue: true,
      resume: false,
      fork: false,
      slashCommands: true,
      backgroundTasks: false,
      composer: { provider: true, model: true, reasoning: true, speed: true, mode: true },
      actions: { compact: true },
    },
    ...(commands.length > 0 ? { slashCommands: commands } : {}),
    ...(catalogue ? { slashCommandCatalogue: catalogue } : {}),
    revision: 1,
    generation: "generation-1",
  } as NativeAgentSessionProjection<NativeMessage>;
}

const getNativeAgentProjectionMock = mock(async (input: { agent: AgentPlatform }) =>
  projectionFor(input.agent),
);
const dispatchNativeAgentIntentMock = mock(
  async (
    input: Parameters<typeof realBackend.dispatchNativeAgentIntent>[0],
  ): Promise<NativeAgentDispatchOutcome> => ({
    outcome: "accepted" as const,
    requestId: input.requestId,
  }),
);
const enqueuePromptQueueMessageMock = mock(
  async (_queueKey: string, _environmentId: string, _message: unknown) => ({}),
);
const performNativeAgentSessionActionMock = mock(
  async (_input: { agent: string; action: { kind: string } }) => ({ outcome: "applied" as const }),
);
const refreshNativeAgentCommandsMock = mock(async (input: { agent: AgentPlatform }) => ({
  outcome: "reread" as const,
  projection: projectionFor(input.agent),
}));

mock.module("@/hooks/useNativeComposeBarPaste", () => ({
  useNativeComposeBarPaste: () => {},
}));
mock.module("@/lib/backend", () => ({
  ...realBackendSnapshot,
  getNativeAgentModelCatalog: async () => [],
  awaitBridgeReady: async () => ({ status: "ready" as const, port: 4099, authToken: "token" }),
  adoptNativeAgentSession: async (input: {
    agent: string;
    providerSessionId: string;
    logicalSessionKey: string;
    environmentId: string;
  }) => ({ ...input }),
  ensureNativeAgentSession: async (input: {
    agent: string;
    logicalSessionKey: string;
    environmentId: string;
  }) => ({ ...input, providerSessionId: `${input.agent}-session` }),
  listNativeAgentResumableSessions: async () => [],
  getAgentHandoff: async () => null,
  deleteAgentHandoff: async () => true,
  dispatchNativeAgentIntent: dispatchNativeAgentIntentMock,
  renameEnvironmentFromPrompt: async () => {},
  getFileTree: async () => [],
  getLocalFileTree: async () => [],
  getNativeAgentSyncCapabilities: async () => ({ projectionSyncVersions: [] }),
  getNativeAgentProjection: getNativeAgentProjectionMock,
  getComposeDraft: async () => null,
  saveComposeDraft: async (
    draftKey: string,
    ownerType: string,
    ownerId: string,
    value: unknown,
  ) => ({ draftKey, ownerType, ownerId, value, updatedAt: "", revision: 1 }),
  deleteComposeDraft: async () => {},
  performNativeAgentSessionAction: performNativeAgentSessionActionMock,
  enqueuePromptQueueMessage: enqueuePromptQueueMessageMock,
  refreshNativeAgentCommands: refreshNativeAgentCommandsMock,
}));
mock.module("@/lib/pane-layout-persistence", () => ({
  ...realPaneLayoutPersistenceSnapshot,
  flushPaneLayoutNow: async () => {},
}));

const { AgentNativeTab } = await import("./AgentNativeTab");

afterAll(() => {
  mock.module("@/lib/backend", () => realBackendSnapshot);
  mock.module("@/lib/pane-layout-persistence", () => realPaneLayoutPersistenceSnapshot);
  mock.module("@/hooks/useNativeComposeBarPaste", () => realNativeComposeBarPasteSnapshot);
});

function identity(platform: NativeAgentTabData["platform"]): NativeAgentTabData {
  return {
    platform,
    environmentId: "env-1",
    containerId: "container-1",
    sessionId: `${platform}-session`,
    isLocal: false,
  };
}

function draftFor(tabId: string) {
  return useNativeComposeStore.getState().drafts.get(createSessionKey("env-1", tabId));
}

function seedDraft(tabId: string, update: Partial<NativeComposeDraft>) {
  useNativeComposeStore.getState().updateDraft(createSessionKey("env-1", tabId), update);
}

async function renderTab(tabId: string, platform: AgentPlatform = "codex") {
  const view = render(<AgentNativeTab tabId={tabId} data={identity(platform)} isActive />);
  const input = await screen.findByRole("textbox");
  // Wait for the projection so sending is authorised.
  await waitFor(() => expect(getNativeAgentProjectionMock).toHaveBeenCalled());
  await act(async () => {
    await Promise.resolve();
  });
  return { ...view, input };
}

async function type(input: HTMLElement, tabId: string, text: string) {
  fireEvent.input(input, { target: { textContent: text } });
  await waitFor(() => expect(draftFor(tabId)?.text).toBe(text));
}

const selection = (overrides: Partial<NativeCommandSelection> = {}): NativeCommandSelection => ({
  commandId: "codex:/review",
  bindingRevision: "rev-1",
  token: "/review",
  platform: "codex",
  sessionId: "codex-session",
  ...overrides,
});

beforeEach(() => {
  projectionOptions = {};
  useEnvironmentStore.setState({
    environments: [
      {
        id: "env-1",
        projectId: "project-1",
        name: "Native agent test",
        order: 0,
        setupPhase: "ready",
      } as never,
    ],
  });
});

afterEach(() => {
  cleanup();
  getNativeAgentProjectionMock.mockClear();
  dispatchNativeAgentIntentMock.mockClear();
  enqueuePromptQueueMessageMock.mockClear();
  performNativeAgentSessionActionMock.mockClear();
  performNativeAgentSessionActionMock.mockImplementation(async () => ({
    outcome: "applied" as const,
  }));
  refreshNativeAgentCommandsMock.mockClear();
  useEnvironmentStore.setState({ environments: [] });
  usePaneLayoutStore.setState({
    environments: new Map(),
    hydration: new Map(),
    activeEnvironmentId: null,
  });
  useNativeComposeStore.setState({ drafts: new Map() });
  useNativeAgentProjectionStore.getState().reset();
});

describe("AgentNativeTab commands", () => {
  test("choosing a row inserts its text and records identity without sending", async () => {
    const tabId = "tab-choose";
    const { input } = await renderTab(tabId);
    await type(input, tabId, "/rev");

    const listbox = await screen.findByRole("listbox", { name: "Slash commands" });
    const option = screen.getByRole("option", { name: /review/ });
    expect(input.getAttribute("aria-controls")).toBe(listbox.id);
    expect(input.getAttribute("aria-expanded")).toBe("true");
    expect(input.getAttribute("aria-activedescendant")).toBe(option.id);

    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(draftFor(tabId)?.text).toBe("/review "));
    expect(draftFor(tabId)?.commandSelection).toEqual(selection());
    expect(screen.queryByRole("listbox") === null).toBe(true);
    expect(input.getAttribute("aria-expanded")).toBe("false");
    expect(dispatchNativeAgentIntentMock).not.toHaveBeenCalled();
  });

  test("a skill row inserts $name and sends the selected identity", async () => {
    const tabId = "tab-skill";
    const { input } = await renderTab(tabId);
    await type(input, tabId, "/skills:dep");
    fireEvent.keyDown(input, { key: "Tab" });
    await waitFor(() => expect(draftFor(tabId)?.text).toBe("$deploy "));
    expect(draftFor(tabId)?.commandSelection?.commandId).toBe("codex:skill:deploy");

    await type(input, tabId, "$deploy staging");
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(dispatchNativeAgentIntentMock).toHaveBeenCalledTimes(1));
    expect(dispatchNativeAgentIntentMock.mock.calls[0]![0]).toMatchObject({
      prompt: "$deploy staging",
      command: { kind: "selected", commandId: "codex:skill:deploy", bindingRevision: "skill-1" },
    });
  });

  test("a disabled row explains itself and never becomes executable", async () => {
    const tabId = "tab-disabled";
    const { input } = await renderTab(tabId);
    await type(input, tabId, "/login");
    const option = await screen.findByRole("option", { name: /login/ });
    expect(option.getAttribute("aria-disabled")).toBe("true");
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() =>
      expect(screen.getByRole("status").textContent).toBe("Sign in from Settings instead."),
    );
    expect(draftFor(tabId)?.text).toBe("/login");
    expect(draftFor(tabId)?.commandSelection).toBeUndefined();
    expect(dispatchNativeAgentIntentMock).not.toHaveBeenCalled();
  });

  test("keeps a selected command token raw and resolves file mentions in its arguments", async () => {
    const tabId = "tab-raw";
    const raw = '/review @a.ts\t"quoted"  \nsecond line  ';
    seedDraft(tabId, {
      text: raw,
      mentions: [{ id: "m1", filename: "a.ts", relativePath: "src/a.ts" }],
      commandSelection: selection(),
    });
    const { input } = await renderTab(tabId);
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() => expect(dispatchNativeAgentIntentMock).toHaveBeenCalledTimes(1));
    const sent = dispatchNativeAgentIntentMock.mock.calls[0]![0];
    expect(sent.prompt).toBe('/review [@a.ts](src/a.ts)\t"quoted"  \nsecond line  ');
    expect(sent.command).toEqual({
      kind: "selected",
      commandId: "codex:/review",
      bindingRevision: "rev-1",
    });
  });

  test("an ordinary prompt keeps its shaping and carries no intent", async () => {
    const tabId = "tab-ordinary";
    seedDraft(tabId, {
      text: "look at @a.ts",
      mentions: [{ id: "m1", filename: "a.ts", relativePath: "src/a.ts" }],
    });
    const { input } = await renderTab(tabId);
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(dispatchNativeAgentIntentMock).toHaveBeenCalledTimes(1));
    const sent = dispatchNativeAgentIntentMock.mock.calls[0]![0];
    expect(sent.prompt).toBe("look at [@a.ts](src/a.ts)");
    expect(sent.command).toBeUndefined();
  });

  test("a legacy backend without catalogue state sends exactly as before", async () => {
    projectionOptions = { catalogue: null, commands: [{ name: "/review", source: "project" }] };
    const tabId = "tab-legacy";
    const { input } = await renderTab(tabId);
    await type(input, tabId, "/rev");
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(draftFor(tabId)?.text).toBe("/review "));
    expect(draftFor(tabId)?.commandSelection).toBeUndefined();
    await type(input, tabId, "/review x");
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(dispatchNativeAgentIntentMock).toHaveBeenCalledTimes(1));
    const sent = dispatchNativeAgentIntentMock.mock.calls[0]![0];
    expect(sent.prompt).toBe("/review x");
    expect("command" in sent).toBe(false);
  });

  test("refuses a selection that is gone and keeps the draft and identity", async () => {
    projectionOptions = { commands: [SKILL, COMPACT] };
    const tabId = "tab-stale";
    seedDraft(tabId, { text: "/review src/a.ts", commandSelection: selection() });
    const { input } = await renderTab(tabId);
    fireEvent.keyDown(input, { key: "Enter" });

    expect(
      await screen.findByText(
        "The selected command is no longer available. Choose it again from the menu.",
      ),
    ).toBeTruthy();
    expect(dispatchNativeAgentIntentMock).not.toHaveBeenCalled();
    expect(enqueuePromptQueueMessageMock).not.toHaveBeenCalled();
    expect(draftFor(tabId)?.text).toBe("/review src/a.ts");
    expect(draftFor(tabId)?.commandSelection).toEqual(selection());
    // No "send as text" for a stale selection: it must be chosen again.
    expect(screen.queryByRole("button", { name: "Send as text" }) === null).toBe(true);
  });

  test("rejects annotations and unsupported attachments for a command before sending", async () => {
    const tabId = "tab-policy";
    seedDraft(tabId, {
      // The trailing space closes the menu, so Enter sends rather than completes.
      text: "/compact ",
      attachments: [{ id: "i1", type: "image", name: "shot.png", path: "/w/shot.png" }],
    });
    const { input } = await renderTab(tabId);
    fireEvent.keyDown(input, { key: "Enter" });
    expect(
      await screen.findByText("/compact does not accept attachments. Remove them and retry."),
    ).toBeTruthy();
    expect(performNativeAgentSessionActionMock).not.toHaveBeenCalled();
    expect(draftFor(tabId)?.attachments).toHaveLength(1);
    cleanup();

    const annotated = "tab-policy-annotation";
    seedDraft(annotated, {
      text: "/review x",
      commandSelection: selection(),
      annotations: [{ id: "a1", text: "selected transcript text", comment: "" }],
    });
    const rendered = await renderTab(annotated);
    fireEvent.keyDown(rendered.input, { key: "Enter" });
    expect(
      await screen.findByText(
        "/review can't include transcript annotations. Remove them and retry.",
      ),
    ).toBeTruthy();
    expect(dispatchNativeAgentIntentMock).not.toHaveBeenCalled();
    expect(draftFor(annotated)?.annotations).toHaveLength(1);
  });

  test("offers send-as-text for an unavailable command where the provider can honour it", async () => {
    const tabId = "tab-literal";
    const { input } = await renderTab(tabId);
    await type(input, tabId, "/login now please");
    fireEvent.keyDown(input, { key: "Enter" });
    expect(await screen.findByText("Sign in from Settings instead.")).toBeTruthy();
    expect(dispatchNativeAgentIntentMock).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Send as text" }));
    await waitFor(() => expect(dispatchNativeAgentIntentMock).toHaveBeenCalledTimes(1));
    expect(dispatchNativeAgentIntentMock.mock.calls[0]![0]).toMatchObject({
      prompt: "/login now please",
      command: { kind: "literal" },
    });
  });

  test("does not offer an escape Claude cannot honour", async () => {
    projectionOptions = {
      commands: [{ ...LOGIN, id: "claude:/login" }],
      sessionId: "claude-session",
    };
    const tabId = "tab-literal-claude";
    const { input } = await renderTab(tabId, "claude");
    await type(input, tabId, "/login now");
    fireEvent.keyDown(input, { key: "Enter" });
    expect(await screen.findByText("Sign in from Settings instead.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Send as text" }) === null).toBe(true);

    await type(input, tabId, "/login");
    expect(await screen.findByText(/reads messages that start with a command name/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Send as text" }) === null).toBe(true);
  });

  test("an unmatched query stays visible and can be sent as text", async () => {
    const tabId = "tab-nomatch";
    const { input } = await renderTab(tabId);
    await type(input, tabId, "/usr/local");
    expect(await screen.findByText("No commands match")).toBeTruthy();
    expect(screen.getByRole("status").textContent).toBe("No commands match /usr/local");
    fireEvent.click(screen.getByRole("button", { name: "Send as text" }));
    await waitFor(() => expect(dispatchNativeAgentIntentMock).toHaveBeenCalledTimes(1));
    expect(dispatchNativeAgentIntentMock.mock.calls[0]![0]).toMatchObject({
      prompt: "/usr/local",
      command: { kind: "literal" },
    });
  });

  test("/compact runs the session action directly, never the prompt path", async () => {
    const tabId = "tab-compact";
    const { input } = await renderTab(tabId);
    await type(input, tabId, "/comp");
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(draftFor(tabId)?.text).toBe("/compact "));
    expect(performNativeAgentSessionActionMock).not.toHaveBeenCalled();

    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(performNativeAgentSessionActionMock).toHaveBeenCalledTimes(1));
    expect(performNativeAgentSessionActionMock.mock.calls[0]![0]).toMatchObject({
      agent: "codex",
      action: { kind: "compact" },
    });
    expect(dispatchNativeAgentIntentMock).not.toHaveBeenCalled();
    expect(enqueuePromptQueueMessageMock).not.toHaveBeenCalled();
    await waitFor(() => expect(draftFor(tabId)).toBeUndefined());
  });

  test("/compact refuses arguments and keeps the draft", async () => {
    const tabId = "tab-compact-args";
    seedDraft(tabId, { text: "/compact please" });
    const { input } = await renderTab(tabId);
    fireEvent.keyDown(input, { key: "Enter" });
    expect(await screen.findByText(/takes no arguments/)).toBeTruthy();
    expect(performNativeAgentSessionActionMock).not.toHaveBeenCalled();
    expect(draftFor(tabId)?.text).toBe("/compact please");
  });

  test("a queued command carries its intent; /compact is refused while busy", async () => {
    projectionOptions = { phase: "running" };
    const tabId = "tab-queue";
    seedDraft(tabId, { text: "/review a.ts  ", commandSelection: selection() });
    const { input } = await renderTab(tabId);
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(enqueuePromptQueueMessageMock).toHaveBeenCalledTimes(1));
    expect(enqueuePromptQueueMessageMock.mock.calls[0]).toEqual([
      `codex\0${createSessionKey("env-1", tabId)}`,
      "env-1",
      expect.objectContaining({
        text: "/review a.ts  ",
        command: { kind: "selected", commandId: "codex:/review", bindingRevision: "rev-1" },
      }),
    ]);
    expect(dispatchNativeAgentIntentMock).not.toHaveBeenCalled();

    await type(input, tabId, "/compact");
    await type(input, tabId, "/compact ");
    fireEvent.keyDown(input, { key: "Enter" });
    expect(await screen.findByText(/runs only while Codex is idle/)).toBeTruthy();
    expect(performNativeAgentSessionActionMock).not.toHaveBeenCalled();
    expect(enqueuePromptQueueMessageMock).toHaveBeenCalledTimes(1);
  });

  test("a selection made against another provider or session is dropped", async () => {
    const tabId = "tab-switch";
    seedDraft(tabId, { text: "/review x", commandSelection: selection({ platform: "claude" }) });
    await renderTab(tabId);
    await waitFor(() => expect(draftFor(tabId)?.commandSelection).toBeUndefined());
    expect(draftFor(tabId)?.text).toBe("/review x");

    cleanup();
    const otherTab = "tab-switch-session";
    seedDraft(otherTab, {
      text: "/review x",
      commandSelection: selection({ sessionId: "a-previous-session" }),
    });
    await renderTab(otherTab);
    await waitFor(() => expect(draftFor(otherTab)?.commandSelection).toBeUndefined());
  });

  test("an unavailable list explains itself and refreshes through the backend", async () => {
    projectionOptions = {
      commands: [COMPACT],
      catalogue: {
        status: "unavailable",
        revision: 5,
        enhanced: true,
        error: { code: "timeout", message: "raw rpc detail" },
      },
    };
    const tabId = "tab-unavailable";
    const { input } = await renderTab(tabId);
    await type(input, tabId, "/");
    expect(
      await screen.findByText("Commands couldn't be loaded. The agent took too long to answer."),
    ).toBeTruthy();
    expect(screen.queryByText(/raw rpc detail/) === null).toBe(true);
    // Orkestrator's own action is still offered.
    expect(screen.getByRole("option", { name: /compact/ })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Refresh commands" }));
    await waitFor(() => expect(refreshNativeAgentCommandsMock).toHaveBeenCalledTimes(1));
    expect(refreshNativeAgentCommandsMock.mock.calls[0]![0]).toMatchObject({
      agent: "codex",
      environmentId: "env-1",
    });
  });

  test("loading and unsupported lists keep the menu open with an explanation", async () => {
    projectionOptions = {
      commands: [],
      catalogue: { status: "loading", revision: 1, enhanced: true },
    };
    const tabId = "tab-loading";
    const { input } = await renderTab(tabId);
    await type(input, tabId, "/");
    expect(await screen.findByText("Loading commands…")).toBeTruthy();
    expect(input.getAttribute("contenteditable")).toBe("true");
    cleanup();

    projectionOptions = {
      commands: [COMPACT],
      catalogue: { status: "unsupported", revision: 0, enhanced: true },
    };
    const unsupportedTab = "tab-unsupported";
    const rendered = await renderTab(unsupportedTab);
    await type(rendered.input, unsupportedTab, "/");
    expect(await screen.findByText("This agent doesn't expose provider commands.")).toBeTruthy();
    expect(screen.getByRole("group", { name: "Orkestrator" })).toBeTruthy();
  });
});
