import { afterEach, describe, test, expect, mock, beforeEach } from "bun:test";
import { act, cleanup, render, fireEvent, screen, waitFor } from "@testing-library/react";
import { Profiler } from "react";
import type { Environment } from "../../../apps/web/src/types";
import {
  mockToastError as toastErrorMock,
  mockToastSuccess as toastSuccessMock,
} from "../../mocks/sonner";

type SettingsDialogProps = {
  open: boolean;
  environment: Environment;
  onUpdate: (environment: Environment) => void;
};

const settingsDialogPropsMock = mock((_props: SettingsDialogProps) => {});

// Mock UI components that require providers.
// NOTE: @/components/ui/tooltip is already mocked by StatusIndicator.test.tsx
// with data-testid="tooltip-content". We re-use that shape here so both files
// share the same mock regardless of test execution order.
mock.module("@/components/ui/tooltip", () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="tooltip-content">{children}</div>
  ),
}));

mock.module("@/components/ui/context-menu", () => ({
  ContextMenu: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  ContextMenuTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  ContextMenuContent: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="context-menu-content">{children}</div>
  ),
  ContextMenuItem: ({
    children,
    disabled,
    onClick,
    onSelect,
  }: {
    children: React.ReactNode;
    disabled?: boolean;
    onClick?: () => void;
    onSelect?: () => void;
  }) => (
    <div
      role="menuitem"
      aria-disabled={disabled ? "true" : undefined}
      onClick={disabled ? undefined : () => {
        onClick?.();
        onSelect?.();
      }}
    >
      {children}
    </div>
  ),
  ContextMenuSeparator: () => <hr />,
}));

mock.module("@/components/ui/alert-dialog", () => ({
  AlertDialog: ({ children, open }: { children: React.ReactNode; open?: boolean }) => (
    open ? <>{children}</> : null
  ),
  AlertDialogAction: ({
    children,
    onClick,
  }: {
    children: React.ReactNode;
    onClick?: () => void;
  }) => <button onClick={onClick}>{children}</button>,
  AlertDialogCancel: ({ children }: { children: React.ReactNode }) => <button>{children}</button>,
  AlertDialogContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  AlertDialogDescription: ({ children }: { children: React.ReactNode }) => <p>{children}</p>,
  AlertDialogFooter: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  AlertDialogHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  AlertDialogTitle: ({ children }: { children: React.ReactNode }) => <h2>{children}</h2>,
}));

mock.module("@/components/ui/checkbox", () => ({
  Checkbox: ({
    checked,
    onCheckedChange,
    className,
  }: {
    checked?: boolean;
    onCheckedChange?: (checked: boolean) => void;
    className?: string;
  }) => (
    <input
      type="checkbox"
      aria-label="Select environment"
      className={className}
      checked={checked ?? false}
      onChange={(event) => onCheckedChange?.(event.target.checked)}
    />
  ),
}));

// The stub exposes the two update shapes the real dialog can emit, so the
// component's own transitioning bookkeeping can be driven from a test.
mock.module("@/components/environments/EnvironmentSettingsDialog", () => ({
  EnvironmentSettingsDialog: (props: SettingsDialogProps) => {
    settingsDialogPropsMock(props);
    return props.open ? (
      <div data-testid="settings-dialog">
        <button
          type="button"
          onClick={() => props.onUpdate({ ...props.environment, status: "creating" })}
        >
          Emit transitioning update
        </button>
        <button
          type="button"
          onClick={() => props.onUpdate({ ...props.environment, status: "running" })}
        >
          Emit settled update
        </button>
      </div>
    ) : null;
  },
}));

mock.module("@/lib/backend", () => ({
  getEnvironments: async () => [],
  getEnvironment: async () => null,
  startEnvironment: async () => ({}),
  stopEnvironment: async () => {},
  createEnvironment: async () => ({}),
  deleteEnvironment: async () => {},
  recreateEnvironment: async () => {},
  updateEnvironmentStatus: async () => ({}),
  getContainerDiffStats: async () => null,
  getLocalDiffStats: async () => null,
  openInBrowser: async () => {},
  readFileBase64: async () => "",
}));

import {
  EnvironmentItem,
  resolveEnvironmentAgentActivity,
} from "../../../apps/web/src/components/environments/EnvironmentItem";
import { useAgentActivityStore } from "../../../apps/web/src/stores/agentActivityStore";
import { useBuildPipelineStore } from "../../../apps/web/src/stores/buildPipelineStore";
import { useEnvironmentDiffStore } from "../../../apps/web/src/stores/environmentDiffStore";
import { useEnvironmentStore } from "../../../apps/web/src/stores/environmentStore";
import { useUIStore } from "../../../apps/web/src/stores/uiStore";

function makeEnvironment(overrides: Partial<Environment> = {}): Environment {
  return {
    id: "env-1",
    projectId: "project-1",
    name: "test-env",
    branch: "main",
    containerId: "container-1",
    status: "running",
    prUrl: null,
    prState: null,
    hasMergeConflicts: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    networkAccessMode: "restricted",
    order: 0,
    environmentType: "containerized",
    ...overrides,
  };
}

const noopSelect = () => {};
const noopEnvironmentHandler = () => {};

type RenderOptions = {
  isSelected?: boolean;
  isMultiSelectMode?: boolean;
  isChecked?: boolean;
  onSelect?: (environmentId: string, modifiers?: { shiftKey?: boolean; metaKey?: boolean }) => void;
  onDelete?: (environmentId: string) => void;
  onStart?: (environmentId: string) => void;
  onStop?: (environmentId: string) => void;
  onRestart?: (environmentId: string) => void;
  onUpdate?: (environment: Environment) => void;
};

function itemElement(env: Environment, options: RenderOptions = {}) {
  return (
    <EnvironmentItem
      environment={env}
      isSelected={options.isSelected ?? false}
      onSelect={options.onSelect ?? noopSelect}
      onDelete={options.onDelete ?? noopEnvironmentHandler}
      onStart={options.onStart ?? noopEnvironmentHandler}
      onStop={options.onStop ?? noopEnvironmentHandler}
      onRestart={options.onRestart ?? noopEnvironmentHandler}
      onUpdate={options.onUpdate}
      isMultiSelectMode={options.isMultiSelectMode}
      isChecked={options.isChecked}
    />
  );
}

