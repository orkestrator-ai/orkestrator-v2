/**
 * How environment writes reach the native agent tab.
 *
 * The tab and its composer select only the environment fields they read, so a
 * write to anything else must not render them. These tests count React commits
 * under the tab with a transcript on screen, then pin the reads that a launch
 * depends on: those used to be refreshed by every write to the record, so each
 * case below also covers a field arriving after the tab mounted. The opening
 * prompt cases also pin when its effect re-runs: not on a render that changes
 * none of the send's inputs, but once each refusal that holds it is released.
 */
import { afterAll, afterEach, beforeEach, expect, mock, test } from "bun:test";
import { FloatingNoticeLayer } from "@/components/ui/floating-notice";
import type { HumanPromptEntry } from "@orkestrator/protocol/human-prompts";
import { Profiler } from "react";
import { act, cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { renderInAppCommandScope } from "@/test/render-in-node-scope";
import type {
  NativeAgentSessionStateUpdate,
  NativeAgentTabData,
  NativeAgentTranscriptUpdate,
  NativeAgentViewIdentity,
} from "@orkestrator/protocol/native-agent";
import { nativeAgentCapabilities } from "@orkestrator/protocol/native-agent";
import * as realVirtualizedMessageList from "@/components/chat/VirtualizedMessageList";
import * as realBackend from "@/lib/backend";
import type { NativeMessage } from "@/lib/chat/native-message-types";
import { configStore } from "@/stores/configStore";
import { environmentStore } from "@/stores/environmentStore";
import { nativeAgentProjectionStore } from "@/stores/nativeAgentProjectionStore";
import { nativeComposeStore } from "@/stores/nativeComposeStore";
import { paneLayoutStore } from "@/stores/paneLayoutStore";
import { createSessionKey } from "@/lib/utils";
import type { Environment } from "@/types";
import { tabInitialPromptRequestId } from "@/lib/tab-initial-prompt";
import type { AgentNativeTabProps } from "./adapter";
import { appCommandStore } from "@/test/app-command-store";

const realBackendSnapshot = { ...realBackend };
const realVirtualizedMessageListSnapshot = { ...realVirtualizedMessageList };

// The virtualizer renders nothing in happy-dom, so the fixture transcript would
// not be on screen. Render its rows directly instead.
mock.module("@/components/chat/VirtualizedMessageList", () => ({
  ...realVirtualizedMessageListSnapshot,
  VirtualizedMessageList: (props: {
    messages: NativeMessage[];
    header?: unknown;
    footer?: unknown;
    computeItemKey: (index: number, message: NativeMessage) => string;
    renderMessage: (
      index: number,
      message: NativeMessage,
      previous: NativeMessage | null,
    ) => unknown;
  }) => (
    <div>
      {props.header as never}
      {props.messages.map((entry, index) => (
        <div key={props.computeItemKey(index, entry)}>
          {
            props.renderMessage(
              index,
              entry,
              index > 0 ? (props.messages[index - 1] ?? null) : null,
            ) as never
          }
        </div>
      ))}
      {props.footer as never}
    </div>
  ),
}));

const OWN_TAB = "tab-render-count";
const STARTUP_TAB = "startup-agent";
const LAUNCH_PROMPT = "Add a dark mode toggle";

function identityFor(tabId: string): NativeAgentViewIdentity {
  return {
    backendInstanceId: "backend-1",
    environmentId: "env-1",
    platform: "codex",
    logicalSessionKey: `env-env-1:${tabId}`,
    providerSessionId: "codex-session",
    sourceGeneration: "generation-1",
  };
}

const transcript: NativeMessage[] = Array.from({ length: 40 }, (_, index) => ({
  id: `row-${index}`,
  role: "assistant",
  content: `Fixture row ${index}`,
  createdAt: "2026-11-05T00:00:00.000Z",
  parts: [{ type: "text", content: `Fixture row ${index}` }],
}));

let identity = identityFor(OWN_TAB);
let served: NativeMessage[] = transcript;
let humanPrompts: HumanPromptEntry[] = [];
/** Held by a test so that the tab stays without a projection. */
let ensureGate: Promise<void> | undefined;

/** What the tab's progressive reads send: a background poll names the token it holds. */
interface ReadInput {
  knownToken?: string;
  forceSnapshot?: boolean;
}

/**
 * Answers a read the way the backend does: `unchanged` when the caller already
 * holds the current token, a snapshot otherwise. Re-sending an identical
 * snapshot on every background poll (each 500-1500 ms) commits the tab, so on a
 * loaded host a poll could land inside a render-count measurement.
 */
function unchangedOr<T>(
  input: ReadInput,
  token: string,
  snapshot: (token: string) => T,
): T | { viewVersion: 1; status: "unchanged"; token: string; identity: NativeAgentViewIdentity } {
  return input.knownToken === token && !input.forceSnapshot
    ? { viewVersion: 1, status: "unchanged", token, identity }
    : snapshot(token);
}

const dispatchMock = mock(async (input: { requestId: string }) => ({
  outcome: "accepted" as const,
  requestId: input.requestId,
}));
const ensureMock = mock(async (_input: Record<string, unknown>) => {
  await ensureGate;
  return {
    providerSessionId: identity.providerSessionId,
    logicalSessionKey: identity.logicalSessionKey,
    environmentId: identity.environmentId,
    agent: identity.platform,
  };
});
const getLocalFileTreeMock = mock(async (_worktreePath: string) => [
  { name: "image.png", path: "src/image.png", isDirectory: false },
]);
/** Queue items the session state carries; empty for every case but one. */
let queuedItems: Array<{ id: string; text: string }> = [];
const removeQueuedMock = mock(async (..._args: unknown[]) => {});
const runUserCommandMock = mock(async (_input: Record<string, unknown>) => ({}));

mock.module("@/lib/backend", () => ({
  ...realBackendSnapshot,
  listHumanPrompts: async () => ({ prompts: humanPrompts }),
  getNativeAgentSyncCapabilities: async () => ({
    projectionSyncVersions: [1],
    historyPagingVersions: [1],
    progressiveViewVersions: [1],
  }),
  ensureNativeAgentSession: ensureMock,
  adoptNativeAgentSession: async () => ({}),
  getNativeAgentAuthStatus: async () => ({ state: "ready" }),
  getAgentAccountLogin: async () => ({ state: "idle" }),
  listAgentAccounts: async () => ({
    accounts: [],
    active: { claude: "default", codex: "default" },
  }),
  getNativeAgentTranscriptUpdate: async (input: ReadInput) =>
    unchangedOr(input, `transcript-${identity.logicalSessionKey}-${served.length}`, (token) => ({
      viewVersion: 1,
      status: "snapshot",
      token,
      value: {
        identity,
        freshness: served.length === 0 ? "empty" : "current",
        messages: served,
        historyEpoch: "epoch-1",
        historyComplete: true,
      },
    })) satisfies NativeAgentTranscriptUpdate<NativeMessage>,
  getNativeAgentSessionStateUpdate: async (input: ReadInput) =>
    unchangedOr(
      input,
      `state-${identity.logicalSessionKey}-${JSON.stringify(queuedItems)}`,
      (token) => ({
        viewVersion: 1,
        status: "snapshot",
        token,
        value: {
          identity,
          connection: "connected",
          turn: { phase: "idle" },
          interactions: [],
          composerControls: [],
          composer: {
            models: [{ platform: "codex", id: "gpt-5.4", label: "GPT-5.4" }],
            selectedModelId: "gpt-5.4",
            fastModeEnabled: null,
            fastModeAvailable: false,
            modes: [],
          },
          capabilities: nativeAgentCapabilities(identity.platform),
          notices: [],
          ...(queuedItems.length > 0 ? { queue: { items: queuedItems } } : {}),
        },
      }),
    ) satisfies NativeAgentSessionStateUpdate,
  getNativeAgentDiscoveryUpdate: async (input: ReadInput) =>
    unchangedOr(input, `discovery-${identity.logicalSessionKey}`, (token) => ({
      viewVersion: 1,
      status: "snapshot",
      token,
      value: { identity, sections: {} },
    })),
  getAgentHandoff: async () => null,
  dispatchNativeAgentIntent: dispatchMock,
  getNativeAgentModelCatalog: async (_environmentId: string, platform: string) =>
    [
      { platform: "claude", id: "claude-sonnet-5", label: "Claude Sonnet" },
      { platform: "codex", id: "gpt-5.4", label: "GPT-5.4" },
      { platform: "codex", id: "o3", label: "o3" },
    ].filter((model) => model.platform === platform),
  listNativeAgentResumableSessions: async () => [],
  getFileTree: async () => [],
  getLocalFileTree: getLocalFileTreeMock,
  removePromptQueueMessage: removeQueuedMock,
  runUserCommand: runUserCommandMock,
  listUserCommands: async () => ({ commands: [] }),
}));

const { AgentNativeTab } = await import("./AgentNativeTab");
const { resetNativeAgentSyncCapabilityForTests } = await import("@/hooks/useNativeAgentSession");

const realClearTabInitialPrompt = appCommandStore(paneLayoutStore).getState().clearTabInitialPrompt;
const clearTabInitialPromptMock = mock((_tabId: string, _environmentId?: string) => {});
const initialGlobalConfig = appCommandStore(configStore).getState().config.global;
const initialRepositories = appCommandStore(configStore).getState().config.repositories;

afterAll(() => {
  resetNativeAgentSyncCapabilityForTests();
  mock.module("@/lib/backend", () => realBackendSnapshot);
  mock.module("@/components/chat/VirtualizedMessageList", () => realVirtualizedMessageListSnapshot);
});

function environment(overrides: Partial<Environment> = {}): Environment {
  return {
    id: "env-1",
    projectId: "project-1",
    name: "one",
    branch: "main",
    containerId: "container-1",
    status: "running",
    prUrl: null,
    prState: null,
    hasMergeConflicts: null,
    createdAt: "2024-01-01T00:00:00.000Z",
    networkAccessMode: "restricted",
    order: 0,
    environmentType: "containerized",
    setupPhase: "ready",
    worktreePath: "/workspace/one",
    agentSettings: { defaultAgent: "codex" },
    ...overrides,
  } as Environment;
}

function startupSession(
  overrides: Partial<NonNullable<Environment["startupAgentSession"]>> = {},
): NonNullable<Environment["startupAgentSession"]> {
  return { tabId: STARTUP_TAB, agent: "codex", style: "native", status: "starting", ...overrides };
}

const lockedTab: NativeAgentTabData = {
  platform: "codex",
  environmentId: "env-1",
  containerId: "container-1",
  sessionId: "codex-session",
  isLocal: false,
};
/** A tab with no session yet, so reaching the backend is a visible event. */
const freshTab: NativeAgentTabData = {
  platform: "codex",
  environmentId: "env-1",
  containerId: "container-1",
  isLocal: false,
};
const unassignedTab: NativeAgentTabData = { environmentId: "env-1" };

let commits = 0;

beforeEach(() => {
  commits = 0;
  identity = identityFor(OWN_TAB);
  served = transcript;
  humanPrompts = [];
  ensureGate = undefined;
  queuedItems = [];
  resetNativeAgentSyncCapabilityForTests();
  removeQueuedMock.mockReset();
  runUserCommandMock.mockReset();
  dispatchMock.mockClear();
  ensureMock.mockClear();
  getLocalFileTreeMock.mockClear();
  clearTabInitialPromptMock.mockClear();
  appCommandStore(nativeComposeStore).setState({ drafts: new Map() });
  appCommandStore(nativeAgentProjectionStore).getState().reset();
  appCommandStore(environmentStore).setState({ environments: [environment()] });
  appCommandStore(paneLayoutStore).setState({
    environments: new Map(),
    hydration: new Map(),
    activeEnvironmentId: null,
    clearTabInitialPrompt: clearTabInitialPromptMock,
  });
});

afterEach(() => {
  cleanup();
  appCommandStore(nativeAgentProjectionStore).getState().reset();
  appCommandStore(paneLayoutStore).setState({ clearTabInitialPrompt: realClearTabInitialPrompt });
  appCommandStore(configStore).getState().updateGlobalConfig(initialGlobalConfig);
  appCommandStore(configStore).setState((state) => ({
    config: { ...state.config, repositories: initialRepositories },
  }));
});

/**
 * A chat shell renders once more `CHAT_COLUMN_SHIFT_SETTLE_MS` after it
 * mounts, to turn its column slide on (`useChatColumnShiftStyle`). Until then
 * its root carries a zero slide duration. A quiet 40 ms interval can end
 * before that timer fires, and its commit then lands inside the next
 * measurement, so settling also waits for every mounted shell to finish.
 */
function chatShellSettling(): boolean {
  return Array.from(document.querySelectorAll<HTMLElement>("[style]")).some(
    (element) => element.style.getPropertyValue("--chat-column-shift-duration") === "0ms",
  );
}

/** Lets pending reads land, until the tab has gone quiet. */
async function settle(): Promise<void> {
  let previous = -1;
  while (previous !== commits || chatShellSettling()) {
    previous = commits;
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 40));
    });
  }
}

