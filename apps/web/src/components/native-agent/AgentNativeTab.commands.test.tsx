import { createReadCoordinator, resetReadCoordinatorForTests } from "@/lib/read-coordinator";
import { FakeClock } from "@/lib/testing/read-coordinator";
/**
 * Composer command behaviour on the shared native tab.
 *
 * Kept apart from the main tab suite (already far past the file-size
 * guideline): picking a command records its identity in the draft, a command
 * is sent as raw text with an explicit intent, and every refusal keeps the
 * draft. The backend remains authoritative; these tests pin what the composer
 * sends and when it declines to send at all.
 */
import { afterAll, afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { VirtuosoMockContext } from "react-virtuoso";
import { act, cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { renderInAppCommandScope } from "@/test/render-in-node-scope";
import type {
  NativeAgentCommandCatalogueState,
  NativeAgentDispatchOutcome,
  NativeAgentSessionProjection,
  NativeAgentSlashCommand,
  NativeAgentTabData,
} from "@orkestrator/protocol/native-agent";
import {
  PROVIDER_FAILURE_RETRY_PROMPT,
  providerFailureRetryRequestId,
} from "@orkestrator/protocol/provider-failures";
import type { AgentPlatform } from "@orkestrator/protocol/agent-platforms";
import type { NativeMessage } from "@/lib/chat/native-message-types";
import { createNativeAgentSessionBackend } from "@/test/native-agent-session-backend";
import * as realBackend from "@/lib/backend";
import * as realPaneLayoutPersistence from "@/lib/pane-layout-persistence";
import * as realNativeComposeBarPaste from "@/hooks/useNativeComposeBarPaste";
import { environmentStore } from "@/stores/environmentStore";
import { paneLayoutStore } from "@/stores/paneLayoutStore";
import {
  type NativeCommandSelection,
  type NativeComposeDraft,
  nativeComposeStore,
} from "@/stores/nativeComposeStore";
import { nativeAgentProjectionStore } from "@/stores/nativeAgentProjectionStore";
import { createSessionKey } from "@/lib/utils";
import type { UserCommandRecord } from "@orkestrator/protocol/user-commands";
import { appCommandStore } from "@/test/app-command-store";
import * as failureRecovery from "./useProviderFailureRecovery";

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
  messages?: NativeMessage[];
  twoModels?: boolean;
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
    messages: projectionOptions.messages ?? [],
    interactions: [],
    composerControls: [],
    composer: {
      models: [
        { platform: agent, id: "model-a", label: "Model A" },
        ...(projectionOptions.twoModels
          ? [{ platform: agent, id: "model-b", label: "Model B" }]
          : []),
      ],
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

const sessionProjectionMock = mock(async (input: { agent: AgentPlatform }) =>
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
  async (_input: { agent: string; action: { kind: string } }): Promise<{ outcome: "applied" }> => ({
    outcome: "applied",
  }),
);
const refreshNativeAgentCommandsMock = mock(async (input: { agent: AgentPlatform }) => ({
  outcome: "reread" as const,
  projection: projectionFor(input.agent),
}));
let userCommands: UserCommandRecord[] = [];
const runUserCommandMock = mock(
  async (input: { environmentId: string; tabId: string; command: string }) => {
    const record: UserCommandRecord = {
      id: `cmd-${userCommands.length + 1}`,
      environmentId: input.environmentId,
      tabId: input.tabId,
      command: input.command,
      target: "container",
      cwd: "/workspace",
      status: "running",
      startedAt: new Date().toISOString(),
      output: "",
      outputTruncated: false,
      context: { state: "pending" },
      revision: 1,
    };
    userCommands = [...userCommands, record];
    return record;
  },
);
const listUserCommandsMock = mock(async (environmentId: string, tabId: string) => ({
  environmentId,
  tabId,
  commands: userCommands,
}));
const getFileTreeMock = mock(async () => []);
const getLocalFileTreeMock = mock(async () => []);

mock.module("@/hooks/useNativeComposeBarPaste", () => ({
  useNativeComposeBarPaste: () => {},
}));
// The session as the fake backend holds it; every progressive read answers from it.
const sessionBackend = createNativeAgentSessionBackend({
  readProjection: (input) => sessionProjectionMock(input),
});
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
  getFileTree: getFileTreeMock,
  getLocalFileTree: getLocalFileTreeMock,
  ...sessionBackend.api,
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
  runUserCommand: runUserCommandMock,
  listUserCommands: listUserCommandsMock,
  listHumanPrompts: async () => ({ prompts: [] }),
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
  return appCommandStore(nativeComposeStore)
    .getState()
    .drafts.get(createSessionKey("env-1", tabId));
}

function seedDraft(tabId: string, update: Partial<NativeComposeDraft>) {
  appCommandStore(nativeComposeStore)
    .getState()
    .updateDraft(createSessionKey("env-1", tabId), update);
}

async function renderTab(
  tabId: string,
  platform: AgentPlatform = "codex",
  beforeSend?: () => Promise<void | boolean>,
) {
  const view = renderInAppCommandScope(
    <VirtuosoMockContext.Provider value={{ viewportHeight: 600, itemHeight: 60 }}>
      <AgentNativeTab tabId={tabId} data={identity(platform)} isActive beforeSend={beforeSend} />
    </VirtuosoMockContext.Provider>,
  );
  const input = await screen.findByRole("textbox");
  // Wait for the projection so sending is authorised.
  await waitFor(() => expect(sessionProjectionMock).toHaveBeenCalled());
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
  appCommandStore(environmentStore).setState({
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
  userCommands = [];
  runUserCommandMock.mockClear();
  listUserCommandsMock.mockClear();
  sessionProjectionMock.mockClear();
  dispatchNativeAgentIntentMock.mockClear();
  enqueuePromptQueueMessageMock.mockClear();
  performNativeAgentSessionActionMock.mockClear();
  performNativeAgentSessionActionMock.mockImplementation(async () => ({
    outcome: "applied" as const,
  }));
  refreshNativeAgentCommandsMock.mockClear();
  getFileTreeMock.mockClear();
  getLocalFileTreeMock.mockClear();
  appCommandStore(environmentStore).setState({ environments: [] });
  appCommandStore(paneLayoutStore).setState({
    environments: new Map(),
    hydration: new Map(),
    activeEnvironmentId: null,
  });
  appCommandStore(nativeComposeStore).setState({ drafts: new Map() });
  appCommandStore(nativeAgentProjectionStore).getState().reset();
});

describe("AgentNativeTab ! commands", () => {
  test("a leading ! runs the command as the user, even mid-turn, and never reaches the agent", async () => {
    projectionOptions = { phase: "running" };
    const tabId = "tab-bang";
    const { input } = await renderTab(tabId);
    await type(input, tabId, "!npm login --auth-type=web");
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(runUserCommandMock).toHaveBeenCalledTimes(1));
    expect(runUserCommandMock.mock.calls[0]![0]).toEqual({
      environmentId: "env-1",
      tabId,
      command: "npm login --auth-type=web",
    });
    await waitFor(() => expect(draftFor(tabId)?.text ?? "").toBe(""));
    expect(dispatchNativeAgentIntentMock).not.toHaveBeenCalled();
    expect(enqueuePromptQueueMessageMock).not.toHaveBeenCalled();
    // The card comes from the backend's list, re-read after the run. (Rows
    // themselves are virtualized and not rendered under happy-dom; the card
    // has its own suite.)
    await waitFor(() =>
      expect(
        listUserCommandsMock.mock.calls.filter(
          ([environmentId, tab]) => environmentId === "env-1" && tab === tabId,
        ).length,
      ).toBeGreaterThanOrEqual(2),
    );
  });

  test("! alone, or a literal send, is ordinary text", async () => {
    const tabId = "tab-bang-plain";
    const { input } = await renderTab(tabId);
    await type(input, tabId, "!");
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(dispatchNativeAgentIntentMock).toHaveBeenCalledTimes(1));
    expect(runUserCommandMock).not.toHaveBeenCalled();
  });
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

  test("/compact <instructions> sends them where the row accepts them", async () => {
    // Pi and Claude publish an argument-taking compact row.
    projectionOptions = {
      commands: [
        {
          ...COMPACT,
          argumentHint: "[instructions]",
          inputPolicy: { arguments: "optional", attachments: "none", busy: "idle" },
        },
      ],
    };
    const tabId = "tab-compact-instructions";
    seedDraft(tabId, { text: "/compact keep the failing test names " });
    const { input } = await renderTab(tabId, "pi");
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(performNativeAgentSessionActionMock).toHaveBeenCalledTimes(1));
    expect(performNativeAgentSessionActionMock.mock.calls[0]![0]).toMatchObject({
      agent: "pi",
      action: { kind: "compact", instructions: "keep the failing test names" },
    });
    expect(dispatchNativeAgentIntentMock).not.toHaveBeenCalled();
    await waitFor(() => expect(draftFor(tabId)).toBeUndefined());
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

  test("a list read before the session started says more commands arrive with it", async () => {
    projectionOptions = {
      commands: [
        {
          name: "/review",
          id: "pi:template:review",
          source: "template",
          executionKind: "provider-prompt",
          bindingRevision: "rev-review",
        },
        COMPACT,
      ],
      catalogue: { status: "stale", revision: 2, enhanced: true, attachPending: true },
    };
    const tabId = "tab-attach-pending";
    const { input } = await renderTab(tabId);
    await type(input, tabId, "/");
    expect(
      await screen.findByText(
        /More commands load when the session starts; refresh to load them now\./,
      ),
    ).toBeTruthy();
    // The rows read so far are usable now; refresh is how to get the rest.
    expect(screen.getByRole("option", { name: /review/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Refresh commands" })).toBeTruthy();
  });

  test("typing after the sigil filters a maximal list without fetching, refreshing or scanning", async () => {
    // This asserts reads caused by typing. Keep periodic background reads on
    // a manual clock so a slow renderer cannot cross their wall-clock cadence.
    const clock = new FakeClock();
    resetReadCoordinatorForTests(() =>
      createReadCoordinator({ clock, document: null, window: null }),
    );
    try {
      // A wire-maximum inventory: the menu filters it in memory on every key.
      const rows: NativeAgentSlashCommand[] = Array.from({ length: 512 }, (_, index) => ({
        name: `/team-tools:review-pr-${index}`,
        id: `codex:team-tools:review-pr-${index}`,
        source: index % 2 ? "plugin" : "project",
        description: `Review pull request batch ${index} against the project conventions.`,
        argumentHint: "<path>",
        executionKind: "provider-prompt",
        bindingRevision: `rev-${index}`,
      }));
      projectionOptions = { commands: [...rows, COMPACT] };
      const tabId = "tab-keystrokes";
      const { input } = await renderTab(tabId);
      await type(input, tabId, "/");
      await screen.findByRole("listbox", { name: "Slash commands" });
      const projectionReads = sessionProjectionMock.mock.calls.length;
      const fileTreeReads =
        getFileTreeMock.mock.calls.length + getLocalFileTreeMock.mock.calls.length;

      const typed = "team-tools:review-pr";
      expect(typed).toHaveLength(20);
      for (let length = 1; length <= typed.length; length += 1) {
        await type(input, tabId, `/${typed.slice(0, length)}`);
      }
      // Still filtering the projection's rows: the search caps what it renders.
      expect(screen.getAllByRole("option").length).toBeGreaterThan(0);
      expect(sessionProjectionMock.mock.calls.length).toBe(projectionReads);
      expect(refreshNativeAgentCommandsMock).not.toHaveBeenCalled();
      expect(getFileTreeMock.mock.calls.length + getLocalFileTreeMock.mock.calls.length).toBe(
        fileTreeReads,
      );
    } finally {
      cleanup();
      resetReadCoordinatorForTests();
    }
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

test("an unaccepted prompt keeps the controller loading and Stop available", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  dispatchNativeAgentIntentMock.mockImplementationOnce(async (input) => {
    await gate;
    return { outcome: "accepted", requestId: input.requestId };
  });
  const tabId = "tab-unaccepted";
  const { input } = await renderTab(tabId);
  await type(input, tabId, "Start a slow prompt");
  fireEvent.keyDown(input, { key: "Enter" });
  try {
    await waitFor(() => expect(dispatchNativeAgentIntentMock).toHaveBeenCalledTimes(1));
    // The provider projection is still idle: only the pending dispatch can
    // make isTurnActive/isLoading true and expose the compose bar's Stop.
    expect(projectionFor("codex").turn.phase).toBe("idle");
    expect(await screen.findByTitle("Stop current query")).toBeTruthy();
    expect(screen.getByTestId("compose-dock").className).toContain("top-1/2");
    expect(screen.queryByTitle("Send") === null).toBe(true);
  } finally {
    await act(async () => {
      release();
      await gate;
    });
  }
  await waitFor(() => expect(screen.queryByTitle("Stop current query") === null).toBe(true));
});

describe("composer preflight", () => {
  test.each(["/login now", "!text"])(
    "send-as-text gates literal %s before dispatch",
    async (text) => {
      let release!: () => void;
      const beforeSend = mock(
        () =>
          new Promise<void>((resolve) => {
            release = resolve;
          }),
      );
      const tabId = `preflight-literal-${text}`;
      const { input } = await renderTab(tabId, "codex", beforeSend);
      await type(input, tabId, "/login now");
      fireEvent.keyDown(input, { key: "Enter" });
      const literal = await screen.findByRole("button", { name: "Send as text" });
      expect(beforeSend).not.toHaveBeenCalled();
      act(() => {
        // The stable literal action always reads the latest draft, including !text.
        seedDraft(tabId, { text });
        fireEvent.click(literal);
      });
      expect(beforeSend).toHaveBeenCalledTimes(1);
      expect(dispatchNativeAgentIntentMock).not.toHaveBeenCalled();
      await act(async () => release());
      await waitFor(() => expect(dispatchNativeAgentIntentMock).toHaveBeenCalledTimes(1));
      expect(dispatchNativeAgentIntentMock.mock.calls[0]![0]).toMatchObject({
        prompt: text,
        command: { kind: "literal" },
      });
      expect(runUserCommandMock).not.toHaveBeenCalled();
    },
  );

  test("Add to queue waits for preflight and queues only once", async () => {
    projectionOptions = { phase: "running" };
    let release!: () => void;
    const beforeSend = mock(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    const { input } = await renderTab("preflight-queue", "codex", beforeSend);
    await type(input, "preflight-queue", "Queue this");
    fireEvent.click(screen.getByTitle("Add to queue"));
    fireEvent.keyDown(input, { key: "Enter" });
    expect(beforeSend).toHaveBeenCalledTimes(1);
    expect(enqueuePromptQueueMessageMock).not.toHaveBeenCalled();
    await act(async () => release());
    await waitFor(() => expect(enqueuePromptQueueMessageMock).toHaveBeenCalledTimes(1));
    expect(dispatchNativeAgentIntentMock).not.toHaveBeenCalled();
  });

  test("a rejected slash command never starts preflight", async () => {
    const beforeSend = mock(async () => {});
    const { input } = await renderTab("preflight-invalid-command", "codex", beforeSend);
    await type(input, "preflight-invalid-command", "/login now");
    fireEvent.keyDown(input, { key: "Enter" });
    await screen.findByText("Sign in from Settings instead.");
    expect(beforeSend).not.toHaveBeenCalled();
    expect(dispatchNativeAgentIntentMock).not.toHaveBeenCalled();
  });
});

/** A pre-send check that answers only when the test says so. */
function heldPreflight() {
  let settle!: (proceed?: boolean) => void;
  let fail!: (error: Error) => void;
  const beforeSend = mock(
    () =>
      new Promise<void | boolean>((resolve, reject) => {
        settle = resolve;
        fail = reject;
      }),
  );
  return {
    beforeSend,
    settle: (proceed?: boolean) => settle(proceed),
    fail: (e: Error) => fail(e),
  };
}

const transcript = () => screen.getByTestId("transcript-region");
const rowsWith = (text: string) => (transcript().textContent ?? "").split(text).length - 1;

describe("a prompt shown while its preflight runs", () => {
  const EARLIER: NativeMessage = {
    id: "earlier",
    createdAt: "2026-11-19T10:00:00.000Z",
    role: "assistant",
    content: "Ready",
    parts: [{ type: "text", content: "Ready" }],
  };

  const composerText = () => screen.getByRole("textbox").textContent;
  const dockCentered = () => screen.getByTestId("compose-dock").className.includes("top-1/2");

  test.each([
    { label: "an existing conversation", messages: [EARLIER] },
    { label: "an empty conversation", messages: [] },
  ])(
    "is on screen at once in $label and dispatched once, after the check",
    async ({ messages }) => {
      projectionOptions = { messages: [...messages] };
      const { beforeSend, settle } = heldPreflight();
      const tabId = `preflight-shown-${messages.length}`;
      const { input } = await renderTab(tabId, "codex", beforeSend);
      await type(input, tabId, "Show me now");
      let accept!: () => void;
      dispatchNativeAgentIntentMock.mockImplementationOnce(
        (intent) =>
          new Promise((resolve) => {
            accept = () => resolve({ outcome: "accepted", requestId: intent.requestId });
          }),
      );
      fireEvent.keyDown(input, { key: "Enter" });

      expect(rowsWith("Show me now")).toBe(1);
      expect(transcript().textContent).toContain("Codex is thinking...");
      expect(composerText()).toBe("");
      expect(dockCentered()).toBe(false);
      expect(input.getAttribute("contenteditable")).toBe("false");
      // Only the view is empty: a reload or a stopped send finds the draft.
      expect(draftFor(tabId)?.text).toBe("Show me now");
      expect(dispatchNativeAgentIntentMock).not.toHaveBeenCalled();

      const row = screen.getByText("Show me now");
      fireEvent.keyDown(input, { key: "Enter" });
      fireEvent.click(screen.getByTitle("Send"));
      expect(beforeSend).toHaveBeenCalledTimes(1);

      await act(async () => settle());
      expect(dispatchNativeAgentIntentMock).toHaveBeenCalledTimes(1);
      expect(dispatchNativeAgentIntentMock.mock.calls[0]![0]).toMatchObject({
        prompt: "Show me now",
      });
      // The same row carries on through the dispatch, and the text stays out of the box.
      expect(screen.getByText("Show me now") === row).toBe(true);
      expect(rowsWith("Show me now")).toBe(1);
      expect(composerText()).toBe("");
      expect(dockCentered()).toBe(false);

      await act(async () => accept());
      await waitFor(() => expect(draftFor(tabId)).toBeUndefined());
      expect(rowsWith("Show me now")).toBe(1);
      expect(composerText()).toBe("");
      expect(dispatchNativeAgentIntentMock).toHaveBeenCalledTimes(1);
    },
  );

  test.each([
    { label: "declines", error: null },
    { label: "throws", error: "Upstream check failed" },
    { label: "outlasts the draft", error: "The draft changed while preparing to send." },
  ])(
    "is withdrawn with its whole draft back when the preflight $label",
    async ({ label, error }) => {
      projectionOptions = { messages: [EARLIER] };
      const { beforeSend, settle, fail } = heldPreflight();
      const tabId = `preflight-stopped-${label}`;
      const { input } = await renderTab(tabId, "codex", beforeSend);
      const mention = { id: "m1", filename: "notes.ts", relativePath: "src/notes.ts" };
      const attachment = {
        id: "a1",
        type: "image" as const,
        name: "shot.png",
        path: "/workspace/shot.png",
        previewUrl: "data:image/png;base64,AAAA",
      };
      const draft = {
        text: "/review @notes.ts",
        mentions: [mention],
        attachments: [attachment],
        commandSelection: selection(),
      };
      act(() => seedDraft(tabId, draft));
      fireEvent.keyDown(input, { key: "Enter" });

      await waitFor(() => expect(beforeSend).toHaveBeenCalledTimes(1));
      expect(transcript().textContent).toContain("/review");
      // The row is drawn at once; its image resolves in an effect after that.
      await waitFor(() =>
        expect(
          transcript().querySelector('img[src^="data:image/png"]') instanceof HTMLImageElement,
        ).toBe(true),
      );
      expect(composerText()).toBe("");
      expect(screen.queryByTestId("compose-image-attachment") === null).toBe(true);

      const changed = { ...draft, text: `${draft.text} and more` };
      await act(async () => {
        if (label === "throws") fail(new Error(error!));
        else {
          if (label === "outlasts the draft") seedDraft(tabId, { text: changed.text });
          settle(label === "declines" ? false : undefined);
        }
      });
      const expected = label === "outlasts the draft" ? changed : draft;
      expect(dispatchNativeAgentIntentMock).not.toHaveBeenCalled();
      expect(transcript().textContent).not.toContain("/review");
      expect(transcript().textContent).not.toContain("is thinking");
      expect(draftFor(tabId)).toMatchObject(expected);
      expect(composerText()).toBe(expected.text);
      expect(input.querySelector('[data-mention="true"]')?.textContent).toBe("@notes.ts");
      expect(screen.getByTestId("compose-image-attachment")).toBeTruthy();
      expect(input.getAttribute("contenteditable")).not.toBe("false");
      if (error) expect(await screen.findByText(new RegExp(error))).toBeTruthy();
    },
  );

  test("keeps its annotations through a stopped send", async () => {
    projectionOptions = { messages: [EARLIER] };
    const { beforeSend, settle } = heldPreflight();
    const tabId = "preflight-annotations";
    const { input } = await renderTab(tabId, "codex", beforeSend);
    const annotations = [{ id: "n1", text: "Quoted", comment: "Why?" }];
    act(() => seedDraft(tabId, { text: "Explain", annotations }));
    fireEvent.keyDown(input, { key: "Enter" });
    expect(screen.queryByTestId("compose-annotation-count") === null).toBe(true);
    await act(async () => settle(false));
    expect(screen.getByTestId("compose-annotation-count")).toBeTruthy();
    expect(draftFor(tabId)?.annotations).toEqual(annotations);
  });

  test("a refused dispatch after the check gives the draft back", async () => {
    projectionOptions = { messages: [EARLIER] };
    dispatchNativeAgentIntentMock.mockImplementationOnce(async () => ({
      outcome: "rejected",
      error: "Not now",
    }));
    const { beforeSend, settle } = heldPreflight();
    const tabId = "preflight-refused";
    const { input } = await renderTab(tabId, "codex", beforeSend);
    await type(input, tabId, "Refuse me");
    fireEvent.keyDown(input, { key: "Enter" });
    await act(async () => settle());
    expect(await screen.findByText("Not now")).toBeTruthy();
    expect(rowsWith("Refuse me")).toBe(0);
    expect(composerText()).toBe("Refuse me");
  });

  test("a remount during the check sends nothing and shows the draft again", async () => {
    projectionOptions = { messages: [EARLIER] };
    const { beforeSend, settle } = heldPreflight();
    const tabId = "preflight-remount";
    const first = await renderTab(tabId, "codex", beforeSend);
    await type(first.input, tabId, "Keep me");
    fireEvent.keyDown(first.input, { key: "Enter" });
    first.unmount();
    await renderTab(tabId, "codex", beforeSend);
    expect(composerText()).toBe("Keep me");
    expect(rowsWith("Keep me")).toBe(0);
    await act(async () => settle());
    expect(dispatchNativeAgentIntentMock).not.toHaveBeenCalled();
    expect(composerText()).toBe("Keep me");
  });

  test("a declined second check leaves the accepted first row visible until its echo", async () => {
    projectionOptions = { messages: [EARLIER] };
    const { beforeSend, settle } = heldPreflight();
    const tabId = "preflight-consecutive";
    const { input } = await renderTab(tabId, "codex", beforeSend);
    await type(input, tabId, "Accepted first");
    fireEvent.keyDown(input, { key: "Enter" });
    await act(async () => settle());
    await waitFor(() => expect(draftFor(tabId)).toBeUndefined());

    await type(input, tabId, "Decline this second");
    fireEvent.keyDown(input, { key: "Enter" });
    expect(transcript().textContent).toMatch(/Accepted first.*Decline this second/s);
    await act(async () => settle(false));
    expect(rowsWith("Accepted first")).toBe(1);
    expect(rowsWith("Decline this second")).toBe(0);
    expect(composerText()).toBe("Decline this second");
    expect(dispatchNativeAgentIntentMock).toHaveBeenCalledTimes(1);
  });

  test("another prompt that arrives during the check is not taken for this one's echo", async () => {
    projectionOptions = { messages: [EARLIER] };
    const { beforeSend, settle } = heldPreflight();
    const tabId = "preflight-other-row";
    const { input } = await renderTab(tabId, "codex", beforeSend);
    await type(input, tabId, "Mine");
    fireEvent.keyDown(input, { key: "Enter" });
    const other: NativeMessage = {
      ...EARLIER,
      id: "other-window",
      role: "user",
      content: "From another window",
      parts: [{ type: "text", content: "From another window" }],
    };
    projectionOptions = { messages: [EARLIER, other] };
    act(() =>
      appCommandStore(nativeAgentProjectionStore)
        .getState()
        .setProjection(createSessionKey("env-1", tabId), {
          ...projectionFor("codex"),
          revision: 2,
        }),
    );
    await waitFor(() => expect(transcript().textContent).toMatch(/Mine.*From another window/s));

    let accept!: () => void;
    dispatchNativeAgentIntentMock.mockImplementationOnce(
      (intent) =>
        new Promise((resolve) => {
          accept = () => resolve({ outcome: "accepted", requestId: intent.requestId });
        }),
    );
    await act(async () => settle());
    expect(dispatchNativeAgentIntentMock).toHaveBeenCalledTimes(1);
    expect(draftFor(tabId)?.pendingTranscriptConfirmation?.priorMessageIds).toEqual([
      "earlier",
      "other-window",
    ]);
    expect(transcript().textContent).toMatch(/Mine.*From another window/s);
    await act(async () => accept());
    projectionOptions = {
      messages: [
        EARLIER,
        other,
        {
          ...other,
          id: "mine-echo",
          content: "Mine echoed",
          parts: [{ type: "text", content: "Mine echoed" }],
        },
      ],
    };
    act(() =>
      appCommandStore(nativeAgentProjectionStore)
        .getState()
        .setProjection(createSessionKey("env-1", tabId), {
          ...projectionFor("codex"),
          revision: 3,
        }),
    );
    await waitFor(() => expect(transcript().textContent).toMatch(/Mine.*From another window/s));
    expect(rowsWith("Mine")).toBe(1);
    expect(transcript().textContent).toContain("Mine echoed");
  });

  test("a prompt bound for the queue never becomes a transcript row", async () => {
    projectionOptions = { messages: [EARLIER], phase: "running" };
    const { beforeSend, settle } = heldPreflight();
    const tabId = "preflight-queued-row";
    const { input } = await renderTab(tabId, "codex", beforeSend);
    await type(input, tabId, "Queue me");
    fireEvent.keyDown(input, { key: "Enter" });
    expect(beforeSend).toHaveBeenCalledTimes(1);
    expect(rowsWith("Queue me")).toBe(0);
    await act(async () => settle());
    await waitFor(() => expect(enqueuePromptQueueMessageMock).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(draftFor(tabId)).toBeUndefined());
    expect(rowsWith("Queue me")).toBe(0);
    expect(dispatchNativeAgentIntentMock).not.toHaveBeenCalled();
  });

  test("a tab with no preflight still keeps its text in the composer until acceptance", async () => {
    projectionOptions = { messages: [EARLIER] };
    let accept!: () => void;
    dispatchNativeAgentIntentMock.mockImplementationOnce(
      (intent) =>
        new Promise((resolve) => {
          accept = () => resolve({ outcome: "accepted", requestId: intent.requestId });
        }),
    );
    const tabId = "no-preflight";
    const { input } = await renderTab(tabId);
    await type(input, tabId, "Ordinary");
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(dispatchNativeAgentIntentMock).toHaveBeenCalledTimes(1));
    expect(rowsWith("Ordinary")).toBe(1);
    expect(composerText()).toBe("Ordinary");
    await act(async () => accept());
    await waitFor(() => expect(composerText()).toBe(""));
  });
});

const FAILURE_ROW: NativeMessage = {
  id: "native-terminal:error:fixture",
  createdAt: "2026-11-19T10:00:00.000Z",
  role: "system",
  content: "Fetch failed",
  parts: [],
};

describe("transcript recovery through the composer", () => {
  const RETRY_REQUEST_ID = providerFailureRetryRequestId(FAILURE_ROW.id, FAILURE_ROW.createdAt);
  const retryButton = () => screen.queryByRole("button", { name: "Retry" });
  const publish = (tabId: string, messages: NativeMessage[], revision: number) => {
    projectionOptions = { messages };
    act(() =>
      appCommandStore(nativeAgentProjectionStore)
        .getState()
        .setProjection(createSessionKey("env-1", tabId), {
          ...projectionFor("codex"),
          revision,
        }),
    );
  };

  test("Retry is on screen at once and dispatched once, after the check, under its own id", async () => {
    projectionOptions = { messages: [FAILURE_ROW] };
    const { beforeSend, settle } = heldPreflight();
    const tabId = "failure-retry-shown";
    const { input } = await renderTab(tabId, "codex", beforeSend);
    let accept!: () => void;
    dispatchNativeAgentIntentMock.mockImplementationOnce(
      (intent) =>
        new Promise((resolve) => {
          accept = () => resolve({ outcome: "accepted", requestId: intent.requestId });
        }),
    );
    const retry = await screen.findByRole("button", { name: "Retry" });
    act(() => {
      fireEvent.click(retry);
      // Activate again before the pending state has reached the button.
      expect(retry.getAttribute("aria-disabled")).toBeNull();
      fireEvent.click(retry);
    });

    // Drawn as sent before the check answers, with the usual waiting indicator.
    expect(rowsWith(PROVIDER_FAILURE_RETRY_PROMPT)).toBe(1);
    expect(transcript().textContent).toMatch(
      /Fetch failed.*The previous turn ended with an error/s,
    );
    expect(transcript().textContent).toContain("Codex is thinking...");
    expect(beforeSend).toHaveBeenCalledTimes(1);
    expect(dispatchNativeAgentIntentMock).not.toHaveBeenCalled();
    // The retry owns no draft and its control stays mounted during the check.
    expect(draftFor(tabId)?.text ?? "").toBe("");
    expect(retryButton()).toBe(retry);
    expect(retry.getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(retry);
    fireEvent.click(screen.getByTitle("Send"));
    fireEvent.keyDown(input, { key: "Enter" });
    expect(beforeSend).toHaveBeenCalledTimes(1);

    const row = screen.getByText(PROVIDER_FAILURE_RETRY_PROMPT);
    await act(async () => settle());
    expect(dispatchNativeAgentIntentMock).toHaveBeenCalledTimes(1);
    expect(dispatchNativeAgentIntentMock.mock.calls[0]?.[0]).toMatchObject({
      prompt: PROVIDER_FAILURE_RETRY_PROMPT,
      command: { kind: "literal" },
      requestId: RETRY_REQUEST_ID,
      failureSessionId: "codex-session",
    });
    // The same row carries on through the dispatch.
    expect(screen.getByText(PROVIDER_FAILURE_RETRY_PROMPT) === row).toBe(true);
    expect(rowsWith(PROVIDER_FAILURE_RETRY_PROMPT)).toBe(1);
    expect(transcript().textContent).toContain("Codex is thinking...");

    await act(async () => accept());
    publish(
      tabId,
      [
        FAILURE_ROW,
        {
          id: "retry-echo",
          createdAt: "2026-11-19T10:01:00.000Z",
          role: "user",
          content: PROVIDER_FAILURE_RETRY_PROMPT,
          parts: [{ type: "text", content: PROVIDER_FAILURE_RETRY_PROMPT }],
        },
      ],
      2,
    );
    await waitFor(() => expect(transcript().textContent).not.toContain("Codex is thinking..."));
    expect(rowsWith(PROVIDER_FAILURE_RETRY_PROMPT)).toBe(1);
    expect(dispatchNativeAgentIntentMock).toHaveBeenCalledTimes(1);
    expect(enqueuePromptQueueMessageMock).not.toHaveBeenCalled();
    expect(draftFor(tabId)?.requestId).toBeUndefined();
    expect(draftFor(tabId)?.text ?? "").toBe("");
  });

  test.each([
    { label: "declines", error: null },
    { label: "throws", error: "Upstream check failed" },
  ])("Retry keeps focus when the check $label", async ({ label, error }) => {
    projectionOptions = { messages: [FAILURE_ROW] };
    const { beforeSend, settle, fail } = heldPreflight();
    const tabId = `failure-retry-${label}`;
    await renderTab(tabId, "codex", beforeSend);
    const retry = await screen.findByRole("button", { name: "Retry" });
    retry.focus();
    fireEvent.click(retry);
    expect(rowsWith(PROVIDER_FAILURE_RETRY_PROMPT)).toBe(1);
    expect(document.activeElement).toBe(retry);
    expect(retry.getAttribute("aria-disabled")).toBe("true");

    await act(async () => {
      if (error) fail(new Error(error));
      else settle(false);
    });
    expect(dispatchNativeAgentIntentMock).not.toHaveBeenCalled();
    expect(rowsWith(PROVIDER_FAILURE_RETRY_PROMPT)).toBe(0);
    expect(transcript().textContent).not.toContain("is thinking");
    expect(transcript().textContent).toContain("Fetch failed");
    expect(retryButton()).toBe(retry);
    expect(document.activeElement).toBe(retry);
    expect(retry.getAttribute("aria-disabled")).toBeNull();
    expect(draftFor(tabId)?.requestId).toBeUndefined();
    expect(draftFor(tabId)?.text ?? "").toBe("");
    if (error) expect(await screen.findByText(new RegExp(error))).toBeTruthy();
    fireEvent.click(retry);
    expect(beforeSend).toHaveBeenCalledTimes(2);
    await act(async () => settle(false));
  });

  test("an already stale Retry is refused before drawing a row or running the check", async () => {
    projectionOptions = { messages: [FAILURE_ROW] };
    const beforeSend = mock(async () => true);
    const tabId = "failure-retry-already-stale";
    const recovery = spyOn(failureRecovery, "useProviderFailureRecovery");
    try {
      await renderTab(tabId, "codex", beforeSend);
      await screen.findByRole("button", { name: "Retry" });
      // Keep the action from the old render as an in-flight activation would.
      const sendPrepared = recovery.mock.calls.at(-1)![0].sendPrepared;
      publish(
        tabId,
        [{ ...FAILURE_ROW, id: "native-terminal:error:newer", content: "Newer failure" }],
        2,
      );
      await waitFor(() => expect(transcript().textContent).toContain("Newer failure"));
      await act(async () => {
        expect(await sendPrepared(PROVIDER_FAILURE_RETRY_PROMPT, RETRY_REQUEST_ID)).toBe(false);
      });
      expect(await screen.findByText(/That failure is no longer current/)).toBeTruthy();
      expect(beforeSend).not.toHaveBeenCalled();
      expect(dispatchNativeAgentIntentMock).not.toHaveBeenCalled();
      expect(rowsWith(PROVIDER_FAILURE_RETRY_PROMPT)).toBe(0);
      expect(transcript().textContent).not.toContain("is thinking");
    } finally {
      recovery.mockRestore();
    }
  });

  test.each([
    {
      name: "rejected",
      outcome: { outcome: "rejected", error: "Retry was rejected" },
      error: "Retry was rejected",
    },
    {
      name: "unconfirmed after a transport failure",
      outcome: { outcome: "unknown", origin: "transport" },
      error: "The connection dropped before Codex confirmed",
    },
  ] as const)("Retry is offered again when dispatch is $name", async ({ name, outcome, error }) => {
    projectionOptions = { messages: [FAILURE_ROW] };
    const { beforeSend, settle } = heldPreflight();
    await renderTab(`failure-retry-dispatch-${name}`, "codex", beforeSend);
    let finish!: () => void;
    dispatchNativeAgentIntentMock.mockImplementationOnce(
      (intent) =>
        new Promise((resolve) => {
          finish = () =>
            resolve(
              outcome.outcome === "unknown" ? { ...outcome, requestId: intent.requestId } : outcome,
            );
        }),
    );
    fireEvent.click(await screen.findByRole("button", { name: "Retry" }));
    expect(rowsWith(PROVIDER_FAILURE_RETRY_PROMPT)).toBe(1);
    await act(async () => settle());
    expect(dispatchNativeAgentIntentMock).toHaveBeenCalledTimes(1);
    expect(dispatchNativeAgentIntentMock.mock.calls[0]?.[0]?.requestId).toBe(RETRY_REQUEST_ID);
    expect(transcript().textContent).toContain("is thinking");
    expect(retryButton()).toBeNull();

    await act(async () => finish());
    expect(await screen.findByText(new RegExp(error))).toBeTruthy();
    expect(rowsWith(PROVIDER_FAILURE_RETRY_PROMPT)).toBe(0);
    expect(transcript().textContent).not.toContain("is thinking");
    expect((await screen.findByRole<HTMLButtonElement>("button", { name: "Retry" })).disabled).toBe(
      false,
    );
  });

  test("Retry is withdrawn when the failure moves on during the check", async () => {
    projectionOptions = { messages: [FAILURE_ROW] };
    const { beforeSend, settle } = heldPreflight();
    const tabId = "failure-retry-stale";
    await renderTab(tabId, "codex", beforeSend);
    fireEvent.click(await screen.findByRole("button", { name: "Retry" }));
    publish(
      tabId,
      [
        FAILURE_ROW,
        {
          id: "other-window",
          createdAt: "2026-11-19T10:01:00.000Z",
          role: "user",
          content: "From another window",
          parts: [{ type: "text", content: "From another window" }],
        },
      ],
      2,
    );
    await waitFor(() => expect(transcript().textContent).toContain("From another window"));

    await act(async () => settle());
    expect(dispatchNativeAgentIntentMock).not.toHaveBeenCalled();
    expect(rowsWith(PROVIDER_FAILURE_RETRY_PROMPT)).toBe(0);
    expect(await screen.findByText(/That failure is no longer current/)).toBeTruthy();
  });

  test("a remount during the Retry check dispatches nothing twice", async () => {
    projectionOptions = { messages: [FAILURE_ROW] };
    const { beforeSend, settle } = heldPreflight();
    const tabId = "failure-retry-remount";
    const first = await renderTab(tabId, "codex", beforeSend);
    fireEvent.click(await screen.findByRole("button", { name: "Retry" }));
    expect(rowsWith(PROVIDER_FAILURE_RETRY_PROMPT)).toBe(1);
    first.unmount();

    await renderTab(tabId, "codex", beforeSend);
    expect(rowsWith(PROVIDER_FAILURE_RETRY_PROMPT)).toBe(0);
    // The check started before the remount answers into a tab that has gone.
    await act(async () => settle());
    expect(dispatchNativeAgentIntentMock).not.toHaveBeenCalled();

    fireEvent.click(await screen.findByRole("button", { name: "Retry" }));
    expect(rowsWith(PROVIDER_FAILURE_RETRY_PROMPT)).toBe(1);
    await act(async () => settle());
    expect(dispatchNativeAgentIntentMock).toHaveBeenCalledTimes(1);
    expect(dispatchNativeAgentIntentMock.mock.calls[0]?.[0]).toMatchObject({
      requestId: RETRY_REQUEST_ID,
    });
  });

  test("Retry in a tab with no preflight dispatches at once", async () => {
    projectionOptions = { messages: [FAILURE_ROW] };
    const tabId = "failure-retry-no-preflight";
    await renderTab(tabId);
    fireEvent.click(await screen.findByRole("button", { name: "Retry" }));
    await waitFor(() => expect(dispatchNativeAgentIntentMock).toHaveBeenCalledTimes(1));
    expect(dispatchNativeAgentIntentMock.mock.calls[0]?.[0]).toMatchObject({
      prompt: PROVIDER_FAILURE_RETRY_PROMPT,
      requestId: RETRY_REQUEST_ID,
      failureSessionId: "codex-session",
    });
    expect(draftFor(tabId)?.text ?? "").toBe("");
  });

  test("Change model opens the composer picker", async () => {
    projectionOptions = {
      messages: [{ ...FAILURE_ROW, content: "Model not available" }],
      twoModels: true,
    };
    await renderTab("failure-model-change");
    fireEvent.click(await screen.findByRole("button", { name: "Change model" }));
    expect(await screen.findByText("Model B")).toBeTruthy();
    expect(dispatchNativeAgentIntentMock).not.toHaveBeenCalled();
  });
});