function renderItem(env: Environment, options: RenderOptions = {}) {
  return render(itemElement(env, options));
}

function findMenuItem(container: HTMLElement, label: string) {
  const menuItems = container.querySelectorAll('[role="menuitem"]');
  return Array.from(menuItems).find((item) => item.textContent?.includes(label));
}

// The HoverTooltip opens after a hover delay and renders its content through a
// portal into document.body, so callers must await it before asserting on the
// tooltip contents. We key the wait on the always-present "Created:" line so
// negative assertions run against an actually-open tooltip (not a vacuous pass).
async function showTooltip(container: HTMLElement) {
  const trigger = container.querySelector('div[role="button"]');
  expect(trigger).not.toBeNull();
  fireEvent.mouseEnter(trigger!);

  await waitFor(() => {
    expect(document.body.textContent).toContain("Created:");
  });
}

beforeEach(() => {
  toastSuccessMock.mockClear();
  toastErrorMock.mockClear();
  settingsDialogPropsMock.mockClear();
  useAgentActivityStore.setState({
    tabStates: {},
    containerStates: {},
    containerStateUpdatedAt: {},
    containerRefCounts: {},
    stateChangeCallbacks: new Map(),
  });
  useUIStore.setState({ selectedEnvironmentId: null });
  useEnvironmentStore.setState({ deletingEnvironments: new Set<string>() });
  useEnvironmentDiffStore.setState({ stats: new Map() });
  useBuildPipelineStore.setState({ buildEnvironmentIds: new Set<string>() });
});

afterEach(() => {
  cleanup();
});

test("memoizes stable row props", () => {
  const environment = makeEnvironment();
  const originalToLocaleDateString = Date.prototype.toLocaleDateString;
  const formatDate = mock(() => "formatted date");
  Date.prototype.toLocaleDateString = formatDate;
  try {
    const view = renderItem(environment);
    expect(formatDate).toHaveBeenCalledTimes(1);
    view.rerender(itemElement(environment));
    expect(formatDate).toHaveBeenCalledTimes(1);
  } finally {
    Date.prototype.toLocaleDateString = originalToLocaleDateString;
  }
});

test("only reacts to its own resolved activity state", () => {
  const environment = makeEnvironment();
  const onRender = mock(() => undefined);
  render(
    <Profiler id="environment-row" onRender={onRender}>
      {itemElement(environment)}
    </Profiler>,
  );
  expect(onRender).toHaveBeenCalledTimes(1);
  act(() => {
    useAgentActivityStore.setState({
      containerStates: { "other-environment": "working" },
      containerStateUpdatedAt: {
        "other-environment": "2026-07-28T10:00:00.000Z",
      },
    });
  });
  expect(onRender).toHaveBeenCalledTimes(1);

  act(() => {
    useAgentActivityStore.setState({
      containerStates: { [environment.id]: "working" },
      containerStateUpdatedAt: {
        [environment.id]: "2026-07-28T10:00:01.000Z",
      },
    });
  });
  expect(onRender.mock.calls.length).toBeGreaterThan(1);
});

// The mobile actions button is gated on a real media query rather than a
// `md:hidden` class, so tests can select a viewport instead of asserting on
// Tailwind class strings that happy-dom never evaluates.
const MOBILE_QUERY = "(max-width: 767px)";

function useViewport(kind: "mobile" | "desktop") {
  const original = window.matchMedia;

  beforeEach(() => {
    window.matchMedia = ((query: string) => ({
      matches: query === MOBILE_QUERY && kind === "mobile",
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    })) as unknown as typeof window.matchMedia;
  });

  afterEach(() => {
    window.matchMedia = original;
  });
}

/** The row's own selectable region — deliberately not the whole row. */
function getRowButton(container: HTMLElement) {
  const row = container.querySelector('div[role="button"]');
  expect(row).not.toBeNull();
  return row as HTMLElement;
}

function queryActionsTrigger(): HTMLElement | null {
  return document.body.querySelector('button[aria-label="Environment actions"]');
}

/**
 * Radix opens the dropdown on pointerdown and then settles its portal and
 * popper asynchronously, so the open is awaited inside `act` to keep those
 * follow-up renders out of the test's assertions.
 */
async function openActionsMenu() {
  const trigger = queryActionsTrigger();
  expect(trigger).not.toBeNull();
  await act(async () => {
    fireEvent.pointerDown(trigger!, { button: 0, ctrlKey: false, pointerType: "touch" });
  });
  return trigger!;
}

/** Radix portals the dropdown outside the render container. */
async function findActionsMenu() {
  let menu: HTMLElement | null = null;
  await waitFor(() => {
    menu = document.body.querySelector('[role="menu"]');
    expect(menu).not.toBeNull();
  });
  return menu!;
}

function actionsMenuLabels(menu: HTMLElement) {
  return Array.from(menu.querySelectorAll('[role="menuitem"]')).map(
    (item) => item.textContent ?? "",
  );
}

function findActionsMenuItem(menu: HTMLElement, label: string) {
  const item = Array.from(menu.querySelectorAll('[role="menuitem"]')).find(
    (candidate) => candidate.textContent === label,
  ) as HTMLElement | undefined;
  expect(item).not.toBeUndefined();
  return item!;
}

/** Choosing an item also closes the menu, so flush those renders too. */
async function selectActionsMenuItem(menu: HTMLElement, label: string) {
  const item = findActionsMenuItem(menu, label);
  await act(async () => {
    fireEvent.click(item);
  });
  return item;
}

/**
 * Dismisses a menu that a test only inspected, so Escape-to-close stays
 * exercised and no test hands an open modal layer to the next one.
 */
async function closeActionsMenu(menu: HTMLElement) {
  await act(async () => {
    fireEvent.keyDown(menu, { key: "Escape" });
  });
}

