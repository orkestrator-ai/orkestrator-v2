import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { invoke } from "@/lib/native/backend";
import { useConfigStore } from "@/stores/configStore";
import { PLATFORM_ICON_CLASS } from "@/components/icons/AgentIcons";
import { AGENT_PLATFORMS } from "@orkestrator/protocol/agent-platforms";
import { defaultConfig } from "../../../apps/backend/src/core/storage";

import * as realGlobalSettings from "../../../apps/web/src/components/settings/GlobalSettings";
const realGlobalSettingsSnapshot = { ...realGlobalSettings };
import * as realSkillsSettings from "../../../apps/web/src/components/settings/SkillsSettings";
const realSkillsSettingsSnapshot = { ...realSkillsSettings };
import * as previousFullscreenSettingsLayout from "../../../apps/web/src/components/settings/FullscreenSettingsLayout";
const previousFullscreenSettingsLayoutSnapshot = { ...previousFullscreenSettingsLayout };

mock.module("../../../apps/web/src/components/settings/GlobalSettings", () => ({
  GlobalSettings: ({
    activeSection,
    onSaveSuccess,
  }: {
    activeSection: string;
    onSaveSuccess?: () => void;
  }) => (
    <div>
      <span data-testid="active-settings-section">{activeSection}</span>
      <button onClick={onSaveSuccess}>finish save</button>
    </div>
  ),
}));
mock.module("../../../apps/web/src/components/settings/SkillsSettings", () => ({
  SkillsSettings: () => <div data-testid="skills-settings">Skills browser</div>,
}));
mock.module("../../../apps/web/src/components/settings/FullscreenSettingsLayout", () => ({
  SettingsHeaderActions: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  FullscreenSettingsLayout: ({
    open,
    menuItems,
    children,
  }: {
    open: boolean;
    // The real layout renders `icon` beside `label`, so the stub has to as
    // well or nothing here can see what glyph a menu entry chose.
    menuItems: Array<{ id: string; label: string; icon: React.ReactNode }>;
    children: (activeSection: string) => React.ReactNode;
  }) => {
    const [activeSection, setActiveSection] = useState(menuItems[0]?.id ?? "");
    if (!open) return null;
    return (
      <div>
        {menuItems.map((item) => (
          <button
            key={item.id}
            data-testid={`menu-item-${item.id}`}
            onClick={() => setActiveSection(item.id)}
          >
            {item.icon}
            {item.label}
          </button>
        ))}
        {children(activeSection)}
      </div>
    );
  },
}));

const { SettingsPage } = await import("../../../apps/web/src/components/settings/SettingsPage");
const invokeMock = invoke as ReturnType<typeof mock>;
const originalConsoleError = console.error;

afterAll(() => {
  mock.module(
    "../../../apps/web/src/components/settings/GlobalSettings",
    () => realGlobalSettingsSnapshot,
  );
  mock.module(
    "../../../apps/web/src/components/settings/SkillsSettings",
    () => realSkillsSettingsSnapshot,
  );
  mock.module(
    "../../../apps/web/src/components/settings/FullscreenSettingsLayout",
    () => previousFullscreenSettingsLayoutSnapshot,
  );
});

