import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { TRANSCRIPT_ARTIFACT_COMMANDS } from "@orkestrator/protocol/transcript-artifact-commands";
import { ARTIFACT_FRAME_CHANNEL } from "@orkestrator/protocol/artifact-frame-channel";
import { FRONTEND_RENDER_POLICY } from "@orkestrator/protocol/rich-content-policy";
import type { ArtifactHostApi, ArtifactHostEvent } from "@orkestrator/protocol/artifact-host-ipc";
import { invoke } from "@/lib/native/backend";
import { resetTranscriptArtifactCapabilities } from "@/hooks/useTranscriptArtifactCapabilities";
import {
  LIVE_HOST_INVALIDATION_REASONS,
  LIVE_HOSTS_PER_WINDOW,
  liveHostScopeInvalidation,
  useArtifactLiveHostStore,
  type LiveArtifactTarget,
} from "@/stores/artifactLiveHostStore";
import { useEnvironmentStore } from "@/stores/environmentStore";
import { useUIStore } from "@/stores/uiStore";
import type { Environment } from "@/types";
import { ArtifactLiveHost, ArtifactLivePlaceholder } from "./ArtifactLiveHost";

const invokeMock = invoke as unknown as ReturnType<typeof mock>;

function target(id: string, overrides: Partial<LiveArtifactTarget> = {}): LiveArtifactTarget {
  return {
    occurrenceKey: `occurrence-${id}`,
    publicationId: `pub_${id}abcdefgh`,
    artifactId: `art_${id}abcdefgh`,
    revision: 1,
    title: `Calculator ${id}`,
    scope: {
      backendId: "backend-1",
      environmentId: "env-1",
      logicalSessionKey: "s1",
      generation: "g1",
    },
    ...overrides,
  };
}

const CONTENT_ORIGIN = "http://127.0.0.1:9999";

let sessionCounter = 0;
function liveSessionFor(args: Record<string, unknown>) {
  sessionCounter += 1;
  const id = String(args.publicationId).slice(4, 5);
  return {
    contentUrl: `http://127.0.0.1:9999/artifact/${id}?cap=${sessionCounter}`,
    shellUrl: `${CONTENT_ORIGIN}/shell/${id}?cap=${sessionCounter}`,
    expiresAt: "2026-10-20T11:00:00.000Z",
    preparedSha256: "e".repeat(64),
    artifactId: `art_${id}abcdefgh`,
    revision: 1,
    generation: `live-gen-${sessionCounter}`,
    readinessNonce: "nonce-12345678",
  };
}

function calls(command: string): Array<Record<string, unknown>> {
  return invokeMock.mock.calls
    .filter((call) => call[0] === command)
    .map((call) => call[1] as Record<string, unknown>);
}

beforeEach(() => {
  sessionCounter = 0;
  resetTranscriptArtifactCapabilities();
  useArtifactLiveHostStore.getState().resetForTests();
  invokeMock.mockReset();
  invokeMock.mockImplementation((command: string, args: Record<string, unknown>) => {
    if (command === TRANSCRIPT_ARTIFACT_COMMANDS.capabilities) {
      return Promise.resolve({
        backendId: "backend-1",
        liveInteractive: true,
        rolloutFlags: { liveInteractive: true },
      });
    }
    if (command === TRANSCRIPT_ARTIFACT_COMMANDS.openLiveSession)
      return Promise.resolve(liveSessionFor(args));
    return Promise.resolve(undefined);
  });
});

afterEach(() => {
  cleanup();
  delete (window as { orkestrator?: unknown }).orkestrator;
});

/** The inline surface has no layout in happy-dom, so it is off-screen; query its chrome directly. */
function button(label: string): HTMLButtonElement {
  const element = document.querySelector(`[data-artifact-live-host] button[aria-label="${label}"]`);
  if (!element) throw new Error(`no button ${label}`);
  return element as HTMLButtonElement;
}

function buttonWithText(text: string): HTMLButtonElement {
  const element = Array.from(document.querySelectorAll("[data-artifact-live-host] button")).find(
    (candidate) => candidate.textContent?.includes(text),
  );
  if (!element) throw new Error(`no button with ${text}`);
  return element as HTMLButtonElement;
}