/** Mounts the tab and returns how to change its `initialPrompt` prop. */
async function renderTab(
  tabId: string,
  data: NativeAgentTabData,
  initialPrompt?: string,
  props: Pick<AgentNativeTabProps, "beforeSend"> = {},
  floating = false,
): Promise<(next: string | undefined) => void> {
  identity = identityFor(tabId);
  const tree = (prompt: string | undefined) => (
    <Profiler
      id="native-tab"
      onRender={() => {
        commits += 1;
      }}
    >
      <AgentNativeTab tabId={tabId} data={data} initialPrompt={prompt} isActive {...props} />
    </Profiler>
  );
  const wrapped = (prompt: string | undefined) =>
    floating ? (
      <FloatingNoticeLayer columnRem={56}>{tree(prompt)}</FloatingNoticeLayer>
    ) : (
      tree(prompt)
    );
  const { rerender } = renderInAppCommandScope(wrapped(initialPrompt));
  await settle();
  expect(commits).toBeGreaterThan(0);
  commits = 0;
  return (next) => rerender(wrapped(next));
}

function holdSessionCreation(): void {
  ensureGate = new Promise(() => {});
}

/** Writes to env-1 that change only fields the tab does not read. */
async function writeUnrelatedFields(): Promise<void> {
  const store = appCommandStore(environmentStore).getState();
  await act(async () => {
    store.updateEnvironment("env-1", {
      lastActivityAt: "2024-01-02T00:00:00.000Z",
      name: "renamed",
    });
    store.updateEnvironmentStatus("env-1", "stopping");
    store.setEnvironmentPR("env-1", "https://example.com/pr/1", "open", false);
    // A snapshot decodes new objects for every nested field it carries.
    store.mergeEnvironmentsForProject("project-1", [
      structuredClone({
        ...store.getEnvironmentById("env-1")!,
        status: "running" as const,
        prUrl: "https://example.com/pr/2",
      }),
    ]);
  });
}