/** Labels the desktop context menu is currently offering, in order. */
function contextMenuLabels(container: HTMLElement) {
  const content = container.querySelector('[data-testid="context-menu-content"]');
  expect(content).not.toBeNull();
  return Array.from(content!.querySelectorAll('[role="menuitem"]')).map(
    (item) => item.textContent ?? "",
  );
}

describe("EnvironmentItem activity icon", () => {
  test("shows a pulsing blue container icon while tmux activity is working", () => {
    useAgentActivityStore.getState().setContainerState("env-1", "working");

    const { container } = renderItem(makeEnvironment());

    const icon = container.querySelector('div[role="button"] svg');
    expect(icon?.getAttribute("class")).toContain("text-blue-500");
    expect(icon?.getAttribute("class")).toContain("animate-pulse");
  });

  test("hydrates a working icon from the backend-owned environment snapshot", () => {
    const { container } = renderItem(makeEnvironment({
      agentActivityState: "working",
      agentActivityUpdatedAt: "2026-07-27T12:00:00.000Z",
    }));

    const icon = container.querySelector('div[role="button"] svg');
    expect(icon?.getAttribute("class")).toContain("text-blue-500");
  });

  test("keeps a newer runtime observation over an older backend snapshot", () => {
    useAgentActivityStore.getState().setContainerState(
      "env-1",
      "waiting",
      "2026-07-27T12:00:01.000Z",
    );
    const { container } = renderItem(makeEnvironment({
      agentActivityState: "working",
      agentActivityUpdatedAt: "2026-07-27T12:00:00.000Z",
    }));

    const icon = container.querySelector('div[role="button"] svg');
    expect(icon?.getAttribute("class")).toContain("text-amber-500");
  });

  test("prefers a persisted observation when it is newer or equally recent", () => {
    const environment = makeEnvironment({
      agentActivityState: "working",
      agentActivityUpdatedAt: "2026-07-27T12:00:01.000Z",
    });

    expect(resolveEnvironmentAgentActivity(
      environment,
      { "env-1": "waiting" },
      { "env-1": "2026-07-27T12:00:00.000Z" },
    )).toBe("working");
    expect(resolveEnvironmentAgentActivity(
      environment,
      { "env-1": "waiting" },
      { "env-1": "2026-07-27T12:00:01.000Z" },
    )).toBe("working");
  });

  test("uses a runtime observation keyed by the legacy container ID", () => {
    expect(resolveEnvironmentAgentActivity(
      makeEnvironment(),
      { "container-1": "waiting" },
      { "container-1": "2026-07-27T12:00:00.000Z" },
    )).toBe("waiting");
  });

  test("selects the freshest of conflicting environment and container observations", () => {
    const environment = makeEnvironment();
    expect(resolveEnvironmentAgentActivity(
      environment,
      { "env-1": "working", "container-1": "waiting" },
      {
        "env-1": "2026-07-27T12:00:00.000Z",
        "container-1": "2026-07-27T12:00:01.000Z",
      },
    )).toBe("waiting");

    // Equal timestamps resolve deterministically to the environment ID, the
    // current canonical key, rather than depending on object insertion order.
    expect(resolveEnvironmentAgentActivity(
      environment,
      { "container-1": "waiting", "env-1": "working" },
      {
        "container-1": "2026-07-27T12:00:01.000Z",
        "env-1": "2026-07-27T12:00:01.000Z",
      },
    )).toBe("working");
  });

  test("does not let a malformed timestamp beat a valid observation", () => {
    expect(resolveEnvironmentAgentActivity(
      makeEnvironment({
        agentActivityState: "working",
        agentActivityUpdatedAt: "not-a-date",
      }),
      { "env-1": "waiting" },
      { "env-1": "2026-07-27T12:00:00.000Z" },
    )).toBe("waiting");

    expect(resolveEnvironmentAgentActivity(
      makeEnvironment({
        agentActivityState: "working",
        agentActivityUpdatedAt: "2026-07-27T12:00:00.000Z",
      }),
      { "env-1": "waiting" },
      { "env-1": "not-a-date" },
    )).toBe("working");
  });

  test("falls back to idle and ignores poisoned future ordering tokens", () => {
    expect(resolveEnvironmentAgentActivity(
      makeEnvironment(),
      {},
      {},
    )).toBe("idle");

    expect(resolveEnvironmentAgentActivity(
      makeEnvironment({
        agentActivityState: "working",
        agentActivityUpdatedAt: "+275760-09-13T00:00:00.000Z",
      }),
      { "env-1": "waiting" },
      { "env-1": new Date().toISOString() },
    )).toBe("waiting");

    expect(resolveEnvironmentAgentActivity(
      makeEnvironment({
        agentActivityState: "working",
        agentActivityUpdatedAt: "not-a-date",
      }),
      { "env-1": "waiting" },
      { "env-1": "also-not-a-date" },
    )).toBe("idle");
  });

  test("ignores a leftover container-keyed observation for a local environment", () => {
    // A local environment has no container, so runtime state under a container
    // id belongs to some earlier containerized incarnation and must not leak
    // into this one's icon.
    const local = makeEnvironment({
      environmentType: "local",
      containerId: null,
    });

    expect(resolveEnvironmentAgentActivity(
      local,
      { "container-1": "working" },
      { "container-1": new Date().toISOString() },
    )).toBe("idle");

    expect(resolveEnvironmentAgentActivity(
      local,
      { "container-1": "working", "env-1": "waiting" },
      {
        "container-1": new Date().toISOString(),
        "env-1": "2026-07-27T12:00:00.000Z",
      },
    )).toBe("waiting");
  });

  test("discards a persisted state that carries no ordering token", () => {
    // Legacy environments persisted before the token existed, and a backend
    // that answers without one gives no way to order against runtime state.
    expect(resolveEnvironmentAgentActivity(
      makeEnvironment({ agentActivityState: "working" }),
      { "env-1": "waiting" },
      { "env-1": "2026-07-27T12:00:00.000Z" },
    )).toBe("waiting");

    expect(resolveEnvironmentAgentActivity(
      makeEnvironment({ agentActivityState: "working" }),
      {},
      {},
    )).toBe("idle");
  });

  test("clears a stale runtime spinner from the backend snapshot", () => {
    // This is the case the whole feature exists for: another window finished
    // the turn, so the persisted idle must win over this window's last-seen
    // working and turn the icon green rather than leaving it pulsing blue.
    useAgentActivityStore.getState().setContainerState(
      "env-1",
      "working",
      "2026-07-27T12:00:00.000Z",
    );

    const { container } = renderItem(makeEnvironment({
      agentActivityState: "idle",
      agentActivityUpdatedAt: "2026-07-27T12:00:05.000Z",
    }));

    const icon = container.querySelector('div[role="button"] svg');
    expect(icon?.getAttribute("class")).toContain("text-green-500");
    expect(icon?.getAttribute("class")).not.toContain("animate-pulse");
  });

  test("shows no activity colour at all while the environment is not running", () => {
    const { container } = renderItem(makeEnvironment({
      status: "stopped",
      agentActivityState: "working",
      agentActivityUpdatedAt: "2026-07-27T12:00:00.000Z",
    }));

    const icon = container.querySelector('div[role="button"] svg');
    expect(icon?.getAttribute("class")).toContain("text-muted-foreground");
    expect(icon?.getAttribute("class")).not.toContain("text-blue-500");
  });
});

