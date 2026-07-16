import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { invoke } from "@/lib/native/backend";
import { useConfigStore } from "@/stores/configStore";
import { defaultConfig } from "../../../apps/backend/src/core/storage";

import * as realGlobalSettings from "../../../apps/web/src/components/settings/GlobalSettings";
const realGlobalSettingsSnapshot = { ...realGlobalSettings };
import * as previousFullscreenSettingsLayout from "../../../apps/web/src/components/settings/FullscreenSettingsLayout";
const previousFullscreenSettingsLayoutSnapshot = { ...previousFullscreenSettingsLayout };

mock.module("../../../apps/web/src/components/settings/GlobalSettings", () => ({
  GlobalSettings: ({ activeSection, onSaveSuccess }: { activeSection: string; onSaveSuccess?: () => void }) => (
    <div>
      <span data-testid="active-settings-section">{activeSection}</span>
      <button onClick={onSaveSuccess}>finish save</button>
    </div>
  ),
}));
mock.module("../../../apps/web/src/components/settings/FullscreenSettingsLayout", () => ({
  FullscreenSettingsLayout: ({
    open,
    menuItems,
    children,
  }: {
    open: boolean;
    menuItems: Array<{ id: string; label: string }>;
    children: (activeSection: string) => React.ReactNode;
  }) => {
    const [activeSection, setActiveSection] = useState(menuItems[0]?.id ?? "");
    if (!open) return null;
    return (
      <div>
        {menuItems.map((item) => (
          <button key={item.id} onClick={() => setActiveSection(item.id)}>{item.label}</button>
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
  mock.module("../../../apps/web/src/components/settings/GlobalSettings", () => realGlobalSettingsSnapshot);
  mock.module("../../../apps/web/src/components/settings/FullscreenSettingsLayout", () => previousFullscreenSettingsLayoutSnapshot);
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

    fireEvent.click(screen.getByRole("button", { name: "Review" }));
    expect(screen.getByTestId("active-settings-section").textContent).toBe("review");

    fireEvent.click(screen.getByRole("button", { name: "Web client" }));
    expect(screen.getByTestId("active-settings-section").textContent).toBe("web-client");
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