async function writeEnvironment(updates: Partial<Environment>): Promise<void> {
  await act(async () => {
    appCommandStore(environmentStore).getState().updateEnvironment("env-1", updates);
  });
}

function dispatchedRequestIds(): string[] {
  return dispatchMock.mock.calls.map(([input]) => input.requestId);
}

test("an unrelated environment field does not render a tab holding a transcript", async () => {
  await renderTab(OWN_TAB, lockedTab);
  expect(screen.getByText("Fixture row 39")).toBeTruthy();

  await writeUnrelatedFields();

  expect(commits).toBe(0);
});

test("another environment in the project does not render the tab", async () => {
  appCommandStore(environmentStore).setState({
    environments: [environment(), environment({ id: "env-2", order: 1 })],
  });
  await renderTab(OWN_TAB, lockedTab);

  await act(async () => {
    appCommandStore(environmentStore)
      .getState()
      .mergeEnvironmentsForProject("project-1", [
        environment(),
        environment({ id: "env-2", order: 1, status: "stopped" }),
      ]);
  });

  expect(commits).toBe(0);
});

test("the startup session's progress does not render the tab until it fails", async () => {
  appCommandStore(environmentStore).setState({
    environments: [environment({ startupAgentSession: startupSession() })],
  });
  await renderTab(OWN_TAB, lockedTab);

  await writeEnvironment({
    startupAgentSession: startupSession({ status: "running", providerSessionId: "codex-session" }),
  });
  expect(commits).toBe(0);

  await writeEnvironment({ startupAgentSession: startupSession({ status: "error" }) });
  expect(commits).toBeGreaterThan(0);
});