describe("EnvironmentItem tooltip port display", () => {
  test("shows full port mapping when both entryPort and hostEntryPort are set", async () => {
    const env = makeEnvironment({ entryPort: 3000, hostEntryPort: 49152 });
    const { container } = renderItem(env);
    await showTooltip(container);

    const html = document.body.innerHTML;
    expect(html).toContain("localhost:49152");
    expect(html).toContain("3000/tcp");
  });

  test("shows 'not mapped' when entryPort is set but hostEntryPort is missing", async () => {
    const env = makeEnvironment({ entryPort: 8080 });
    const { container } = renderItem(env);
    await showTooltip(container);

    const html = document.body.innerHTML;
    expect(html).toContain("8080/tcp");
    expect(html).toContain("(not mapped)");
  });

  test("does not show port info when entryPort is not set", async () => {
    const env = makeEnvironment();
    const { container } = renderItem(env);
    await showTooltip(container);

    const html = document.body.innerHTML;
    expect(html).not.toContain("Port:");
    expect(html).not.toContain("/tcp");
  });

  test("does not show port info for local environments even with entryPort", async () => {
    const env = makeEnvironment({
      environmentType: "local",
      entryPort: 3000,
      hostEntryPort: 49152,
    });
    const { container } = renderItem(env);
    await showTooltip(container);

    const html = document.body.innerHTML;
    expect(html).not.toContain("Port:");
    expect(html).not.toContain("3000/tcp");
  });
});

describe("EnvironmentItem diff stats", () => {
  test("marks truncated line counts as approximate in the badge and tooltip", async () => {
    useEnvironmentDiffStore.setState({
      stats: new Map([["env-1", {
        additions: 12,
        deletions: 3,
        filesChanged: 4,
        truncated: true,
      }]]),
    });

    const { container } = renderItem(makeEnvironment());

    const badge = Array.from(container.querySelectorAll("span")).find(
      (element) => element.textContent === "~+12-3",
    );
    expect(badge).not.toBeUndefined();

    await showTooltip(container);
    expect(document.body.textContent).toContain(
      "Line counts are approximate: too many untracked files to count them all.",
    );
  });

  test("does not mark exact line counts as approximate", async () => {
    useEnvironmentDiffStore.setState({
      stats: new Map([["env-1", {
        additions: 12,
        deletions: 3,
        filesChanged: 4,
        truncated: false,
      }]]),
    });

    const { container } = renderItem(makeEnvironment());
    expect(container.textContent).toContain("+12-3");
    expect(container.textContent).not.toContain("~");

    await showTooltip(container);
    expect(document.body.textContent).not.toContain("Line counts are approximate:");
  });
});

describe("EnvironmentItem copy address", () => {
  let writeTextMock: ReturnType<typeof mock>;

  beforeEach(() => {
    writeTextMock = mock(() => Promise.resolve());
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText: writeTextMock },
      writable: true,
      configurable: true,
    });
  });

  test("clicking localhost address in tooltip copies to clipboard", async () => {
    const env = makeEnvironment({ entryPort: 3000, hostEntryPort: 49152 });
    const { container } = renderItem(env);
    await showTooltip(container);

    const clickableSpan = document.body.querySelector('span[role="button"]');
    expect(clickableSpan).not.toBeNull();
    expect(clickableSpan!.textContent).toBe("localhost:49152");

    fireEvent.click(clickableSpan!);
    expect(writeTextMock).toHaveBeenCalledWith("localhost:49152");
  });

  test("context menu shows Copy Address when port is mapped", () => {
    const env = makeEnvironment({ entryPort: 3000, hostEntryPort: 49152 });
    const { container } = renderItem(env);

    const contextMenu = container.querySelector('[data-testid="context-menu-content"]');
    expect(contextMenu).not.toBeNull();
    expect(contextMenu!.textContent).toContain("Copy Address");
  });

  test("context menu Copy Address copies to clipboard when clicked", () => {
    const env = makeEnvironment({ entryPort: 3000, hostEntryPort: 49152 });
    const { container } = renderItem(env);

    const copyItem = findMenuItem(container, "Copy Address");
    expect(copyItem).not.toBeUndefined();

    fireEvent.click(copyItem!);
    expect(writeTextMock).toHaveBeenCalledWith("localhost:49152");
  });

  test("shows an error toast when copying an address fails", async () => {
    writeTextMock.mockRejectedValueOnce(new Error("clipboard unavailable"));
    const env = makeEnvironment({ entryPort: 3000, hostEntryPort: 49152 });
    const { container } = renderItem(env);

    const copyItem = findMenuItem(container, "Copy Address");
    expect(copyItem).not.toBeUndefined();
    fireEvent.click(copyItem!);

    await waitFor(() => {
      expect(toastErrorMock).toHaveBeenCalledWith("Failed to copy address");
    });
  });

  test("context menu does not show Copy Address when no port is mapped", () => {
    const env = makeEnvironment({ entryPort: 3000 });
    const { container } = renderItem(env);

    const contextMenu = container.querySelector('[data-testid="context-menu-content"]');
    expect(contextMenu!.textContent).not.toContain("Copy Address");
  });

  test("tooltip address is not clickable when port is not mapped", async () => {
    const env = makeEnvironment({ entryPort: 3000 });
    const { container } = renderItem(env);
    await showTooltip(container);

    const clickableSpan = document.body.querySelector('span[role="button"]');
    expect(clickableSpan).toBeNull();
  });
});

