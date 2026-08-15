import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useRef, useState } from "react";
import { CreatePRDialog, type CreatePRSelection } from "./CreatePRDialog";
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

function Harness() {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const onConfirm = mock((_selection: CreatePRSelection) => undefined);
  return (
    <>
      <button ref={triggerRef} type="button" onClick={() => setOpen(true)}>Open PR dialog</button>
      <CreatePRDialog
        open={open}
        onOpenChange={setOpen}
        defaultAgent="claude"
        catalog={catalog}
        enabledAgents={["claude", "codex", "opencode"]}
        targetBranch="main"
        returnFocusRef={triggerRef}
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
      <button ref={fallbackRef} type="button">Open tools</button>
      <CreatePRDialog
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

describe("CreatePRDialog with real Radix primitives", () => {
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
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(trigger));
  });

  test("restores focus to a fallback when the original trigger has unmounted", async () => {
    render(<DisconnectedTriggerHarness />);
    await screen.findByRole("dialog", { name: "Configure pull request" });

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    const fallback = screen.getByRole("button", { name: "Open tools" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(fallback));
  });
});