test.each<[string, Partial<Environment>]>([
  ["projectId", { projectId: "project-2" }],
  ["worktreePath", { worktreePath: "/workspace/two" }],
  ["agentSettings", { agentSettings: { defaultAgent: "claude" } }],
  ["initialPrompt", { initialPrompt: LAUNCH_PROMPT }],
  ["pendingAgentLaunch", { pendingAgentLaunch: true }],
  ["startupAgentSession", { startupAgentSession: startupSession() }],
])("a write to %s still renders the tab", async (_field, updates) => {
  await renderTab(OWN_TAB, lockedTab);

  await writeEnvironment(updates);

  expect(commits).toBeGreaterThan(0);
});

test("setup starting and finishing still swaps the tab's overlay", async () => {
  await renderTab(OWN_TAB, lockedTab);

  await writeEnvironment({ setupPhase: "running" });
  expect(screen.getByText("Waiting for setup scripts to complete...")).toBeTruthy();
  expect(screen.queryByText("Fixture row 39") === null).toBe(true);

  await writeEnvironment({ setupPhase: "ready" });
  await settle();
  expect(screen.getByText("Fixture row 39")).toBeTruthy();
});

test("settings that arrive during setup reach the session the tab creates", async () => {
  served = [];
  appCommandStore(environmentStore).setState({
    environments: [environment({ setupPhase: "running", agentSettings: undefined })],
  });
  await renderTab(OWN_TAB, freshTab);
  expect(ensureMock).not.toHaveBeenCalled();

  // Not the catalogue's first model, which the tab would pick with no settings.
  await writeEnvironment({ agentSettings: { platforms: { codex: { model: "o3" } } } });
  expect(ensureMock).not.toHaveBeenCalled();

  await writeEnvironment({ setupPhase: "ready" });
  await waitFor(() => expect(ensureMock).toHaveBeenCalled());
  expect(ensureMock.mock.calls.at(-1)?.[0]).toMatchObject({ model: "o3" });
});