describe("EnvironmentItem copy initial prompt", () => {
  let writeTextMock: ReturnType<typeof mock>;

  beforeEach(() => {
    writeTextMock = mock(() => Promise.resolve());
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText: writeTextMock },
      writable: true,
      configurable: true,
    });
  });

  test("context menu shows Copy Initial Prompt when an initial prompt is stored", () => {
    const env = makeEnvironment({ initialPrompt: "Review the migration plan" });
    const { container } = renderItem(env);

    const contextMenu = container.querySelector('[data-testid="context-menu-content"]');
    expect(contextMenu).not.toBeNull();
    expect(contextMenu!.textContent).toContain("Copy Initial Prompt");
  });

  test("context menu Copy Initial Prompt copies the prompt to clipboard", () => {
    const env = makeEnvironment({ initialPrompt: "Review the migration plan" });
    const { container } = renderItem(env);

    const copyItem = findMenuItem(container, "Copy Initial Prompt");
    expect(copyItem).not.toBeUndefined();

    fireEvent.click(copyItem!);
    expect(writeTextMock).toHaveBeenCalledWith("Review the migration plan");
  });

  test("context menu Copy Initial Prompt trims stored prompt text before copying", () => {
    const env = makeEnvironment({ initialPrompt: "  Review the migration plan\n" });
    const { container } = renderItem(env);

    const copyItem = findMenuItem(container, "Copy Initial Prompt");
    expect(copyItem).not.toBeUndefined();

    fireEvent.click(copyItem!);
    expect(writeTextMock).toHaveBeenCalledWith("Review the migration plan");
  });

  test("context menu Copy Initial Prompt shows an error toast when clipboard write fails", async () => {
    writeTextMock = mock(() => Promise.reject(new Error("clipboard unavailable")));
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText: writeTextMock },
      writable: true,
      configurable: true,
    });
    const env = makeEnvironment({ initialPrompt: "Review the migration plan" });
    const { container } = renderItem(env);

    const copyItem = findMenuItem(container, "Copy Initial Prompt");
    expect(copyItem).not.toBeUndefined();

    fireEvent.click(copyItem!);
    expect(writeTextMock).toHaveBeenCalledWith("Review the migration plan");
    await waitFor(() => {
      expect(toastErrorMock).toHaveBeenCalledWith("Failed to copy initial prompt");
    });
  });

  test("context menu does not show Copy Initial Prompt without stored prompt text", () => {
    const env = makeEnvironment({ initialPrompt: "   " });
    const { container } = renderItem(env);

    const contextMenu = container.querySelector('[data-testid="context-menu-content"]');
    expect(contextMenu!.textContent).not.toContain("Copy Initial Prompt");
  });
});

