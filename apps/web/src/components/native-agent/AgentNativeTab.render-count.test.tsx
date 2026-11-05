/**
 * How environment writes reach the native agent tab.
 *
 * The tab and its composer select only the environment fields they read, so a
 * write to anything else must not render them. These tests count React commits
 * under the tab with a transcript on screen, then pin the reads that a launch
 * depends on: those used to be refreshed by every write to the record, so each
 * case below also covers a field arriving after the tab mounted.
 */
import { afterAll, afterEach, beforeEach, expect, mock, test } from "bun:test";
import { Profiler } from "react";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
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
import { useConfigStore } from "@/stores/configStore";
import { useEnvironmentStore } from "@/stores/environmentStore";
import { useNativeAgentProjectionStore } from "@/stores/nativeAgentProjectionStore";
import { useNativeComposeStore } from "@/stores/nativeComposeStore";
import { usePaneLayoutStore } from "@/stores/paneLayoutStore";
import type { Environment } from "@/types";

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
/** Held by a test so that the tab stays without a projection. */
let ensureGate: Promise<void> | undefined;

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

mock.module("@/lib/backend", () => ({
  ...realBackendSnapshot,
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
  getNativeAgentProjection: async () => null,
  getNativeAgentTranscriptUpdate: async () =>
    ({
      viewVersion: 1,
      status: "snapshot",
      token: `transcript-${served.length}`,
      value: {
        identity,
        freshness: served.length === 0 ? "empty" : "current",
        messages: served,
        historyEpoch: "epoch-1",
        historyComplete: true,
      },
    }) satisfies NativeAgentTranscriptUpdate<NativeMessage>,
  getNativeAgentSessionStateUpdate: async () =>
    ({
      viewVersion: 1,
      status: "snapshot",
      token: "state-1",
      value: {
        identity,
        connection: "connected",
        turn: { phase: "idle" },
        interactions: [],
        composerControls: [],
        capabilities: nativeAgentCapabilities(identity.platform),
        notices: [],
      },
    }) satisfies NativeAgentSessionStateUpdate,
  getNativeAgentDiscoveryUpdate: async () => ({
    viewVersion: 1,
    status: "snapshot",
    token: "discovery-1",
    value: { identity, sections: {} },
  }),
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
  getLocalFileTree: async () => [],
}));

const { AgentNativeTab } = await import("./AgentNativeTab");
const { resetNativeAgentSyncCapabilityForTests } = await import("@/hooks/useNativeAgentSession");

const realClearTabInitialPrompt = usePaneLayoutStore.getState().clearTabInitialPrompt;
const clearTabInitialPromptMock = mock((_tabId: string, _environmentId?: string) => {});
const initialGlobalConfig = useConfigStore.getState().config.global;

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
  ensureGate = undefined;
  resetNativeAgentSyncCapabilityForTests();
  dispatchMock.mockClear();
  ensureMock.mockClear();
  clearTabInitialPromptMock.mockClear();
  useNativeComposeStore.setState({ drafts: new Map() });
  useNativeAgentProjectionStore.getState().reset();
  useEnvironmentStore.setState({ environments: [environment()] });
  usePaneLayoutStore.setState({
    environments: new Map(),
    hydration: new Map(),
    activeEnvironmentId: null,
    clearTabInitialPrompt: clearTabInitialPromptMock,
  });
});

afterEach(() => {
  cleanup();
  useNativeAgentProjectionStore.getState().reset();
  usePaneLayoutStore.setState({ clearTabInitialPrompt: realClearTabInitialPrompt });
  useConfigStore.getState().updateGlobalConfig(initialGlobalConfig);
});

/** Lets pending reads land, until the tab has gone quiet. */
async function settle(): Promise<void> {
  let previous = -1;
  while (previous !== commits) {
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
): Promise<(next: string | undefined) => void> {
  identity = identityFor(tabId);
  const tree = (prompt: string | undefined) => (
    <Profiler
      id="native-tab"
      onRender={() => {
        commits += 1;
      }}
    >
      <AgentNativeTab tabId={tabId} data={data} initialPrompt={prompt} isActive />
    </Profiler>
  );
  const { rerender } = render(tree(initialPrompt));
  await settle();
  expect(commits).toBeGreaterThan(0);
  commits = 0;
  return (next) => rerender(tree(next));
}

function holdSessionCreation(): void {
  ensureGate = new Promise(() => {});
}

/** Writes to env-1 that change only fields the tab does not read. */
async function writeUnrelatedFields(): Promise<void> {
  const store = useEnvironmentStore.getState();
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
    useEnvironmentStore.getState().updateEnvironment("env-1", updates);
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
  useEnvironmentStore.setState({
    environments: [environment(), environment({ id: "env-2", order: 1 })],
  });
  await renderTab(OWN_TAB, lockedTab);

  await act(async () => {
    useEnvironmentStore
      .getState()
      .mergeEnvironmentsForProject("project-1", [
        environment(),
        environment({ id: "env-2", order: 1, status: "stopped" }),
      ]);
  });

  expect(commits).toBe(0);
});

test("the startup session's progress does not render the tab until it fails", async () => {
  useEnvironmentStore.setState({
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
  useEnvironmentStore.setState({
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

test("a startup tab does not connect until setup is ready, whatever else is written", async () => {
  served = [];
  useEnvironmentStore.setState({
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
  useEnvironmentStore.setState({ environments: [] });
  await renderTab(STARTUP_TAB, freshTab);
  expect(ensureMock).not.toHaveBeenCalled();

  await act(async () => {
    useEnvironmentStore.getState().mergeEnvironmentsForProject("project-1", [
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
  useEnvironmentStore.setState({
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

test("launch fields belong to the startup tab, so another tab still sends its own prompt", async () => {
  served = [];
  useEnvironmentStore.setState({
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
  useConfigStore.getState().updateGlobalConfig({
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
