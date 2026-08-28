import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { useState } from "react";
import { AgentPlatformPane } from "./AgentPlatformPane";
import type { AgentModelCatalog } from "@/lib/agent-launch";
import type { AgentSettingsTier } from "@orkestrator/protocol/agent-settings";

function setDesktopViewport(): void {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => true,
    }),
  });
}

beforeEach(() => {
  cleanup();
  setDesktopViewport();
});
afterEach(cleanup);

const catalog = { claude: [], codex: [], opencode: [] };

describe("AgentPlatformPane model refresh", () => {
  test("offers an environment-free refresh action", () => {
    const onRefreshModels = mock(() => undefined);
    render(
      <AgentPlatformPane
        platform="opencode"
        tier={{}}
        onChange={() => undefined}
        tiers={{ global: {} }}
        canInherit={false}
        catalog={catalog}
        onRefreshModels={onRefreshModels}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Refresh OpenCode models" }));

    expect(onRefreshModels).toHaveBeenCalledTimes(1);
    expect(screen.getByText(/without starting an environment/i)).toBeTruthy();
  });

  test("disables the action while a catalogue refresh is running", () => {
    render(
      <AgentPlatformPane
        platform="opencode"
        tier={{}}
        onChange={() => undefined}
        tiers={{ global: {} }}
        canInherit={false}
        catalog={catalog}
        onRefreshModels={() => undefined}
        refreshingModels
      />,
    );

    expect(
      screen.getByRole("button", { name: "Refresh OpenCode models" }).hasAttribute("disabled"),
    ).toBe(true);
  });

  test("explains repository scope and disables refresh when no scope exists", () => {
    render(
      <AgentPlatformPane
        platform="opencode"
        tier={{}}
        onChange={() => undefined}
        tiers={{ global: {} }}
        canInherit={false}
        catalog={catalog}
        onRefreshModels={() => undefined}
        refreshModelsDisabled
        modelCatalogScopeDescription="Add a repository to load and refresh OpenCode models."
      />,
    );

    expect(screen.getByText("Add a repository to load and refresh OpenCode models.")).toBeTruthy();
    const refresh = screen.getByRole("button", { name: "Refresh OpenCode models" });
    expect(refresh.hasAttribute("disabled")).toBe(true);
    expect(refresh.getAttribute("title")).toBe("Add or select a repository to refresh models");
  });

  test("keeps the environment guidance when no refresh action is available", () => {
    render(
      <AgentPlatformPane
        platform="opencode"
        tier={{}}
        onChange={() => undefined}
        tiers={{ global: {} }}
        canInherit={false}
        catalog={catalog}
      />,
    );

    expect(screen.queryByRole("button", { name: "Refresh OpenCode models" }) === null).toBe(true);
    expect(
      screen.getByText(/start an environment to load available opencode models/i),
    ).toBeTruthy();
  });
});

const cursorCatalog: AgentModelCatalog = {
  claude: [],
  codex: [],
  opencode: [],
  cursor: [
    {
      id: "grok-4.6",
      name: "Cursor Grok 4.6",
      reasoningEfforts: ["low", "high"],
      supportsSpeed: true,
    },
    { id: "default", name: "Auto", reasoningEfforts: [] },
  ],
};

function CursorSettingsHarness({
  onChange,
  initialFastMode,
}: {
  onChange: (tier: AgentSettingsTier) => void;
  initialFastMode?: boolean;
}) {
  const [tier, setTier] = useState<AgentSettingsTier>({
    platforms: { cursor: { model: "grok-4.6", fastMode: initialFastMode } },
  });
  return (
    <AgentPlatformPane
      platform="cursor"
      tier={tier}
      onChange={(next) => {
        setTier(next);
        onChange(next);
      }}
      tiers={{ global: tier }}
      canInherit={false}
      catalog={cursorCatalog}
    />
  );
}

describe("AgentPlatformPane Cursor speed", () => {
  test("offers Fast/Normal for a Cursor model that supports speed", () => {
    const onChange = mock((_tier: AgentSettingsTier) => undefined);
    render(<CursorSettingsHarness onChange={onChange} />);

    fireEvent.pointerDown(screen.getByRole("combobox", { name: "Cursor Agent default model" }));
    const speedGroup = screen.getByRole("group", { name: "Speed mode" });
    expect(
      within(speedGroup).getByRole("menuitemradio", { name: /Provider default/ }),
    ).toBeTruthy();

    fireEvent.click(within(speedGroup).getByRole("menuitemradio", { name: /^Fast/ }));

    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({
        platforms: expect.objectContaining({
          cursor: expect.objectContaining({ model: "grok-4.6", fastMode: true }),
        }),
      }),
    );
  });

  test("uses the first catalog model for speed capability when no model is pinned", () => {
    render(
      <AgentPlatformPane
        platform="cursor"
        tier={{}}
        onChange={() => undefined}
        tiers={{ global: {} }}
        canInherit={false}
        catalog={cursorCatalog}
      />,
    );

    fireEvent.pointerDown(screen.getByRole("combobox", { name: "Cursor Agent default model" }));
    const speedGroup = screen.getByRole("group", { name: "Speed mode" });
    expect(
      within(speedGroup)
        .getByRole("menuitemradio", { name: /^Fast/ })
        .hasAttribute("data-disabled"),
    ).toBe(false);
    expect(
      within(speedGroup)
        .getByRole("menuitemradio", { name: /^Normal/ })
        .hasAttribute("data-disabled"),
    ).toBe(false);
  });

  test("clears a stored speed choice through the inherit row", () => {
    const onChange = mock((_tier: AgentSettingsTier) => undefined);
    render(<CursorSettingsHarness onChange={onChange} initialFastMode />);

    fireEvent.pointerDown(screen.getByRole("combobox", { name: "Cursor Agent default model" }));
    const speedGroup = screen.getByRole("group", { name: "Speed mode" });
    fireEvent.click(within(speedGroup).getByRole("menuitemradio", { name: /Provider default/ }));

    expect(onChange.mock.calls.at(-1)?.[0].platforms?.cursor?.fastMode).toBeUndefined();
  });

  test("clears a stored speed choice when the selected model does not support it", () => {
    const onChange = mock((_tier: AgentSettingsTier) => undefined);
    render(<CursorSettingsHarness onChange={onChange} initialFastMode />);

    fireEvent.pointerDown(screen.getByRole("combobox", { name: "Cursor Agent default model" }));
    fireEvent.click(screen.getByRole("menuitemradio", { name: /Auto Cursor/ }));

    expect(onChange.mock.calls.at(-1)?.[0].platforms?.cursor).toMatchObject({ model: "default" });
    expect(onChange.mock.calls.at(-1)?.[0].platforms?.cursor?.fastMode).toBeUndefined();
  });

  test("does not offer speed on OpenCode", () => {
    render(
      <AgentPlatformPane
        platform="opencode"
        tier={{ platforms: { opencode: { model: "provider/model-a" } } }}
        onChange={() => undefined}
        tiers={{ global: { platforms: { opencode: { model: "provider/model-a" } } } }}
        canInherit={false}
        catalog={{
          claude: [],
          codex: [],
          opencode: [{ id: "provider/model-a", name: "Model A", reasoningEfforts: ["fast"] }],
        }}
      />,
    );

    fireEvent.pointerDown(screen.getByRole("combobox", { name: "OpenCode default model" }));
    expect(screen.queryByRole("group", { name: "Speed mode" }) === null).toBe(true);
  });
});