describe("EnvironmentItem menu actions and selection", () => {
  test("context menu Settings opens the settings dialog", () => {
    const env = makeEnvironment();
    const { container } = renderItem(env);

    const settingsItem = findMenuItem(container, "Settings");
    expect(settingsItem).not.toBeUndefined();

    fireEvent.click(settingsItem!);
    expect(container.querySelector('[data-testid="settings-dialog"]')).not.toBeNull();
    expect(settingsDialogPropsMock).toHaveBeenLastCalledWith(
      expect.objectContaining({ open: true }),
    );
  });

  test("keeps transition controls disabled until a non-transitioning status arrives", async () => {
    const onUpdate = mock((_environment: Environment) => {});
    const initialEnvironment = makeEnvironment({ status: "running" });
    const rendered = renderItem(initialEnvironment, { onUpdate });

    fireEvent.click(findMenuItem(rendered.container, "Settings")!);
    const dialogProps = settingsDialogPropsMock.mock.calls.at(-1)?.[0];
    expect(dialogProps).toBeDefined();

    const stoppingEnvironment = {
      ...initialEnvironment,
      status: "stopping" as const,
    };
    act(() => {
      dialogProps!.onUpdate(stoppingEnvironment);
    });

    expect(onUpdate).toHaveBeenCalledWith(stoppingEnvironment);
    expect(findMenuItem(rendered.container, "Stop")?.getAttribute("aria-disabled"))
      .toBe("true");
    expect(
      rendered.container.querySelector("svg.animate-spin.text-amber-500"),
    ).not.toBeNull();

    rendered.rerender(
      <EnvironmentItem
        environment={{ ...initialEnvironment, status: "stopped" }}
        isSelected={false}
        onSelect={noopSelect}
        onDelete={noopEnvironmentHandler}
        onStart={noopEnvironmentHandler}
        onStop={noopEnvironmentHandler}
        onRestart={noopEnvironmentHandler}
        onUpdate={onUpdate}
      />,
    );

    await waitFor(() => {
      expect(findMenuItem(rendered.container, "Start")?.getAttribute("aria-disabled"))
        .toBeNull();
      expect(
        rendered.container.querySelector("svg.animate-spin.text-amber-500"),
      ).toBeNull();
    });
  });

  test("local environments never enter the container transition lifecycle", () => {
    const localEnvironment = makeEnvironment({
      environmentType: "local",
      containerId: null,
      status: "creating",
    });
    const { container } = renderItem(localEnvironment);

    expect(container.querySelector("svg.animate-spin.text-amber-500")).toBeNull();
    expect(container.querySelector("svg.lucide-laptop")).not.toBeNull();
  });

  test("context menu Stop calls onStop for a running container environment", () => {
    const onStop = mock(() => {});
    const env = makeEnvironment({ status: "running" });
    const { container } = renderItem(env, { onStop });

    const stopItem = findMenuItem(container, "Stop");
    expect(stopItem).not.toBeUndefined();

    fireEvent.click(stopItem!);
    expect(onStop).toHaveBeenCalledWith("env-1");
  });

  test("context menu Start calls onStart for a stopped container environment", () => {
    const onStart = mock(() => {});
    const env = makeEnvironment({ status: "stopped" });
    const { container } = renderItem(env, { onStart });

    const startItem = findMenuItem(container, "Start");
    expect(startItem).not.toBeUndefined();

    fireEvent.click(startItem!);
    expect(onStart).toHaveBeenCalledWith("env-1");
  });

  test("context menu Restart is disabled when the container environment is stopped", () => {
    const onRestart = mock(() => {});
    const env = makeEnvironment({ status: "stopped" });
    const { container } = renderItem(env, { onRestart });

    const restartItem = findMenuItem(container, "Restart");
    expect(restartItem).not.toBeUndefined();
    expect(restartItem!.getAttribute("aria-disabled")).toBe("true");

    fireEvent.click(restartItem!);
    expect(onRestart).not.toHaveBeenCalled();
  });

  test("context menu Delete confirms before calling onDelete", () => {
    const onDelete = mock(() => {});
    const env = makeEnvironment({ name: "delete-me" });
    const { container } = renderItem(env, { onDelete });

    const deleteItem = findMenuItem(container, "Delete");
    expect(deleteItem).not.toBeUndefined();
    expect(container.textContent).not.toContain("Delete Environment");

    fireEvent.click(deleteItem!);
    expect(container.textContent).toContain("Delete Environment");
    expect(container.textContent).toContain("delete-me");
    expect(onDelete).not.toHaveBeenCalled();

    const confirmButton = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent === "Delete",
    );
    expect(confirmButton).not.toBeUndefined();

    fireEvent.click(confirmButton!);
    expect(onDelete).toHaveBeenCalledWith("env-1");
  });

  test("click selection forwards ctrl or meta selection intent", () => {
    const onSelect = mock(() => {});
    const env = makeEnvironment();
    const { container } = renderItem(env, { onSelect });

    const trigger = container.querySelector('div[role="button"]');
    expect(trigger).not.toBeNull();

    fireEvent.click(trigger!, { ctrlKey: true });
    expect(onSelect).toHaveBeenCalledWith("env-1", {
      shiftKey: false,
      metaKey: true,
    });
  });

  test("keyboard selection forwards shift selection intent", () => {
    const onSelect = mock(() => {});
    const env = makeEnvironment();
    const { container } = renderItem(env, { onSelect });

    const trigger = container.querySelector('div[role="button"]');
    expect(trigger).not.toBeNull();

    fireEvent.keyDown(trigger!, { key: "Enter", shiftKey: true });
    expect(onSelect).toHaveBeenCalledWith("env-1", {
      shiftKey: true,
      metaKey: false,
    });
  });
});

describe("EnvironmentItem unread activity indicator", () => {
  test("does not render the unread bell when the environment has no unread activity", () => {
    const { container } = renderItem(makeEnvironment());

    expect(container.querySelector('[aria-label="New completed activity"]')).toBeNull();
  });

  test("renders the unread bell when the environment is marked unread", () => {
    // Unread is a field on the environment now, so the badge follows the
    // backend record rather than this window's own list.
    const { container } = renderItem(makeEnvironment({ id: "env-1", hasUnreadWork: true }));

    expect(container.querySelector('[aria-label="New completed activity"]')).not.toBeNull();
  });

  test("only marks the matching environment unread, not its siblings", () => {
    const { container } = renderItem(makeEnvironment({ id: "env-1", hasUnreadWork: false }));

    expect(container.querySelector('[aria-label="New completed activity"]')).toBeNull();
  });

  test("shows the unread bell for local environments too (independent of container status)", () => {
    const { container } = renderItem(
      makeEnvironment({
        id: "env-1",
        hasUnreadWork: true,
        environmentType: "local",
        containerId: null,
        status: "stopped",
      }),
    );

    expect(container.querySelector('[aria-label="New completed activity"]')).not.toBeNull();
  });
});