function frame(): HTMLIFrameElement {
  const element = document.querySelector("iframe[data-artifact-live-frame]");
  if (!element) throw new Error("no live frame");
  return element as HTMLIFrameElement;
}

function post(source: unknown, data: unknown, origin = CONTENT_ORIGIN) {
  act(() => {
    window.dispatchEvent(new MessageEvent("message", { data, origin, source: source as Window }));
  });
}

async function startA() {
  render(
    <>
      <ArtifactLivePlaceholder occurrenceKey="occurrence-a" />
      <ArtifactLiveHost />
    </>,
  );
  act(() => {
    useArtifactLiveHostStore.getState().request(target("a"));
  });
  await waitFor(() =>
    expect(document.querySelector("iframe[data-artifact-live-frame]")).not.toBeNull(),
  );
}

describe("ArtifactLiveHost (browser mode)", () => {
  test("loads the trusted viewer shell, never the document, sandboxed with no referrer", async () => {
    await startA();
    const iframe = frame();
    // The shell keeps its own (content, cross-site) origin and nothing else.
    expect(iframe.getAttribute("sandbox")).toBe("allow-scripts allow-same-origin");
    expect(iframe.getAttribute("referrerpolicy")).toBe("no-referrer");
    expect(iframe.getAttribute("src")).toBe(`${CONTENT_ORIGIN}/shell/a?cap=1`);
    for (const forbidden of [
      "allow-forms",
      "allow-popups",
      "allow-downloads",
      "allow-modals",
      "allow-top-navigation",
    ]) {
      expect(iframe.getAttribute("sandbox")).not.toContain(forbidden);
    }
    expect(LIVE_HOSTS_PER_WINDOW).toBe(FRONTEND_RENDER_POLICY.liveExecutableHostsPerWindow);
    expect(document.querySelectorAll("[data-artifact-live-host]")).toHaveLength(1);
  });

  test("starting another artifact offers a clear switch and keeps one host per window", async () => {
    await startA();
    let result: string | undefined;
    act(() => {
      result = useArtifactLiveHostStore.getState().request(target("b"));
    });
    expect(result).toBe("switch-pending");
    expect(useArtifactLiveHostStore.getState().active?.target.title).toBe("Calculator a");
    const dialog = await screen.findByRole("dialog");
    expect(dialog.textContent).toContain("Only one interactive artifact runs per window");
    fireEvent.click(screen.getByRole("button", { name: "Switch" }));
    await waitFor(() =>
      expect(frame().getAttribute("src")).toBe(`${CONTENT_ORIGIN}/shell/b?cap=2`),
    );
    expect(document.querySelectorAll("iframe[data-artifact-live-frame]")).toHaveLength(1);
    expect(calls(TRANSCRIPT_ARTIFACT_COMMANDS.closeLiveSession)).toContainEqual({
      generation: "live-gen-1",
    });
  });

  test("cancelling the switch keeps the running view", async () => {
    await startA();
    act(() => {
      useArtifactLiveHostStore.getState().request(target("b"));
    });
    fireEvent.click(await screen.findByRole("button", { name: "Keep current" }));
    expect(useArtifactLiveHostStore.getState().pendingSwitch).toBeNull();
    expect(frame().getAttribute("src")).toBe(`${CONTENT_ORIGIN}/shell/a?cap=1`);
  });

  test("placement changes keep the same document instance", async () => {
    await startA();
    const original = frame();
    fireEvent.click(button("Show in panel"));
    expect(
      document.querySelector("[data-artifact-live-host]")?.getAttribute("data-placement"),
    ).toBe("panel");
    expect(frame()).toBe(original);
    fireEvent.click(button("Full screen"));
    expect(frame()).toBe(original);
    fireEvent.click(button("Show inline"));
    expect(frame()).toBe(original);
  });

  test("only ready messages from the captured shell with the nonce open the channel; link requests need a click", async () => {
    await startA();
    const iframe = frame();
    // happy-dom does not load cross-origin frames; stand in for the shell's window.
    const source = { postMessage: mock((_message: unknown, _origin: string) => {}) };
    Object.defineProperty(iframe, "contentWindow", { configurable: true, value: source });
    const ready = {
      channel: ARTIFACT_FRAME_CHANNEL,
      v: 1,
      type: "ready",
      protocolVersion: 1,
      nonce: "nonce-12345678",
    };
    // Wrong source, or the right window from another origin: ignored.
    post(window, ready);
    post(source, ready, "http://localhost:9999");
    post(source, ready, "null");
    expect(useArtifactLiveHostStore.getState().active?.phase).toBe("loading");
    post(source, ready);
    await waitFor(() => expect(useArtifactLiveHostStore.getState().active?.phase).toBe("ready"));
    // The theme goes only to the captured shell window at its exact origin, after ready.
    expect(source.postMessage).toHaveBeenCalledTimes(1);
    const [theme, origin] = source.postMessage.mock.calls[0]!;
    expect(origin).toBe(CONTENT_ORIGIN);
    expect(theme).toMatchObject({
      channel: ARTIFACT_FRAME_CHANNEL,
      type: "theme",
      generation: "live-gen-1",
    });
    const identity = { artifactId: "art_aabcdefgh", revision: 1, generation: "live-gen-1" };
    // Wrong generation: ignored.
    post(source, {
      channel: ARTIFACT_FRAME_CHANNEL,
      v: 1,
      type: "link-request",
      url: "https://example.com/x",
      label: "Docs",
      ...identity,
      generation: "old",
    });
    expect(document.querySelector('[data-artifact-link-request="true"]') === null).toBe(true);
    post(source, { channel: ARTIFACT_FRAME_CHANNEL, v: 1, type: "size", height: 900, ...identity });
    await waitFor(() => expect(useArtifactLiveHostStore.getState().active?.frameHeight).toBe(900));
    post(source, {
      channel: ARTIFACT_FRAME_CHANNEL,
      v: 1,
      type: "link-request",
      url: "https://example.com/docs",
      label: "Docs",
      ...identity,
    });
    await waitFor(() => expect(buttonWithText("Open example.com")).toBeTruthy());
    const open = buttonWithText("Open example.com");
    expect(calls("open_in_browser")).toHaveLength(0);
    fireEvent.click(open);
    await waitFor(() =>
      expect(calls("open_in_browser")).toEqual([{ url: "https://example.com/docs" }]),
    );
  });

  test("an unexpected reload invalidates the channel and shows the saved preview with Reset", async () => {
    await startA();
    act(() => {
      useArtifactLiveHostStore.setState((state) => ({
        active: state.active
          ? {
              ...state.active,
              target: {
                ...state.active.target,
                previewDataUrl: "data:image/png;base64,iVBORw0KGgo=",
              },
            }
          : null,
      }));
    });
    const iframe = frame();
    fireEvent.load(iframe);
    fireEvent.load(iframe);
    await waitFor(() =>
      expect(useArtifactLiveHostStore.getState().active?.phase).toBe("navigation-blocked"),
    );
    expect(document.querySelector("iframe[data-artifact-live-frame]") === null).toBe(true);
    expect(document.querySelector('img[alt="Saved preview of Calculator a"]')).not.toBeNull();
    fireEvent.click(buttonWithText("Reset (new interaction session)"));
    await waitFor(() =>
      expect(frame().getAttribute("src")).toBe(`${CONTENT_ORIGIN}/shell/a?cap=2`),
    );
    expect(document.querySelector("[data-artifact-live-host]")?.textContent).toContain(
      "new interaction session 2",
    );
  });

  test("the shell's dispose notice ends the channel and shows the saved preview", async () => {
    await startA();
    act(() => {
      useArtifactLiveHostStore.setState((state) => ({
        active: state.active
          ? {
              ...state.active,
              target: {
                ...state.active.target,
                previewDataUrl: "data:image/png;base64,iVBORw0KGgo=",
              },
            }
          : null,
      }));
    });
    const source = { postMessage: mock((_message: unknown, _origin: string) => {}) };
    Object.defineProperty(frame(), "contentWindow", { configurable: true, value: source });
    const disposed = { channel: ARTIFACT_FRAME_CHANNEL, v: 1, type: "shell-disposed" };
    // Malformed, from another window, or from another origin: ignored.
    post(source, { ...disposed, reason: "bored" });
    post(window, { ...disposed, reason: "blocked-navigation" });
    post(source, { ...disposed, reason: "blocked-navigation" }, "http://evil.example");
    expect(useArtifactLiveHostStore.getState().active?.phase).toBe("loading");
    post(source, { ...disposed, reason: "blocked-navigation" });
    await waitFor(() =>
      expect(useArtifactLiveHostStore.getState().active?.phase).toBe("navigation-blocked"),
    );
    expect(document.querySelector("iframe[data-artifact-live-frame]") === null).toBe(true);
    expect(document.querySelector('img[alt="Saved preview of Calculator a"]')).not.toBeNull();
    expect(buttonWithText("Reset (new interaction session)")).toBeTruthy();
  });

  test("without a usable shell URL nothing is framed and the view fails closed", async () => {
    const cases: Array<Record<string, unknown>> = [
      { shellUrl: undefined },
      // On another origin than the document.
      { shellUrl: "http://localhost:9999/shell/a" },
      { shellUrl: "javascript:alert(1)" },
      // Never the application's own origin (the shell iframe keeps its origin).
      {
        contentUrl: `${window.location.origin}/a/x`,
        shellUrl: `${window.location.origin}/s/x`,
      },
    ];
    for (const overrides of cases) {
      cleanup();
      useArtifactLiveHostStore.getState().resetForTests();
      invokeMock.mockImplementation((command: string, args: Record<string, unknown>) => {
        if (command === TRANSCRIPT_ARTIFACT_COMMANDS.openLiveSession)
          return Promise.resolve({ ...liveSessionFor(args), ...overrides });
        return Promise.resolve(undefined);
      });
      render(<ArtifactLiveHost />);
      act(() => {
        useArtifactLiveHostStore.getState().request(target("a"));
      });
      await waitFor(() => expect(useArtifactLiveHostStore.getState().active?.phase).toBe("error"));
      expect(useArtifactLiveHostStore.getState().active?.message).toContain("viewer shell");
      expect(document.querySelector("iframe") === null).toBe(true);
    }
  });

  test("Stop ends only this view and releases its live capability", async () => {
    await startA();
    fireEvent.click(button("Stop interactive view"));
    expect(useArtifactLiveHostStore.getState().active).toBeNull();
    expect(document.querySelector("[data-artifact-live-host]") === null).toBe(true);
    expect(calls(TRANSCRIPT_ARTIFACT_COMMANDS.closeLiveSession)).toEqual([
      { generation: "live-gen-1" },
    ]);
  });

  test("a live session that arrives after Stop is released, never attached", async () => {
    let resolveOpen: (value: unknown) => void = () => {};
    invokeMock.mockImplementation((command: string, args: Record<string, unknown>) => {
      if (command === TRANSCRIPT_ARTIFACT_COMMANDS.openLiveSession) {
        return new Promise((resolve) => {
          resolveOpen = () => resolve(liveSessionFor(args));
        });
      }
      return Promise.resolve(undefined);
    });
    render(<ArtifactLiveHost />);
    act(() => {
      useArtifactLiveHostStore.getState().request(target("a"));
    });
    act(() => useArtifactLiveHostStore.getState().stop());
    await act(async () => resolveOpen(undefined));
    expect(useArtifactLiveHostStore.getState().active).toBeNull();
    await waitFor(() =>
      expect(calls(TRANSCRIPT_ARTIFACT_COMMANDS.closeLiveSession)).toEqual([
        { generation: "live-gen-1" },
      ]),
    );
  });
});