test("a project arriving during setup supplies the repository settings for session creation", async () => {
  served = [];
  for (const [projectId, model] of [
    ["project-1", "gpt-5.4"],
    ["project-2", "o3"],
  ] as const) {
    appCommandStore(configStore)
      .getState()
      .setRepositoryConfig(projectId, {
        defaultBranch: "main",
        prBaseBranch: "main",
        agentSettings: { platforms: { codex: { model } } },
      });
  }
  appCommandStore(environmentStore).setState({
    environments: [environment({ setupPhase: "running", projectId: undefined })],
  });
  await renderTab(OWN_TAB, freshTab);
  expect(ensureMock).not.toHaveBeenCalled();

  await writeEnvironment({ projectId: "project-1" });
  await writeEnvironment({ projectId: "project-2" });
  await writeEnvironment({ setupPhase: "ready" });

  await waitFor(() => expect(ensureMock).toHaveBeenCalled());
  expect(ensureMock.mock.calls.at(-1)?.[0]).toMatchObject({ model: "o3" });
});

test("a startup tab does not connect until setup is ready, whatever else is written", async () => {
  served = [];
  appCommandStore(environmentStore).setState({
    environments: [
      environment({
        setupPhase: "running",
        pendingAgentLaunch: true,
        initialPrompt: LAUNCH_PROMPT,
      }),
    ],
  });
  await renderTab(STARTUP_TAB, freshTab);
  expect(screen.getByTestId("setup-pending-prompt").textContent).toContain(LAUNCH_PROMPT);

  await writeUnrelatedFields();
  expect(ensureMock).not.toHaveBeenCalled();
  expect(commits).toBe(0);

  await writeEnvironment({ setupPhase: "ready" });
  await waitFor(() => expect(ensureMock).toHaveBeenCalled());
  await settle();
  expect(dispatchMock).not.toHaveBeenCalled();
});

test("a startup tab waits for an environment record that arrives after it mounts", async () => {
  served = [];
  appCommandStore(environmentStore).setState({ environments: [] });
  await renderTab(STARTUP_TAB, freshTab);
  expect(ensureMock).not.toHaveBeenCalled();

  await act(async () => {
    appCommandStore(environmentStore)
      .getState()
      .mergeEnvironmentsForProject("project-1", [
        environment({
          pendingAgentLaunch: true,
          initialPrompt: LAUNCH_PROMPT,
          startupAgentSession: startupSession(),
        }),
      ]);
  });

  expect(await screen.findByText(LAUNCH_PROMPT)).toBeTruthy();
  await waitFor(() => expect(ensureMock).toHaveBeenCalled());
  await settle();
  expect(dispatchMock).not.toHaveBeenCalled();
});

test("a launch published after mount previews its prompt and leaves dispatch to the backend", async () => {
  served = [];
  holdSessionCreation();
  await renderTab(STARTUP_TAB, freshTab);
  expect(screen.queryByText(LAUNCH_PROMPT) === null).toBe(true);

  // The flag alone has no prompt to show; the prompt can land in a later write.
  await writeEnvironment({ pendingAgentLaunch: true, startupAgentSession: startupSession() });
  expect(screen.queryByText(LAUNCH_PROMPT) === null).toBe(true);

  await writeEnvironment({ initialPrompt: LAUNCH_PROMPT });
  expect(await screen.findByText(LAUNCH_PROMPT)).toBeTruthy();

  commits = 0;
  await writeUnrelatedFields();
  expect(commits).toBe(0);

  // Dispatch returned: the flags clear before the echo is read, so the prompt
  // stays on screen through that gap.
  await writeEnvironment({ pendingAgentLaunch: false, startupAgentSession: undefined });
  expect(screen.getByText(LAUNCH_PROMPT)).toBeTruthy();
  expect(dispatchMock).not.toHaveBeenCalled();
});

