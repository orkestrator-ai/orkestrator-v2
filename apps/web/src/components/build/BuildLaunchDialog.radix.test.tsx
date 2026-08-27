import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useRef, useState } from "react";
import type { AgentModelCatalog } from "@/lib/agent-launch";
import { useConfigStore } from "@/stores/configStore";
import { BuildLaunchDialog } from "./BuildLaunchDialog";

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
  return (
    <>
      <button ref={triggerRef} type="button" onClick={() => setOpen(true)}>
        Open build launcher
      </button>
      <BuildLaunchDialog
        open={open}
        onOpenChange={setOpen}
        catalog={catalog}
        defaultAgent="claude"
        defaultEnvironmentType="local"
        returnFocusRef={triggerRef}
        onConfirm={() => undefined}
      />
    </>
  );
}

describe("BuildLaunchDialog with real Radix primitives", () => {
  test("keeps the narrow dialog accessible and restores trigger focus on Escape", async () => {
    render(<Harness />);
    const trigger = screen.getByRole("button", { name: "Open build launcher" });
    trigger.focus();
    fireEvent.click(trigger);

    const dialog = await screen.findByRole("dialog", { name: "Configure build" });
    await waitFor(() => expect(dialog.contains(document.activeElement)).toBe(true));
    expect(screen.getAllByRole("combobox")).toHaveLength(6);

    fireEvent.keyDown(dialog, { key: "Escape" });

    await waitFor(() => expect(screen.queryByRole("dialog") === null).toBe(true));
    await waitFor(() => expect(document.activeElement).toBe(trigger));
  });
});