describe("ArtifactLiveHost (desktop host)", () => {
  test("uses the main-process host instead of an iframe and relays presentation events", async () => {
    const listeners = new Set<(event: ArtifactHostEvent) => void>();
    const api: ArtifactHostApi = {
      open: mock(async () => ({ ok: true as const })),
      setBounds: mock(async () => {}),
      setVisible: mock(async () => {}),
      postTheme: mock(async () => {}),
      close: mock(async () => {}),
      onEvent: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    };
    (window as { orkestrator?: unknown }).orkestrator = { artifactHost: api };
    render(<ArtifactLiveHost />);
    act(() => {
      useArtifactLiveHostStore.getState().request(target("a"));
    });
    await waitFor(() => expect(api.open).toHaveBeenCalled());
    expect(document.querySelector("iframe") === null).toBe(true);
    const hostId = useArtifactLiveHostStore.getState().active!.hostId;
    const opened = (api.open as ReturnType<typeof mock>).mock.calls[0]![0] as Record<
      string,
      unknown
    >;
    expect(opened).toMatchObject({
      hostId,
      contentUrl: "http://127.0.0.1:9999/artifact/a?cap=1",
      generation: "live-gen-1",
      readinessNonce: "nonce-12345678",
    });
    act(() => listeners.forEach((listener) => listener({ hostId, type: "ready" })));
    await waitFor(() => expect(api.postTheme).toHaveBeenCalled());
    const theme = (api.postTheme as ReturnType<typeof mock>).mock.calls[0]![1] as Record<
      string,
      unknown
    >;
    expect(theme).toMatchObject({
      type: "theme",
      generation: "live-gen-1",
      artifactId: "art_aabcdefgh",
    });
    // Events for another host id are ignored.
    act(() =>
      listeners.forEach((listener) => listener({ hostId: "other", type: "crashed", reason: "x" })),
    );
    expect(useArtifactLiveHostStore.getState().active?.phase).toBe("ready");
    act(() => listeners.forEach((listener) => listener({ hostId, type: "unresponsive" })));
    await waitFor(() =>
      expect(useArtifactLiveHostStore.getState().active?.phase).toBe("unresponsive"),
    );
    await waitFor(() => expect(api.close).toHaveBeenCalledWith(hostId));
    expect(buttonWithText("Reset (new interaction session)")).toBeTruthy();
  });
});