test("a failed launch retires its preview only once the launch is no longer pending", async () => {
  served = [];
  holdSessionCreation();
  appCommandStore(environmentStore).setState({
    environments: [
      environment({
        pendingAgentLaunch: true,
        initialPrompt: LAUNCH_PROMPT,
        startupAgentSession: startupSession(),
      }),
    ],
  });
  await renderTab(STARTUP_TAB, freshTab);
  expect(screen.getByText(LAUNCH_PROMPT)).toBeTruthy();

  await writeEnvironment({ startupAgentSession: startupSession({ status: "error" }) });
  expect(screen.getByText(LAUNCH_PROMPT)).toBeTruthy();

  await writeEnvironment({ pendingAgentLaunch: false });
  await waitFor(() => expect(screen.queryByText(LAUNCH_PROMPT) === null).toBe(true));
  expect(dispatchMock).not.toHaveBeenCalled();
});

test("a launch arriving before the session takes the tab's prompt, once, without sending it", async () => {
  served = [];
  holdSessionCreation();
  const setInitialPrompt = await renderTab(STARTUP_TAB, freshTab, LAUNCH_PROMPT);
  expect(clearTabInitialPromptMock).not.toHaveBeenCalled();

  await writeEnvironment({ pendingAgentLaunch: true });
  expect(clearTabInitialPromptMock).toHaveBeenCalledTimes(1);
  expect(clearTabInitialPromptMock).toHaveBeenCalledWith(STARTUP_TAB, "env-1");

  // What the real store does with that call.
  await act(async () => setInitialPrompt(undefined));
  await writeUnrelatedFields();
  expect(clearTabInitialPromptMock).toHaveBeenCalledTimes(1);
  expect(dispatchMock).not.toHaveBeenCalled();
});

test("a startup session with no pending flag still makes the launch the backend's", async () => {
  served = [];
  holdSessionCreation();
  await renderTab(STARTUP_TAB, freshTab, LAUNCH_PROMPT);

  await writeEnvironment({ startupAgentSession: startupSession({ status: "running" }) });

  expect(clearTabInitialPromptMock).toHaveBeenCalledTimes(1);
  expect(dispatchMock).not.toHaveBeenCalled();
});

test("a tab's own opening prompt is sent once, whatever writes surround it", async () => {
  served = [];
  await renderTab(OWN_TAB, freshTab, LAUNCH_PROMPT);
  await waitFor(() => expect(dispatchMock).toHaveBeenCalledTimes(1));
  const [requestId] = dispatchedRequestIds();

  await writeUnrelatedFields();
  await settle();

  expect(dispatchedRequestIds()).toEqual([requestId!]);
});

test("a render that changes none of the send's inputs does not re-run the opening-prompt effect", async () => {
  served = [];
  holdSessionCreation();
  // A backend-owned launch clears the tab's prompt each time the effect runs;
  // the mock leaves the prop in place, so every re-run is counted.
  appCommandStore(environmentStore).setState({
    environments: [environment({ startupAgentSession: startupSession({ status: "running" }) })],
  });
  await renderTab(STARTUP_TAB, freshTab, LAUNCH_PROMPT);
  const runs = clearTabInitialPromptMock.mock.calls.length;
  expect(runs).toBeGreaterThan(0);

  await writeEnvironment({ worktreePath: "/workspace/two" });
  await settle();
  expect(commits).toBeGreaterThan(0);

  expect(clearTabInitialPromptMock).toHaveBeenCalledTimes(runs);
});

/** Puts text in the tab's draft and presses Enter in its composer. */
async function sendFromComposer(tabId: string, text: string): Promise<void> {
  await act(async () => {
    appCommandStore(nativeComposeStore)
      .getState()
      .updateDraft(createSessionKey("env-1", tabId), { text });
  });
  await act(async () => {
    fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter" });
  });
}

