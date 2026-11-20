import { afterEach, expect, test } from "bun:test";
import { cleanup, screen, waitFor, within } from "@testing-library/react";
import {
  LOCAL_BOUND_CONNECTION,
  connectionList,
  installDesktopFake,
  remoteConnection,
  sharedIdDataset,
  uninstallDesktopFake,
} from "@/test/federation-desktop-fake";
import { renderWithFederation } from "@/components/federation/federation-ui-test-fixture";
import { TitleBarConnectionSwitcher } from "./TitleBarConnectionSwitcher";

afterEach(() => {
  cleanup();
  uninstallDesktopFake();
});

function installFederation() {
  installDesktopFake({
    list: connectionList([remoteConnection("a", "Machine A", "teal")]),
    datasets: { a: sharedIdDataset("idle") },
  });
}

test("with federation on, it is the command-node switcher, named, with a separator after it", async () => {
  installFederation();
  renderWithFederation(<TitleBarConnectionSwitcher />);
  const trigger = await screen.findByTestId("command-node-switcher");
  const slot = screen.getByTestId("title-bar-connection");
  expect(slot.contains(trigger)).toBe(true);
  expect(slot.className).toContain("after:w-px");
  expect(within(trigger).getByTestId("command-node-name").textContent).not.toBe("");
  expect(within(trigger).getByTestId("command-node-icon")).toBeTruthy();
  expect(screen.queryByTestId("server-connection-switcher") === null).toBe(true);
});

test("compact, for the mobile title bar, it is an icon button that names the node in its label", async () => {
  installFederation();
  renderWithFederation(<TitleBarConnectionSwitcher compact />);
  const trigger = await screen.findByTestId("command-node-switcher");
  expect(trigger.getAttribute("aria-label")).toMatch(/^Command node: .+\. Switch command node$/);
  expect(trigger.textContent).toBe("");
  expect(trigger.className).toContain("h-9");
  expect(within(trigger).getByTestId("machine-color-dot")).toBeTruthy();
  expect(within(trigger).getByTestId("command-node-icon")).toBeTruthy();
  expect(screen.getByTestId("title-bar-connection").className).not.toContain("after:w-px");
});

test("with federation off, it is the saved server connection", async () => {
  installDesktopFake({
    list: {
      activeConnectionId: "local",
      connections: [LOCAL_BOUND_CONNECTION],
      features: { federation: true, sshRoutes: true, routeFallback: true },
      supportedRouteKinds: ["https", "ssh"],
    },
    datasets: {},
  });
  renderWithFederation(<TitleBarConnectionSwitcher />);
  const trigger = await screen.findByTestId("server-connection-switcher");
  await waitFor(() => expect(trigger.getAttribute("aria-label")).toBe("Connected server: Local"));
  expect(screen.queryByTestId("command-node-switcher") === null).toBe(true);
});