describe("ArtifactLiveHost scope invalidation", () => {
  const environment = (id: string) => ({ id, projectId: "p1", order: 0 }) as unknown as Environment;

  afterEach(() => {
    act(() => {
      useEnvironmentStore.setState({ environments: [], deletingEnvironments: new Set() });
      useUIStore.setState({ selectedEnvironmentId: null, selectedEnvironmentIds: [] });
    });
  });

  test("deleting the conversation's environment disposes the live view with a reason", async () => {
    act(() => {
      useEnvironmentStore.setState({ environments: [environment("env-1"), environment("env-2")] });
      useUIStore.setState({ selectedEnvironmentId: "env-1" });
    });
    await startA();
    act(() => useEnvironmentStore.getState().removeEnvironment("env-1"));
    expect(useArtifactLiveHostStore.getState().active).toBeNull();
    expect(useArtifactLiveHostStore.getState().ended).toEqual({
      occurrenceKey: "occurrence-a",
      environmentId: "env-1",
      reason: LIVE_HOST_INVALIDATION_REASONS.environmentDeleted,
    });
    expect(document.querySelector("[data-artifact-live-host]") === null).toBe(true);
    await waitFor(() =>
      expect(calls(TRANSCRIPT_ARTIFACT_COMMANDS.closeLiveSession)).toEqual([
        { generation: "live-gen-1" },
      ]),
    );
  });

  test("switching the active environment disposes it; unrelated changes do not", async () => {
    act(() => {
      useEnvironmentStore.setState({ environments: [environment("env-1"), environment("env-2")] });
      useUIStore.setState({ selectedEnvironmentId: "env-1" });
    });
    await startA();
    // An unrelated environment update keeps the view.
    act(() => useEnvironmentStore.getState().updateEnvironment("env-2", { name: "renamed" }));
    expect(useArtifactLiveHostStore.getState().active).not.toBeNull();
    act(() => useUIStore.setState({ selectedEnvironmentId: "env-2" }));
    expect(useArtifactLiveHostStore.getState().active).toBeNull();
    expect(useArtifactLiveHostStore.getState().ended?.reason).toBe(
      LIVE_HOST_INVALIDATION_REASONS.environmentChanged,
    );
    // Running again clears the recorded reason.
    act(() => {
      useArtifactLiveHostStore.getState().request(target("a"));
    });
    expect(useArtifactLiveHostStore.getState().ended).toBeNull();
  });

  test("a backend change disposes the view with a reason", async () => {
    await startA();
    invokeMock.mockImplementation((command: string, args: Record<string, unknown>) => {
      if (command === TRANSCRIPT_ARTIFACT_COMMANDS.capabilities) {
        return Promise.resolve({
          backendId: "backend-2",
          liveInteractive: true,
          rolloutFlags: { liveInteractive: true },
        });
      }
      if (command === TRANSCRIPT_ARTIFACT_COMMANDS.openLiveSession)
        return Promise.resolve(liveSessionFor(args));
      return Promise.resolve(undefined);
    });
    cleanup();
    resetTranscriptArtifactCapabilities();
    render(<ArtifactLiveHost />);
    await waitFor(() =>
      expect(useArtifactLiveHostStore.getState().ended?.reason).toBe(
        LIVE_HOST_INVALIDATION_REASONS.backendChanged,
      ),
    );
    expect(useArtifactLiveHostStore.getState().active).toBeNull();
  });

  test("liveHostScopeInvalidation is pure and conservative", () => {
    const snapshot = (
      overrides: Partial<Parameters<typeof liveHostScopeInvalidation>[1]> = {},
    ) => ({
      environmentIds: new Set(["env-1", "env-2"]),
      deletingIds: new Set<string>(),
      selectedEnvironmentId: "env-1",
      selectedEnvironmentIds: [] as string[],
      ...overrides,
    });
    expect(liveHostScopeInvalidation("env-1", snapshot(), snapshot())).toBeNull();
    expect(
      liveHostScopeInvalidation("env-1", snapshot(), snapshot({ deletingIds: new Set(["env-1"]) })),
    ).toBe(LIVE_HOST_INVALIDATION_REASONS.environmentDeleted);
    // A list that never contained the environment (still loading) is not a deletion.
    expect(
      liveHostScopeInvalidation(
        "env-1",
        snapshot({ environmentIds: new Set() }),
        snapshot({ environmentIds: new Set() }),
      ),
    ).toBeNull();
    // Deselecting (null) or multi-selecting with the environment kept is not a switch.
    expect(
      liveHostScopeInvalidation("env-1", snapshot(), snapshot({ selectedEnvironmentId: null })),
    ).toBeNull();
    expect(
      liveHostScopeInvalidation(
        "env-1",
        snapshot(),
        snapshot({ selectedEnvironmentId: "env-2", selectedEnvironmentIds: ["env-1", "env-2"] }),
      ),
    ).toBeNull();
  });
});

