import { afterEach, beforeEach, describe, expect, mock, test, type Mock } from "bun:test";
import { useEffect, type ReactNode } from "react";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import type { DesignFrame } from "@orkestrator/protocol/design-canvas";
import type {
  DesignContextReference,
  DesignSessionLink,
  DesignWorkspaceMeta,
} from "@orkestrator/protocol/design-operations";
// Registered once in tests/setup.ts; this file only varies its behavior.
import { invoke } from "@/lib/native/backend";
import {
  TerminalProvider,
  useTerminalContext,
  type CreatableTabType,
  type CreateTabOptions,
} from "@/contexts/TerminalContext";
import { createSessionKey } from "@/lib/utils";
import { emptyProjection, type DesignProjection } from "@/stores/designStore";
import { nativeComposeDraft, useNativeComposeStore } from "@/stores/nativeComposeStore";
import { usePaneLayoutStore } from "@/stores/paneLayoutStore";
import type { TabInfo } from "@/types/paneLayout";
import { DesignAgentDialog } from "./DesignAgentDialog";

const invokeMock = invoke as unknown as Mock<
  (command: string, args?: Record<string, unknown>) => Promise<unknown>
>;

const frames: DesignFrame[] = [
  {
    id: "frame-1",
    name: "Hero",
    x: 0,
    y: 0,
    width: 1280,
    height: 800,
    html: "<p>hero markup</p>",
    revision: 4,
  },
  {
    id: "frame-2",
    name: "Pricing",
    x: 0,
    y: 900,
    width: 1280,
    height: 600,
    html: "<p>pricing markup</p>",
    revision: 2,
  },
];

function link(
  id: string,
  tabId: string,
  overrides: Partial<DesignSessionLink> = {},
): DesignSessionLink {
  return {
    id,
    tabId,
    platform: "claude",
    role: "design",
    createdAt: `2026-09-24T0${id.length}:00:00Z`,
    ...overrides,
  };
}

function projectionWith(sessions: DesignSessionLink[]): DesignProjection {
  return {
    ...emptyProjection("key", "env-1", "canvas-1"),
    snapshot: "current",
    revision: 12,
    canvas: {
      format: "orkdes",
      version: 1,
      id: "canvas-1",
      environmentId: "env-1",
      name: "Landing",
      revision: 12,
      frames,
    },
    workspace: { sessions } as unknown as DesignWorkspaceMeta,
  };
}

const context: DesignContextReference = {
  version: 1,
  canvasId: "canvas-1",
  canvasName: "Landing",
  environmentId: "env-1",
  frameId: "frame-1",
  frameName: "Hero",
  canvasRevision: 12,
  frameRevision: 4,
  scope: "discuss",
};

function agentTab(id: string, platform?: "claude" | "codex"): TabInfo {
  return {
    id,
    type: "agent-native",
    nativeAgentData: { environmentId: "env-1", ...(platform ? { platform } : {}) },
  } as TabInfo;
}

function seedTabs(tabs: TabInfo[]) {
  usePaneLayoutStore.setState({
    activeEnvironmentId: "env-1",
    hydration: new Map([["env-1", "done"]]),
    environments: new Map([
      [
        "env-1",
        {
          root: { kind: "leaf", id: "pane-1", tabs, activeTabId: "design-tab" },
          activePaneId: "pane-1",
        },
      ],
    ]),
  } as never);
}

const createTabMock = mock((_type: CreatableTabType, options?: CreateTabOptions) => {
  const store = usePaneLayoutStore.getState();
  store.addTab("pane-1", agentTab(options!.tabId!), "env-1");
  return true;
});

function RegisterCreateTab({ children }: { children: ReactNode }) {
  const { setCreateTab } = useTerminalContext();
  useEffect(() => {
    setCreateTab(createTabMock);
    return () => setCreateTab(null);
  }, [setCreateTab]);
  return <>{children}</>;
}