describe("EnvironmentItem mobile actions menu", () => {
  useViewport("mobile");

  test("renders an actions trigger for the row", () => {
    renderItem(makeEnvironment());

    expect(queryActionsTrigger()).not.toBeNull();
  });

  test("the trigger is not nested inside the row's selectable region", () => {
    const { container } = renderItem(makeEnvironment());

    // ARIA treats the children of role="button" as presentational, so a control
    // nested there would be hidden from assistive tech on the one platform that
    // needs it. Keep the trigger a sibling of the selectable region.
    expect(getRowButton(container).contains(queryActionsTrigger())).toBe(false);
  });

  test("the trigger does not make the row ambiguous to query by name", () => {
    renderItem(makeEnvironment({ name: "test-env" }));

    // Folding the environment name into the trigger's label would give the page
    // two buttons named "test-env" and break every role+name lookup for a row.
    const named = screen.getAllByRole("button", { name: /test-env/ });
    expect(named).toHaveLength(1);
    expect(named[0].getAttribute("role")).toBe("button");
    expect(named[0].tagName).toBe("DIV");
  });

  test("the trigger describes itself with the row name instead of naming itself after it", () => {
    const { container } = renderItem(makeEnvironment({ name: "test-env" }));

    const trigger = queryActionsTrigger();
    const describedBy = trigger!.getAttribute("aria-describedby");
    expect(describedBy).toBeTruthy();
    expect(container.querySelector(`#${CSS.escape(describedBy!)}`)?.textContent).toBe("test-env");
  });

  test("pressing the trigger does not reach an ancestor pointerdown listener", async () => {
    // dnd-kit drag activation and Radix's context-menu long-press both hang off
    // pointerdown on an ancestor; the trigger must not start either.
    const ancestorPointerDown = mock(() => {});
    const { container } = render(
      <div onPointerDown={ancestorPointerDown}>{itemElement(makeEnvironment())}</div>,
    );

    // Opens the dropdown as a side effect, so settle it inside act().
    await act(async () => {
      fireEvent.pointerDown(queryActionsTrigger()!, { button: 0, pointerType: "touch" });
    });
    expect(ancestorPointerDown).not.toHaveBeenCalled();

    await act(async () => {
      fireEvent.pointerDown(getRowButton(container), { button: 0, pointerType: "touch" });
    });
    expect(ancestorPointerDown).toHaveBeenCalled();
  });

  test("choosing Stop stops the environment without selecting the row", async () => {
    const onSelect = mock(() => {});
    const onStop = mock(() => {});
    renderItem(makeEnvironment({ status: "running" }), { onSelect, onStop });

    await openActionsMenu();
    const menu = await findActionsMenu();

    await selectActionsMenuItem(menu, "Stop");
    expect(onStop).toHaveBeenCalledWith("env-1");
    expect(onSelect).not.toHaveBeenCalled();
  });

  test("offers exactly the actions the desktop context menu offers", async () => {
    const { container } = renderItem(
      makeEnvironment({
        status: "running",
        entryPort: 3000,
        hostEntryPort: 49152,
        initialPrompt: "Review the migration plan",
      }),
    );

    await openActionsMenu();
    const menu = await findActionsMenu();

    expect(actionsMenuLabels(menu)).toEqual([
      "Settings",
      "Copy Address",
      "Copy Initial Prompt",
      "Stop",
      "Restart",
      "Delete",
    ]);
    expect(actionsMenuLabels(menu)).toEqual(contextMenuLabels(container));

    await closeActionsMenu(menu);
  });

  test("omits container lifecycle actions for a local environment", async () => {
    const { container } = renderItem(
      makeEnvironment({ environmentType: "local", containerId: null, status: "stopped" }),
    );

    await openActionsMenu();
    const menu = await findActionsMenu();

    expect(actionsMenuLabels(menu)).toEqual(["Settings", "Delete"]);
    expect(actionsMenuLabels(menu)).toEqual(contextMenuLabels(container));

    await closeActionsMenu(menu);
  });

  test("offers Start and a disabled Restart for a stopped container environment", async () => {
    const onStart = mock(() => {});
    const onRestart = mock(() => {});
    renderItem(makeEnvironment({ status: "stopped" }), { onStart, onRestart });

    await openActionsMenu();
    const menu = await findActionsMenu();

    expect(actionsMenuLabels(menu)).toEqual(["Settings", "Start", "Restart", "Delete"]);

    const restart = findActionsMenuItem(menu, "Restart");
    expect(restart.getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(restart);
    expect(onRestart).not.toHaveBeenCalled();

    await selectActionsMenuItem(menu, "Start");
    expect(onStart).toHaveBeenCalledWith("env-1");
  });

  test("disables Stop and Restart while the container is transitioning", async () => {
    const onStop = mock(() => {});
    const onRestart = mock(() => {});
    renderItem(makeEnvironment({ status: "stopping" }), { onStop, onRestart });

    await openActionsMenu();
    const menu = await findActionsMenu();

    // A "stopping" container still reports isRunning === false, so the power
    // action offers Start; both lifecycle actions must be inert either way.
    for (const label of ["Start", "Restart"]) {
      const item = findActionsMenuItem(menu, label);
      expect(item.getAttribute("aria-disabled")).toBe("true");
      fireEvent.click(item);
    }
    expect(onStop).not.toHaveBeenCalled();
    expect(onRestart).not.toHaveBeenCalled();

    await closeActionsMenu(menu);
  });

  test("Copy Address copies the mapped host address", async () => {
    const writeText = mock(() => Promise.resolve());
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      writable: true,
      configurable: true,
    });
    renderItem(makeEnvironment({ entryPort: 3000, hostEntryPort: 49152 }));

    await openActionsMenu();
    const menu = await findActionsMenu();

    await selectActionsMenuItem(menu, "Copy Address");
    expect(writeText).toHaveBeenCalledWith("localhost:49152");
  });

  test("Copy Initial Prompt copies the trimmed prompt", async () => {
    const writeText = mock(() => Promise.resolve());
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      writable: true,
      configurable: true,
    });
    renderItem(makeEnvironment({ initialPrompt: "  Review the migration plan\n" }));

    await openActionsMenu();
    const menu = await findActionsMenu();

    await selectActionsMenuItem(menu, "Copy Initial Prompt");
    expect(writeText).toHaveBeenCalledWith("Review the migration plan");
  });

  test("Settings opens the settings dialog", async () => {
    const { container } = renderItem(makeEnvironment());

    await openActionsMenu();
    const menu = await findActionsMenu();

    await selectActionsMenuItem(menu, "Settings");
    await waitFor(() => {
      expect(container.querySelector('[data-testid="settings-dialog"]')).not.toBeNull();
    });
  });

  test("Delete asks for confirmation instead of deleting immediately", async () => {
    const onDelete = mock(() => {});
    const { container } = renderItem(makeEnvironment({ name: "delete-me" }), { onDelete });

    await openActionsMenu();
    const menu = await findActionsMenu();

    await selectActionsMenuItem(menu, "Delete");
    await waitFor(() => {
      expect(container.textContent).toContain("Delete Environment");
    });
    expect(onDelete).not.toHaveBeenCalled();

    const confirm = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent === "Delete",
    );
    fireEvent.click(confirm!);
    expect(onDelete).toHaveBeenCalledWith("env-1");
  });
});