test.each(["logout", "credentials", "conversation"])(
  "%s clears active and pending views even with no mounted host",
  async (reason) => {
    const { clearProtectedRichContent, clearRichConversationContent } =
      await import("@/lib/chat/rich-content-reset");
    const store = useArtifactLiveHostStore.getState();
    store.request(target("a", { previewDataUrl: "data:image/png;base64,old" }));
    await waitFor(() => expect(useArtifactLiveHostStore.getState().active?.session).not.toBeNull());
    store.request(target("b", { previewDataUrl: "data:image/png;base64,also-old" }));
    if (reason === "conversation") clearRichConversationContent(target("a").scope);
    else clearProtectedRichContent(reason);
    expect(useArtifactLiveHostStore.getState().active).toBeNull();
    expect(useArtifactLiveHostStore.getState().pendingSwitch).toBeNull();
    expect(calls(TRANSCRIPT_ARTIFACT_COMMANDS.closeLiveSession)).toHaveLength(1);
  },
);

test("a session opened after credentials reset is released without being attached", async () => {
  const { clearProtectedRichContent } = await import("@/lib/chat/rich-content-reset");
  let finish!: (value: unknown) => void;
  invokeMock.mockImplementation((command: string) =>
    command === TRANSCRIPT_ARTIFACT_COMMANDS.openLiveSession
      ? new Promise((resolve) => {
          finish = resolve;
        })
      : Promise.resolve(),
  );
  useArtifactLiveHostStore
    .getState()
    .request(target("a", { previewDataUrl: "data:image/png;base64,old" }));
  clearProtectedRichContent("credentials");
  await act(async () => {
    finish(liveSessionFor({ publicationId: target("a").publicationId }));
    await Promise.resolve();
  });
  expect(useArtifactLiveHostStore.getState().active).toBeNull();
  expect(calls(TRANSCRIPT_ARTIFACT_COMMANDS.closeLiveSession)).toHaveLength(1);
});
