import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useRef, useState } from "react";
import { AgentLaunchDialog, type AgentLaunchSelection } from "./AgentLaunchDialog";
import type { AgentModelCatalog } from "@/lib/agent-launch";
import { useConfigStore } from "@/stores/configStore";

const catalog: AgentModelCatalog = {
  claude: [{ id: "claude-a", name: "Claude A", reasoningEfforts: ["high"] }],
  codex: [{ id: "codex-a", name: "Codex A", reasoningEfforts: ["medium"] }],
  opencode: [{ id: "provider/model-a", name: "OpenCode A", reasoningEfforts: [] }],
};

const originalMatchMedia = window.matchMedia;

beforeEach(() => {
  const config = useConfigStore.getState().config;
  useConfigStore.setState({
    config: {
      ...config,
      global: {
        ...config.global,
        enabledAgentPlatforms: ["claude", "codex", "opencode"],
        favoriteModels: [],
      },
    },
  });
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: (query: string): MediaQueryList => ({
      matches: query === "(max-width: 767px)",
      media: query,
      onchange: null,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      addListener: () => undefined,
      removeListener: () => undefined,
      dispatchEvent: () => true,
    }),
  });
});

afterEach(() => {
  cleanup();
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: originalMatchMedia,
  });
});

function Harness({
  kind,
  busy = false,
  initiallyOpen = false,
}: {
  kind?: "create-pr" | "resolve-conflicts";
  busy?: boolean;
  initiallyOpen?: boolean;
} = {}) {
  const [open, setOpen] = useState(initiallyOpen);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const onConfirm = mock((_selection: AgentLaunchSelection) => undefined);
  const triggerName = kind === "resolve-conflicts" ? "Open resolve dialog" : "Open PR dialog";
  return (
    <>
      <button ref={triggerRef} type="button" onClick={() => setOpen(true)}>
        {triggerName}
      </button>
      <AgentLaunchDialog
        kind={kind}
        open={open}
        onOpenChange={setOpen}
        defaultAgent="claude"
        catalog={catalog}
        enabledAgents={["claude", "codex", "opencode"]}
        targetBranch="main"
        returnFocusRef={triggerRef}
        busy={busy}
        onConfirm={onConfirm}
      />
    </>
  );
}

function DisconnectedTriggerHarness() {
  const [open, setOpen] = useState(true);
  const disconnectedTriggerRef = useRef<HTMLButtonElement>(document.createElement("button"));
  const fallbackRef = useRef<HTMLButtonElement>(null);
  return (
    <>
      <button ref={fallbackRef} type="button">
        Open tools
      </button>
      <AgentLaunchDialog
        open={open}
        onOpenChange={setOpen}
        defaultAgent="claude"
        catalog={catalog}
        enabledAgents={["claude", "codex", "opencode"]}
        targetBranch="main"
        returnFocusRef={disconnectedTriggerRef}
        returnFocusFallback={() => fallbackRef.current}
        onConfirm={() => undefined}
      />
    </>
  );
}

/**
 * The mobile case: the trigger is still mounted, but inside a collapsed tools
 * popover the user cannot see. The fallback therefore has to outrank a
 * perfectly connected `returnFocusRef`.
 */
function CollapsedTriggerHarness() {
  const [open, setOpen] = useState(true);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const fallbackRef = useRef<HTMLButtonElement>(null);
  return (
    <>
      <button ref={triggerRef} type="button">
        Create PR
      </button>
      <button ref={fallbackRef} type="button">
        Open tools
      </button>
      <AgentLaunchDialog
        open={open}
        onOpenChange={setOpen}
        defaultAgent="claude"
        catalog={catalog}
        enabledAgents={["claude", "codex", "opencode"]}
        targetBranch="main"
        returnFocusRef={triggerRef}
        returnFocusFallback={() => fallbackRef.current}
        onConfirm={() => undefined}
      />
    </>
  );
}

describe("AgentLaunchDialog with real Radix primitives", () => {
  test("keeps the narrow picker accessible and restores trigger focus on close", async () => {
    render(<Harness />);
    const trigger = screen.getByRole("button", { name: "Open PR dialog" });
    trigger.focus();
    fireEvent.click(trigger);

    const dialog = await screen.findByRole("dialog", { name: "Configure pull request" });
    await waitFor(() => expect(dialog.contains(document.activeElement)).toBe(true));

    const picker = screen.getByRole("combobox", { name: "Agent, model and reasoning" });
    fireEvent.pointerDown(picker);
    fireEvent.click(picker);

    expect(await screen.findByRole("group", { name: "Agent platforms" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "codex models" })).toBeTruthy();

    fireEvent.keyDown(document.body, { key: "Escape" });
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog") === null).toBe(true));
    await waitFor(() => expect(document.activeElement).toBe(trigger));
  });

  test("keeps the resolve picker accessible and restores trigger focus on close", async () => {
    render(<Harness kind="resolve-conflicts" />);
    const trigger = screen.getByRole("button", { name: "Open resolve dialog" });
    trigger.focus();
    fireEvent.click(trigger);

    const dialog = await screen.findByRole("dialog", { name: "Configure conflict resolution" });
    await waitFor(() => expect(dialog.contains(document.activeElement)).toBe(true));

    const picker = screen.getByRole("combobox", { name: "Agent, model and reasoning" });
    fireEvent.pointerDown(picker);
    fireEvent.click(picker);

    expect(await screen.findByRole("group", { name: "Agent platforms" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "codex models" })).toBeTruthy();

    fireEvent.keyDown(document.body, { key: "Escape" });
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog") === null).toBe(true));
    await waitFor(() => expect(document.activeElement).toBe(trigger));
  });

  test("ignores Escape and Cancel while a resolve launch is busy", async () => {
    render(<Harness kind="resolve-conflicts" busy initiallyOpen />);
    const dialog = await screen.findByRole("dialog", { name: "Configure conflict resolution" });

    fireEvent.keyDown(dialog, { key: "Escape" });
    fireEvent.keyDown(document.body, { key: "Escape" });
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    expect(screen.getByRole("dialog", { name: "Configure conflict resolution" })).toBeTruthy();
    expect(screen.getByRole("status").textContent).toContain("Launching");
  });

  test("prefers the fallback over a still-connected trigger", async () => {
    render(<CollapsedTriggerHarness />);
    await screen.findByRole("dialog", { name: "Configure pull request" });

    // An open modal hides everything outside it from the accessibility tree, so
    // both buttons are only queryable once the dialog has gone.
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog") === null).toBe(true));

    const trigger = screen.getByRole("button", { name: "Create PR" });
    const fallback = screen.getByRole("button", { name: "Open tools" });
    expect(trigger.isConnected).toBe(true);
    await waitFor(() => expect(document.activeElement).toBe(fallback));
    expect(document.activeElement).not.toBe(trigger);
  });

  test("restores focus to a fallback when the original trigger has unmounted", async () => {
    render(<DisconnectedTriggerHarness />);
    await screen.findByRole("dialog", { name: "Configure pull request" });

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    const fallback = screen.getByRole("button", { name: "Open tools" });
    await waitFor(() => expect(screen.queryByRole("dialog") === null).toBe(true));
    await waitFor(() => expect(document.activeElement).toBe(fallback));
  });
});