describe("SettingsPage", () => {
  beforeEach(() => {
    cleanup();
    invokeMock.mockReset();
    invokeMock.mockResolvedValue(defaultConfig());
    useConfigStore.setState({ config: defaultConfig(), isLoading: false, error: null });
  });

  afterEach(() => {
    cleanup();
    console.error = originalConsoleError;
    invokeMock.mockReset();
    invokeMock.mockResolvedValue(undefined);
  });

  test("loads config and routes menu items to their settings sections", async () => {
    render(<SettingsPage open onOpenChange={() => undefined} />);

    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith("get_config"));
    expect(screen.getByTestId("active-settings-section").textContent).toBe("general");
    expect(
      screen
        .getAllByRole("button")
        .map((button) => button.textContent)
        .filter((label) => ["Claude", "Codex", "OpenCode"].includes(label ?? "")),
    ).toEqual(["Claude", "Codex", "OpenCode"]);

    fireEvent.click(screen.getByRole("button", { name: "Review" }));
    expect(screen.getByTestId("active-settings-section").textContent).toBe("review");

    fireEvent.click(screen.getByRole("button", { name: "Web client" }));
    expect(screen.getByTestId("active-settings-section").textContent).toBe("web-client");
  });

  test("draws every platform menu entry in its shared accent colour", async () => {
    render(<SettingsPage open onOpenChange={() => undefined} />);

    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith("get_config"));

    // The accent map is what makes each platform distinguishable at a glance,
    // so assert the colour rather than merely that some icon rendered. Reading
    // it from AgentIcons is deliberate: a menu entry that goes back to a bare
    // brand component, or grows a private colour override, fails here.
    for (const platform of AGENT_PLATFORMS) {
      const entry = screen.getByTestId(`menu-item-${platform}`);
      const icon = entry.querySelector("svg");

      expect(icon).not.toBeNull();
      expect(icon!.getAttribute("class")).toContain(PLATFORM_ICON_CLASS[platform]);
    }
  });

  test("gives every platform a menu entry, in the order the protocol lists them", async () => {
    render(<SettingsPage open onOpenChange={() => undefined} />);

    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith("get_config"));

    // MENU_ITEMS spells the six platforms out by hand, so a seventh platform
    // added to the protocol would otherwise silently have no settings pane.
    const menuOrder = screen
      .getAllByRole("button")
      .map((button) => button.getAttribute("data-testid"))
      .filter((id): id is string => id !== null)
      .map((id) => id.replace("menu-item-", ""))
      .filter((id) => (AGENT_PLATFORMS as readonly string[]).includes(id));

    expect(menuOrder).toEqual([...AGENT_PLATFORMS]);
  });

  test("shows the loading state until the first config request completes", async () => {
    let resolveConfig!: (config: ReturnType<typeof defaultConfig>) => void;
    invokeMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveConfig = resolve as typeof resolveConfig;
        }),
    );

    const { container } = render(<SettingsPage open onOpenChange={() => undefined} />);

    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith("get_config"));
    expect(container.querySelector(".animate-spin")).toBeTruthy();
    expect(screen.queryByTestId("active-settings-section") === null).toBe(true);

    resolveConfig(defaultConfig());
    expect(await screen.findByTestId("active-settings-section")).toBeTruthy();
    expect(container.querySelector(".animate-spin") === null).toBe(true);
  });

  test("opens the read-only Skills browser without waiting for config or rendering GlobalSettings", async () => {
    invokeMock.mockImplementationOnce(() => new Promise(() => undefined));

    const { container } = render(<SettingsPage open onOpenChange={() => undefined} />);

    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith("get_config"));
    expect(container.querySelector(".animate-spin")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Skills" }));

    expect(screen.getByTestId("skills-settings")).toBeTruthy();
    expect(screen.queryByTestId("active-settings-section") === null).toBe(true);
    expect(container.querySelector(".animate-spin") === null).toBe(true);
  });

  test("returns to GlobalSettings after leaving Skills once config resolves", async () => {
    let resolveConfig!: (config: ReturnType<typeof defaultConfig>) => void;
    invokeMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveConfig = resolve as typeof resolveConfig;
        }),
    );

    render(<SettingsPage open onOpenChange={() => undefined} />);
    fireEvent.click(screen.getByRole("button", { name: "Skills" }));
    expect(screen.getByTestId("skills-settings")).toBeTruthy();

    resolveConfig(defaultConfig());
    fireEvent.click(screen.getByRole("button", { name: "General" }));

    expect(await screen.findByTestId("active-settings-section")).toBeTruthy();
    expect(screen.queryByTestId("skills-settings") === null).toBe(true);
  });

  test("reuses a successful initial load when the page is reopened", async () => {
    const { rerender } = render(<SettingsPage open onOpenChange={() => undefined} />);
    await screen.findByTestId("active-settings-section");
    expect(invokeMock).toHaveBeenCalledTimes(1);

    rerender(<SettingsPage open={false} onOpenChange={() => undefined} />);
    rerender(<SettingsPage open onOpenChange={() => undefined} />);
    await Promise.resolve();
    await Promise.resolve();

    expect(invokeMock).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("active-settings-section")).toBeTruthy();
  });

  test("closes after a successful child save", async () => {
    const onOpenChange = mock(() => undefined);
    render(<SettingsPage open onOpenChange={onOpenChange} />);
    await screen.findByTestId("active-settings-section");

    fireEvent.click(screen.getByRole("button", { name: "finish save" }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  test("recovers from a config load failure and retries after reopening", async () => {
    const consoleError = mock(() => undefined);
    console.error = consoleError;
    invokeMock.mockRejectedValue(new Error("config unavailable"));
    const { rerender } = render(<SettingsPage open onOpenChange={() => undefined} />);

    await waitFor(() => expect(consoleError).toHaveBeenCalled());
    expect(screen.getByTestId("active-settings-section")).toBeTruthy();

    rerender(<SettingsPage open={false} onOpenChange={() => undefined} />);
    rerender(<SettingsPage open onOpenChange={() => undefined} />);
    await waitFor(() => expect(invokeMock).toHaveBeenCalledTimes(2));
  });
});