async function renderDialog(props: {
  context?: DesignContextReference;
  sessions?: DesignSessionLink[];
  onOpenChange?: (open: boolean) => void;
}) {
  const onOpenChange = props.onOpenChange ?? mock();
  await act(async () => {
    render(
      <TerminalProvider>
        <RegisterCreateTab>
          <DesignAgentDialog
            context={props.context ?? context}
            projection={projectionWith(props.sessions ?? [])}
            onOpenChange={onOpenChange}
          />
        </RegisterCreateTab>
      </TerminalProvider>,
    );
  });
  return { onOpenChange };
}

function commandCalls(command: string) {
  return invokeMock.mock.calls.filter(([name]) => name === command);
}

beforeEach(() => {
  useNativeComposeStore.setState({ drafts: new Map() });
  createTabMock.mockClear();
  invokeMock.mockReset();
  invokeMock.mockImplementation(() =>
    Promise.resolve({ ok: false, failure: { code: "unsupported", message: "no", retry: "never" } }),
  );
});

afterEach(() => {
  cleanup();
  invokeMock.mockReset();
  invokeMock.mockImplementation(() => Promise.resolve());
});

describe("DesignAgentDialog", () => {
  test("lists linked conversations and marks closed ones with a remove action", async () => {
    seedTabs([agentTab("agent-open", "claude")]);
    invokeMock.mockImplementation((command) =>
      Promise.resolve(
        command === "design_session_unlink"
          ? { ok: true, value: { unlinked: true } }
          : { ok: false, failure: { code: "unsupported", message: "no", retry: "never" } },
      ),
    );
    await renderDialog({
      sessions: [
        link("open", "agent-open", { label: "Design chat" }),
        link("gone", "agent-gone", { label: "Old chat", role: "implementation" }),
      ],
    });

    const open = screen.getByTestId("design-link-open");
    expect(open.textContent).not.toContain("Closed");
    expect(within(open).getByRole("button", { name: "Open" })).toBeTruthy();
    const closed = screen.getByTestId("design-link-gone");
    expect(closed.textContent).toContain("Closed — conversation ended");

    await act(async () => {
      fireEvent.click(within(closed).getByRole("button", { name: "Remove link to Old chat" }));
    });
    expect(commandCalls("design_session_unlink")[0]?.[1]).toEqual({
      environmentId: "env-1",
      canvasId: "canvas-1",
      linkId: "gone",
    });
    expect(screen.queryByTestId("design-link-gone") === null).toBe(true);
  });

  test("adds design context to an existing draft without overwriting it or submitting", async () => {
    seedTabs([agentTab("agent-open", "claude")]);
    const sessionKey = createSessionKey("env-1", "agent-open");
    const existing = { id: "t1", text: "quoted excerpt", comment: "" };
    useNativeComposeStore
      .getState()
      .updateDraft(sessionKey, { text: "my unsent words", annotations: [existing] });
    const { onOpenChange } = await renderDialog({ sessions: [link("open", "agent-open")] });

    fireEvent.change(screen.getByPlaceholderText("What would you like to know or change?"), {
      target: { value: "Why is this blue?" },
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Add to composer" }));
    });

    const draft = nativeComposeDraft(useNativeComposeStore.getState(), sessionKey);
    expect(draft.text).toBe("my unsent words");
    expect(draft.annotations).toHaveLength(2);
    expect(draft.annotations[0]).toEqual(existing);
    expect(draft.annotations[1]).toMatchObject({ source: "design", comment: "Why is this blue?" });
    expect(draft.annotations[1]!.text).toContain("observed at canvas revision 12");
    expect(draft.annotations[1]!.text).not.toContain("hero markup");
    expect(createTabMock).not.toHaveBeenCalled();
    expect(commandCalls("design_session_link")).toHaveLength(0);
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  test("starts one new conversation without an initial prompt and links it once", async () => {
    seedTabs([]);
    let resolveLink: (value: unknown) => void = () => undefined;
    invokeMock.mockImplementation((command, args) => {
      if (command === "design_session_link") {
        const request = args?.link as Omit<DesignSessionLink, "id" | "createdAt">;
        return new Promise((resolve) => {
          resolveLink = () =>
            resolve({
              ok: true,
              value: { ...request, id: "new-link", createdAt: "2026-09-24T00:00:00Z" },
            });
        });
      }
      return Promise.resolve({
        ok: false,
        failure: { code: "unsupported", message: "no", retry: "never" },
      });
    });
    await renderDialog({});

    const start = screen.getByRole("button", { name: "Start a new conversation" });
    await act(async () => {
      fireEvent.click(start);
      fireEvent.click(start);
    });
    expect((start as HTMLButtonElement).disabled).toBe(true);
    await act(async () => {
      resolveLink(undefined);
    });

    expect(createTabMock).toHaveBeenCalledTimes(1);
    const [type, options] = createTabMock.mock.calls[0]!;
    expect(type).toBe("claude");
    expect(options).toMatchObject({ agentLaunchMode: "native" });
    expect(options?.initialPrompt).toBeUndefined();
    const links = commandCalls("design_session_link");
    expect(links).toHaveLength(1);
    expect(links[0]?.[1]).toMatchObject({
      environmentId: "env-1",
      canvasId: "canvas-1",
      link: { tabId: options!.tabId, platform: "claude", role: "design" },
    });
    // The unassigned composer sends text only, so the context is visible text.
    const draft = nativeComposeDraft(
      useNativeComposeStore.getState(),
      createSessionKey("env-1", options!.tabId!),
    );
    expect(draft.text).toContain("<orkestrator_transcript_annotations>");
    expect(draft.text).toContain("source=design");
  });

  test("builds an implementation handoff draft from the selected frames", async () => {
    seedTabs([]);
    invokeMock.mockImplementation((command, args) => {
      if (command === "design_history") {
        return Promise.resolve({
          ok: true,
          value: {
            entries: [{ id: "entry-7", canvasRevisionAfter: 9, label: "Tweak hero" }],
            total: 1,
            bytes: 0,
            limits: { entries: 50, bytes: 1 },
          },
        });
      }
      if (command === "design_session_link") {
        const request = args?.link as Omit<DesignSessionLink, "id" | "createdAt">;
        return Promise.resolve({
          ok: true,
          value: { ...request, id: "impl-link", createdAt: "2026-09-24T00:00:00Z" },
        });
      }
      return Promise.resolve({
        ok: false,
        failure: { code: "unsupported", message: "no", retry: "never" },
      });
    });
    await renderDialog({ context: { ...context, scope: "implement", checkpointId: "entry-7" } });

    expect(screen.getByText(/Tweak hero \(revision 9\)/)).toBeTruthy();
    fireEvent.click(screen.getByRole("checkbox", { name: "Pricing" }));
    fireEvent.change(screen.getByPlaceholderText("What should be built, and where?"), {
      target: { value: "Build the marketing page" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Codex" }));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Start a new conversation" }));
    });

    expect(createTabMock).toHaveBeenCalledTimes(1);
    const [type, options] = createTabMock.mock.calls[0]!;
    expect(type).toBe("codex");
    expect(options?.initialPrompt).toBeUndefined();
    expect(commandCalls("design_session_link")[0]?.[1]).toMatchObject({
      link: {
        tabId: options!.tabId,
        platform: "codex",
        role: "implementation",
        checkpointId: "entry-7",
      },
    });
    const draft = nativeComposeDraft(
      useNativeComposeStore.getState(),
      createSessionKey("env-1", options!.tabId!),
    );
    expect(draft.text).toContain("Build the marketing page");
    expect(draft.text).toContain("static visual reference");
    expect(draft.text).toContain('\\"Hero\\"');
    expect(draft.text).toContain('\\"Pricing\\"');
    expect(draft.text).toContain("checkpoint entry-7 (canvas revision 9)");
    expect(draft.text).not.toContain("markup");
  });
});