describe("EnvironmentItem on a desktop viewport", () => {
  useViewport("desktop");

  test("does not render the mobile actions trigger", () => {
    renderItem(makeEnvironment());

    expect(queryActionsTrigger()).toBeNull();
  });

  test("leaves the row as the only element matching its name", () => {
    renderItem(makeEnvironment({ name: "test-env" }));

    expect(screen.getAllByRole("button", { name: /test-env/ })).toHaveLength(1);
  });

  test("still exposes every action through the context menu", () => {
    const { container } = renderItem(
      makeEnvironment({ status: "running", entryPort: 3000, hostEntryPort: 49152 }),
    );

    expect(contextMenuLabels(container)).toEqual([
      "Settings",
      "Copy Address",
      "Stop",
      "Restart",
      "Delete",
    ]);
  });
});

describe("EnvironmentItem multi-select", () => {
  test("renders a selection checkbox only in multi-select mode", () => {
    const { container: plain } = renderItem(makeEnvironment());
    expect(plain.querySelector('input[type="checkbox"]')).toBeNull();

    cleanup();

    const { container: multi } = renderItem(makeEnvironment(), { isMultiSelectMode: true });
    expect(multi.querySelector('input[type="checkbox"]')).not.toBeNull();
  });

  test("the checkbox sits outside the row's selectable region", () => {
    const { container } = renderItem(makeEnvironment(), { isMultiSelectMode: true });

    const checkbox = container.querySelector('input[type="checkbox"]');
    expect(getRowButton(container).contains(checkbox)).toBe(false);
  });

  test("toggling the checkbox forwards a meta-click selection intent", () => {
    const onSelect = mock(() => {});
    const { container } = renderItem(makeEnvironment(), { isMultiSelectMode: true, onSelect });

    fireEvent.click(container.querySelector('input[type="checkbox"]')!);
    expect(onSelect).toHaveBeenCalledWith("env-1", { metaKey: true });
  });

  test("reflects the checked state without hiding the environment icon slot", () => {
    const { container } = renderItem(makeEnvironment(), {
      isMultiSelectMode: true,
      isChecked: true,
    });

    expect((container.querySelector('input[type="checkbox"]') as HTMLInputElement).checked).toBe(true);
    // The checkbox replaces the status icon rather than sitting beside it.
    expect(container.querySelector('div[role="button"] svg')).toBeNull();
  });

  test("a deleting environment shows the delete spinner instead of the checkbox", () => {
    useEnvironmentStore.getState().setDeleting("env-1", true);

    const { container } = renderItem(makeEnvironment(), { isMultiSelectMode: true });

    expect(container.querySelector('input[type="checkbox"]')).toBeNull();
    const icon = container.querySelector('div[role="button"] svg');
    expect(icon?.getAttribute("class")).toContain("text-destructive");
    expect(icon?.getAttribute("class")).toContain("animate-spin");
  });
});

describe("EnvironmentItem transitioning state", () => {
  test("shows the amber spinner while the container is creating", () => {
    const { container } = renderItem(makeEnvironment({ status: "creating" }));

    const icon = container.querySelector('div[role="button"] svg');
    expect(icon?.getAttribute("class")).toContain("text-amber-500");
    expect(icon?.getAttribute("class")).toContain("animate-spin");
  });

  test("never shows the transitioning spinner for a local environment", () => {
    const { container } = renderItem(
      makeEnvironment({ environmentType: "local", containerId: null, status: "creating" }),
    );

    const icon = container.querySelector('div[role="button"] svg');
    expect(icon?.getAttribute("class")).toContain("lucide-laptop");
    expect(icon?.getAttribute("class")).not.toContain("animate-spin");
  });

  test("forwards a settings update and clears the spinner once the environment settles", () => {
    const onUpdate = mock(() => {});
    const { container, rerender } = renderItem(makeEnvironment({ status: "creating" }), {
      onUpdate,
    });

    fireEvent.click(findMenuItem(container, "Settings")!);
    const emit = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent === "Emit transitioning update",
    );
    fireEvent.click(emit!);

    expect(onUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ id: "env-1", status: "creating" }),
    );
    expect(container.querySelector('div[role="button"] svg')?.getAttribute("class")).toContain(
      "animate-spin",
    );

    // The parent reports the environment as settled; the local override the
    // dialog set must not keep the spinner alive.
    rerender(itemElement(makeEnvironment({ status: "running" }), { onUpdate }));

    const icon = container.querySelector('div[role="button"] svg');
    expect(icon?.getAttribute("class")).toContain("lucide-container");
    expect(icon?.getAttribute("class")).not.toContain("animate-spin");
  });

  test("a settled settings update leaves a non-transitioning row unchanged", () => {
    const onUpdate = mock(() => {});
    const { container } = renderItem(makeEnvironment({ status: "running" }), { onUpdate });

    fireEvent.click(findMenuItem(container, "Settings")!);
    const emit = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent === "Emit settled update",
    );
    fireEvent.click(emit!);

    expect(onUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ id: "env-1", status: "running" }),
    );
    const icon = container.querySelector('div[role="button"] svg');
    expect(icon?.getAttribute("class")).not.toContain("animate-spin");
  });

  test("renders without an onUpdate handler", () => {
    const { container } = renderItem(makeEnvironment());

    fireEvent.click(findMenuItem(container, "Settings")!);
    const emit = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent === "Emit settled update",
    );
    expect(() => fireEvent.click(emit!)).not.toThrow();
  });
});

describe("EnvironmentItem build pipeline naming", () => {
  test("strips the Build: prefix and tints the name for build environments", () => {
    useBuildPipelineStore.setState({ buildEnvironmentIds: new Set(["env-1"]) });

    const { container } = renderItem(makeEnvironment({ name: "Build: checkout-flow" }));

    const name = getRowButton(container).querySelector("span span span");
    expect(name?.textContent).toBe("checkout-flow");
    expect(name?.getAttribute("class")).toContain("text-yellow-400");
  });

  test("leaves the name untouched for a non-build environment", () => {
    const { container } = renderItem(makeEnvironment({ name: "Build: checkout-flow" }));

    expect(container.textContent).toContain("Build: checkout-flow");
  });
});
