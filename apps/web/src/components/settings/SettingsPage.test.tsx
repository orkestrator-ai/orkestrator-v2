import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { cleanup, render, screen } from "@testing-library/react";
import * as federation from "@/components/federation/FederationProvider";
import * as commandNode from "@/components/federation/useCommandNode";
import type { BackendId } from "@orkestrator/protocol/federation";
import { SettingsScopeBanner } from "./SettingsPage";

afterEach(() => {
  cleanup();
  mock.restore();
});

function installScope(enabled = true) {
  spyOn(federation, "useFederation").mockReturnValue({
    enabled,
    boundMachine: { name: "Leaf", colorToken: "teal" },
  } as never);
  spyOn(commandNode, "useCommandNode").mockReturnValue({
    nodeId: "bk_command" as BackendId,
    name: "Desk",
    colorToken: "teal",
    workspaceHere: false,
  });
}

test("scope banners name the owner of each section in a leaf window", () => {
  installScope();
  for (const section of [
    "platforms",
    "network",
    "docker",
    "container",
    "disk-usage",
    "skills",
    "sounds",
  ] as const) {
    const view = render(<SettingsScopeBanner section={section} />);
    expect(screen.getByTestId("settings-scope").textContent).toBe(
      "Machine settings for Leaf. Changes apply to this machine.",
    );
    view.unmount();
  }
  for (const section of ["review", "messaging"] as const) {
    const view = render(<SettingsScopeBanner section={section} />);
    expect(screen.getByTestId("settings-scope").textContent).toContain("Preferences for Desk");
    view.unmount();
  }
  for (const section of [
    "defaults",
    "terminal",
    "claude",
    "codex",
    "cursor",
    "grok",
    "opencode",
    "pi",
  ] as const) {
    const view = render(<SettingsScopeBanner section={section} />);
    expect(screen.getByTestId("settings-scope").textContent).toContain(
      "Preferences come from Desk",
    );
    expect(screen.getByTestId("settings-scope").textContent).toContain("belong to Leaf");
    view.unmount();
  }
  render(<SettingsScopeBanner section="machines" />);
  expect(screen.getByTestId("settings-scope").textContent).toContain("Command node: Desk");
});

test("single-machine windows only show scope for the Machines section", () => {
  installScope(false);
  const view = render(<SettingsScopeBanner section="network" />);
  const banner = screen.queryByTestId("settings-scope");
  expect(banner).toBeNull();
  view.rerender(<SettingsScopeBanner section="machines" />);
  expect(screen.getByTestId("settings-scope")).toBeTruthy();
});

test("the machine picked in the header owns its machine settings", () => {
  installScope();
  render(
    <SettingsScopeBanner section="network" machine={{ name: "Build box", colorToken: "amber" }} />,
  );
  expect(screen.getByTestId("settings-scope").textContent).toBe(
    "Machine settings for Build box. Changes apply to this machine.",
  );
  cleanup();
  render(
    <SettingsScopeBanner section="claude" machine={{ name: "Build box", colorToken: "amber" }} />,
  );
  expect(screen.getByTestId("settings-scope").textContent).toContain("belong to Build box");
});
