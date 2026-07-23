import { afterEach, describe, test, expect, mock, beforeEach } from "bun:test";
import { cleanup, render, fireEvent, waitFor } from "@testing-library/react";
import type { Environment } from "../../../apps/web/src/types";
import {
  mockToastError as toastErrorMock,
  mockToastSuccess as toastSuccessMock,
} from "../../mocks/sonner";

const settingsDialogPropsMock = mock(() => {});

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
  Checkbox: () => <input type="checkbox" />,
}));

mock.module("@/components/environments/EnvironmentSettingsDialog", () => ({
  EnvironmentSettingsDialog: (props: { open: boolean }) => {
    settingsDialogPropsMock(props);
    return props.open ? <div data-testid="settings-dialog" /> : null;
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

import { EnvironmentItem } from "../../../apps/web/src/components/environments/EnvironmentItem";
import { useAgentActivityStore } from "../../../apps/web/src/stores/agentActivityStore";
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

function renderItem(env: Environment, options: RenderOptions = {}) {
  return render(
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
    />,
  );
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
    containerRefCounts: {},
    stateChangeCallbacks: new Map(),
  });
  useUIStore.setState({ unreadEnvironmentIds: [], selectedEnvironmentId: null });
});

afterEach(() => {
  cleanup();
});

describe("EnvironmentItem activity icon", () => {
  test("shows a pulsing blue container icon while tmux activity is working", () => {
    useAgentActivityStore.getState().setContainerState("env-1", "working");

    const { container } = renderItem(makeEnvironment());

    const icon = container.querySelector('div[role="button"] svg');
    expect(icon?.getAttribute("class")).toContain("text-blue-500");
    expect(icon?.getAttribute("class")).toContain("animate-pulse");
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
    useUIStore.setState({ unreadEnvironmentIds: ["env-1"] });

    const { container } = renderItem(makeEnvironment({ id: "env-1" }));

    expect(container.querySelector('[aria-label="New completed activity"]')).not.toBeNull();
  });

  test("only marks the matching environment unread, not its siblings", () => {
    useUIStore.setState({ unreadEnvironmentIds: ["env-other"] });

    const { container } = renderItem(makeEnvironment({ id: "env-1" }));

    expect(container.querySelector('[aria-label="New completed activity"]')).toBeNull();
  });

  test("shows the unread bell for local environments too (independent of container status)", () => {
    useUIStore.setState({ unreadEnvironmentIds: ["env-1"] });

    const { container } = renderItem(
      makeEnvironment({
        id: "env-1",
        environmentType: "local",
        containerId: null,
        status: "stopped",
      }),
    );

    expect(container.querySelector('[aria-label="New completed activity"]')).not.toBeNull();
  });
});