function deferred(): {
  promise: Promise<void>;
  resolve: () => void;
  reject: (error: Error) => void;
} {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const openingRequestId = tabInitialPromptRequestId("env-1", OWN_TAB);

/** The opening prompt arrives while a refusal holds, then waits for its release. */
async function expectOpeningPromptWaitsFor(
  setInitialPrompt: (next: string | undefined) => void,
  release: () => void,
): Promise<void> {
  await act(async () => setInitialPrompt(LAUNCH_PROMPT));
  await settle();
  expect(dispatchedRequestIds()).not.toContain(openingRequestId);

  await act(async () => release());
  await waitFor(() => expect(dispatchedRequestIds()).toContain(openingRequestId));
  await settle();
  expect(dispatchedRequestIds().filter((id) => id === openingRequestId)).toHaveLength(1);
}

test("an opening prompt refused during a pre-send check is sent once the check ends", async () => {
  const check = deferred();
  const beforeSend = mock(async () => {
    await check.promise;
    return false;
  });
  const setInitialPrompt = await renderTab(OWN_TAB, lockedTab, undefined, { beforeSend });
  await sendFromComposer(OWN_TAB, "Typed while the opening prompt arrives");
  await waitFor(() => expect(beforeSend).toHaveBeenCalledTimes(1));

  await expectOpeningPromptWaitsFor(setInitialPrompt, () => check.resolve());
});

test("an opening prompt refused during another send is sent once that send ends", async () => {
  const command = deferred();
  runUserCommandMock.mockImplementation(async () => {
    await command.promise;
    return {};
  });
  const setInitialPrompt = await renderTab(OWN_TAB, lockedTab);
  await sendFromComposer(OWN_TAB, "!ls");
  await waitFor(() => expect(runUserCommandMock).toHaveBeenCalledTimes(1));

  await expectOpeningPromptWaitsFor(setInitialPrompt, () =>
    command.reject(new Error("command refused")),
  );
});

test("an opening prompt refused during a queue edit is sent once the edit ends", async () => {
  queuedItems = [{ id: "queued-1", text: "Queued task" }];
  const removal = deferred();
  removeQueuedMock.mockImplementation(async () => {
    await removal.promise;
  });
  const setInitialPrompt = await renderTab(OWN_TAB, lockedTab);
  await act(async () => {
    fireEvent.click(await screen.findByRole("button", { name: "Edit queued prompt 1 of 1" }));
  });
  await waitFor(() => expect(removeQueuedMock).toHaveBeenCalledTimes(1));

  await expectOpeningPromptWaitsFor(setInitialPrompt, () =>
    removal.reject(new Error("queue unavailable")),
  );
});

test("launch fields belong to the startup tab, so another tab still sends its own prompt", async () => {
  served = [];
  appCommandStore(environmentStore).setState({
    environments: [
      environment({
        pendingAgentLaunch: true,
        initialPrompt: "The backend's prompt",
        startupAgentSession: startupSession(),
      }),
    ],
  });
  await renderTab(OWN_TAB, freshTab, LAUNCH_PROMPT);

  await waitFor(() => expect(dispatchMock).toHaveBeenCalledTimes(1));
  expect(screen.queryByText("The backend's prompt") === null).toBe(true);
});

test("an unrelated environment field does not render the unassigned composer", async () => {
  await renderTab(OWN_TAB, unassignedTab);

  await writeUnrelatedFields();

  expect(commits).toBe(0);
});

test.each<[string, Partial<Environment>]>([
  ["projectId", { projectId: "project-2" }],
  ["worktreePath", { worktreePath: "/workspace/two" }],
  ["environmentType", { environmentType: "local" }],
  ["networkAccessMode", { networkAccessMode: "full" }],
])("a write to %s still renders the unassigned composer", async (_field, updates) => {
  await renderTab(OWN_TAB, unassignedTab);

  await writeEnvironment(updates);

  expect(commits).toBeGreaterThan(0);
});

test("the unassigned composer still follows the environment's default agent", async () => {
  appCommandStore(configStore)
    .getState()
    .updateGlobalConfig({
      enabledAgentPlatforms: ["claude", "codex"],
    });
  await renderTab(OWN_TAB, unassignedTab);
  await waitFor(() =>
    expect(document.querySelector("[data-native-model-platform='codex']")).toBeTruthy(),
  );

  await writeEnvironment({ agentSettings: { defaultAgent: "claude" } });

  await waitFor(() =>
    expect(document.querySelector("[data-native-model-platform='claude']")).toBeTruthy(),
  );
});

test.each(["environmentType", "networkAccessMode"] as const)(
  "%s arriving after mount updates the composer's sandbox policy description",
  async (field) => {
    appCommandStore(configStore)
      .getState()
      .updateGlobalConfig({ enabledAgentPlatforms: ["codex"] });
    appCommandStore(environmentStore).setState({
      environments: [
        environment({
          environmentType: field === "environmentType" ? undefined : "containerized",
          agentSettings: {
            defaultAgent: "codex",
            executionPolicy: { networkAccess: "restricted" },
          },
        }),
      ],
    });
    await renderTab(OWN_TAB, unassignedTab);
    fireEvent.pointerDown(await screen.findByTestId("launch-approval-mode-picker"));
    const description = () =>
      screen.getByRole("menuitemradio", { name: "On request" }).getAttribute("title");
    await screen.findByRole("menuitemradio", { name: "On request" });
    if (field === "environmentType") {
      expect(description()).toContain("asks before stepping outside");
      await writeEnvironment({ environmentType: "containerized" });
      expect(description()).toContain("never asks; choose Untrusted");
    } else {
      expect(description()).toContain("never asks; choose Untrusted");
      await writeEnvironment({ networkAccessMode: "full" });
      expect(description()).toContain("asks before stepping outside");
    }
  },
);

test.each(["locked", "unassigned"] as const)(
  "a worktree path arriving after mount updates %s file search and attachment resolution",
  async (kind) => {
    appCommandStore(environmentStore).setState({
      environments: [environment({ environmentType: "local", worktreePath: undefined })],
    });
    await renderTab(
      OWN_TAB,
      kind === "locked" ? { ...lockedTab, containerId: undefined, isLocal: true } : unassignedTab,
    );
    expect(getLocalFileTreeMock).not.toHaveBeenCalled();

    for (const worktreePath of ["/workspace/one", "/workspace/two"]) {
      getLocalFileTreeMock.mockClear();
      await writeEnvironment({ worktreePath });
      await waitFor(() => expect(getLocalFileTreeMock).toHaveBeenCalledWith(worktreePath));
      fireEvent.pointerDown(screen.getByRole("button", { name: "Add attachment" }));
      fireEvent.click(await screen.findByRole("menuitem", { name: "Attach file from workspace" }));
      await act(async () => {
        fireEvent.click(await screen.findByRole("button", { name: /image.png/ }));
      });
      await waitFor(() => {
        const draft = appCommandStore(nativeComposeStore)
          .getState()
          .drafts.get(createSessionKey("env-1", OWN_TAB));
        expect(draft?.attachments.at(-1)).toMatchObject({
          type: "image",
          path: `${worktreePath}/src/image.png`,
        });
      });
    }
  },
);

test("anchor resize does not render the native controller", async () => {
  const originalObserver = globalThis.ResizeObserver;
  const originalRect = HTMLElement.prototype.getBoundingClientRect;
  let width = 1600;
  const callbacks = new Set<() => void>();
  globalThis.ResizeObserver = class {
    constructor(callback: ResizeObserverCallback) {
      callbacks.add(() => callback([], this as unknown as ResizeObserver));
    }
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
  HTMLElement.prototype.getBoundingClientRect = function () {
    return { width, height: 800, top: 0, bottom: 800, left: 0, right: width } as DOMRect;
  };
  try {
    await renderTab(OWN_TAB, lockedTab, undefined, {}, true);
    commits = 0;
    await act(async () => {
      width = 800;
      for (const callback of callbacks) callback();
    });
    expect(commits).toBe(0);
  } finally {
    globalThis.ResizeObserver = originalObserver;
    HTMLElement.prototype.getBoundingClientRect = originalRect;
  }
});

test.each([false, true])(
  "agent prompts render once in the correct location (floating=%s)",
  async (floating) => {
    humanPrompts = [
      {
        id: "prompt-floating",
        environmentId: "env-1",
        tabId: OWN_TAB,
        source: "agent-tool",
        since: "2026-11-06T00:00:00Z",
        command: "gh auth login",
        prompt: {
          kind: "device-code",
          url: "https://github.com/login/device",
          code: "AAAA-BBBB",
          wantsEnter: false,
          text: "Enter the code",
          key: "device",
        },
      },
    ];
    await renderTab(OWN_TAB, lockedTab, undefined, {}, floating);
    const card = await screen.findByRole("status", { name: "Waiting for you" });
    expect(screen.getAllByRole("status", { name: "Waiting for you" })).toHaveLength(1);
    expect(Boolean(card.closest("[data-floating-notice-stack]"))).toBe(floating);
    expect(card.textContent).toContain("AAAA-BBBB");
  },
);
