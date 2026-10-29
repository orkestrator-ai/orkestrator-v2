import { afterAll, afterEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import * as realSettingsPage from "@/components/settings/SettingsPage";
import { useAccountMachineStore } from "@/components/settings/account-machine";
import { requestAppShortcut } from "@/lib/app-shortcuts";
import { requestCloseGlobalSettings, requestGlobalSettings } from "@/lib/settings-navigation";
import { useGlobalSettingsStore } from "@/stores/globalSettingsStore";
import { GlobalSettingsHost } from "./GlobalSettingsHost";

// The real page loads config and every section; this file covers the host.
const realSettingsPageSnapshot = { ...realSettingsPage };
mock.module("@/components/settings/SettingsPage", () => ({
  ...realSettingsPageSnapshot,
  SettingsPage: ({
    open,
    onOpenChange,
    defaultSection,
    sectionRequest,
  }: {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    defaultSection?: string;
    sectionRequest?: number;
  }) =>
    open ? (
      <div>
        Global settings dialog
        {defaultSection ? <span>Default settings section: {defaultSection}</span> : null}
        <span>Settings section request: {sectionRequest}</span>
        <button onClick={() => onOpenChange(false)}>Close global settings</button>
      </div>
    ) : null,
}));

afterAll(() => {
  mock.module("@/components/settings/SettingsPage", () => realSettingsPageSnapshot);
});

afterEach(() => {
  cleanup();
  useGlobalSettingsStore.setState({ open: false, section: undefined, sectionRequest: 0 });
  useAccountMachineStore.setState({ chosen: undefined });
});

const requestText = () => screen.getByText(/Settings section request:/).textContent;

describe("GlobalSettingsHost", () => {
  test("renders nothing until Settings are asked for, then shows them while loading", async () => {
    render(<GlobalSettingsHost />);
    expect(screen.queryByText("Global settings dialog") === null).toBe(true);

    act(() => requestGlobalSettings("general"));
    expect(screen.getByRole("status", { name: "Loading global settings…" })).toBeTruthy();
    expect(
      await screen.findByText("Global settings dialog", undefined, { timeout: 10_000 }),
    ).toBeTruthy();
  });

  test("opens a requested section from another tree and follows each new request", async () => {
    render(<GlobalSettingsHost />);

    act(() => requestGlobalSettings("cursor"));
    expect(await screen.findByText("Default settings section: cursor")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Close global settings" }));
    expect(screen.queryByText("Global settings dialog") === null).toBe(true);

    act(() => requestGlobalSettings("grok"));
    expect(await screen.findByText("Default settings section: grok")).toBeTruthy();
    const firstRequest = requestText();

    // Asking again for the same section is a new request, so the open page
    // can return to it after the user moved elsewhere.
    act(() => requestGlobalSettings("grok"));
    await waitFor(() => expect(requestText()).not.toBe(firstRequest));
  });

  test("⌘, opens Settings on the first section and leaves an open page where it is", async () => {
    render(<GlobalSettingsHost />);

    fireEvent.keyDown(window, { key: ",", code: "Comma", metaKey: true });
    expect(await screen.findByText("Global settings dialog")).toBeTruthy();
    expect(screen.queryByText(/Default settings section:/) === null).toBe(true);

    act(() => requestGlobalSettings("terminal"));
    expect(await screen.findByText("Default settings section: terminal")).toBeTruthy();
    const request = requestText();
    // Ctrl+, too, and the desktop menu's Settings… (the same app shortcut).
    fireEvent.keyDown(window, { key: ",", code: "Comma", ctrlKey: true });
    act(() => requestAppShortcut("open-settings"));
    expect(screen.getByText("Default settings section: terminal")).toBeTruthy();
    expect(requestText()).toBe(request);
  });

  test("closing Settings resets an explicit account machine choice for the next visit", async () => {
    render(<GlobalSettingsHost />);
    act(() => requestGlobalSettings("general"));
    await screen.findByText("Global settings dialog");
    act(() => useAccountMachineStore.getState().choose(null));
    fireEvent.click(screen.getByRole("button", { name: "Close global settings" }));
    expect(useAccountMachineStore.getState().chosen).toBeUndefined();

    act(() => requestGlobalSettings("general"));
    await screen.findByText("Global settings dialog");
    act(() => useAccountMachineStore.getState().choose(null));
    // An action inside Settings that moves the user elsewhere closes them too.
    act(() => requestCloseGlobalSettings());
    expect(screen.queryByText("Global settings dialog") === null).toBe(true);
    expect(useAccountMachineStore.getState().chosen).toBeUndefined();
  });
});
