import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import {
  CONTAINER_HOST_REACHABILITY_CHANGED_EVENT,
  initialContainerHostReachability,
  type ContainerHostReachability,
} from "@orkestrator/protocol/container-host-reachability";
import * as realBackend from "@/lib/backend";
import * as realNativeEvents from "@/lib/native/events";

const realBackendSnapshot = { ...realBackend };
const realNativeEventsSnapshot = { ...realNativeEvents };

let current: ContainerHostReachability;
let afterCheck: ContainerHostReachability;
const getContainerHostReachability = mock(async () => current);
const checkContainerHostReachability = mock(async () => {
  current = afterCheck;
  return afterCheck;
});
const handlers = new Map<string, (event: { payload: unknown }) => unknown>();

mock.module("@/lib/backend", () => ({
  ...realBackendSnapshot,
  getContainerHostReachability,
  checkContainerHostReachability,
}));
mock.module("@/lib/native/events", () => ({
  ...realNativeEventsSnapshot,
  listen: async (event: string, handler: (event: { payload: unknown }) => unknown) => {
    handlers.set(event, handler);
    return () => handlers.delete(event);
  },
}));

afterAll(() => {
  mock.module("@/lib/backend", () => realBackendSnapshot);
  mock.module("@/lib/native/events", () => realNativeEventsSnapshot);
});

const { ContainerHostReachabilityNotice } = await import("./ContainerHostReachabilityNotice");

const FIX =
  "sudo ufw allow proto tcp from 172.16.0.0/12 to any port 38179 comment 'Orkestrator agent tools'";

const blocked: ContainerHostReachability = {
  status: "blocked",
  reason: null,
  summary:
    "Agents in Docker containers can't reach Orkestrator's agent tools server on port 38179: the connection timed out.",
  checkedAt: "2026-09-28T12:00:00.000Z",
  trigger: "boot",
  port: 38179,
  url: "http://host.docker.internal:38179/mcp",
  probeImage: "busybox:1.37-musl@sha256:abc",
  probes: [
    {
      scope: "default-bridge",
      network: "bridge",
      subnet: "172.17.0.0/16",
      containerId: null,
      outcome: "timeout",
      httpStatus: null,
      elapsedMs: 5300,
      detail: "wget: download timed out",
    },
  ],
  firewall: { kind: "ufw", detail: "ufw is enabled; default incoming policy DROP" },
  subnets: ["172.17.0.0/16"],
  remediation: {
    title: "Allow Docker containers through ufw",
    steps: ["The host firewall (ufw) is blocking Docker containers from connecting to port 38179."],
    commands: [FIX],
  },
};

const reachable: ContainerHostReachability = {
  ...blocked,
  status: "reachable",
  summary: "Docker containers can reach Orkestrator's agent tools server on port 38179.",
  remediation: null,
  probes: [{ ...blocked.probes[0]!, outcome: "reachable", httpStatus: 405 }],
};

beforeEach(() => {
  window.sessionStorage.clear();
  handlers.clear();
  getContainerHostReachability.mockClear();
  checkContainerHostReachability.mockClear();
});

afterEach(() => {
  cleanup();
});

describe("ContainerHostReachabilityNotice", () => {
  test("stays silent while connectivity is fine or unchecked", async () => {
    current = initialContainerHostReachability();
    render(<ContainerHostReachabilityNotice />);
    await waitFor(() => expect(getContainerHostReachability).toHaveBeenCalled());
    expect(screen.queryByTestId("container-host-reachability-banner")).toBeNull();

    await act(async () => {
      handlers.get(CONTAINER_HOST_REACHABILITY_CHANGED_EVENT)?.({ payload: reachable });
    });
    expect(screen.queryByTestId("container-host-reachability-banner")).toBeNull();
  });

  test("a blocked startup check opens the fix dialog once and keeps a banner", async () => {
    current = blocked;
    render(<ContainerHostReachabilityNotice />);

    expect(await screen.findByText("Docker containers can't reach Orkestrator")).toBeTruthy();
    expect(screen.getByTestId("container-host-reachability-commands").textContent).toBe(FIX);
    expect(screen.getByText("Allow Docker containers through ufw")).toBeTruthy();
    // The banner would cover the dialog's footer, so it waits for the dialog.
    expect(screen.queryByTestId("container-host-reachability-banner")).toBeNull();

    fireEvent.click(screen.getAllByRole("button", { name: "Close" }).at(-1)!);
    await waitFor(() =>
      expect(screen.queryByText("Docker containers can't reach Orkestrator")).toBeNull(),
    );
    expect(screen.getByTestId("container-host-reachability-banner")).toBeTruthy();

    // Remounting in the same session does not reopen it by itself.
    cleanup();
    render(<ContainerHostReachabilityNotice />);
    await screen.findByTestId("container-host-reachability-banner");
    expect(screen.queryByText("Docker containers can't reach Orkestrator")).toBeNull();
  });

  test("a live change event raises the warning without a refetch", async () => {
    current = initialContainerHostReachability();
    render(<ContainerHostReachabilityNotice />);
    await waitFor(() => expect(handlers.has(CONTAINER_HOST_REACHABILITY_CHANGED_EVENT)).toBe(true));
    await act(async () => {
      handlers.get(CONTAINER_HOST_REACHABILITY_CHANGED_EVENT)?.({ payload: blocked });
    });
    expect(await screen.findByText("Docker containers can't reach Orkestrator")).toBeTruthy();
    expect(getContainerHostReachability).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getAllByRole("button", { name: "Close" }).at(-1)!);
    expect(await screen.findByTestId("container-host-reachability-banner")).toBeTruthy();
  });

  test("Check again clears the warning once the firewall is fixed", async () => {
    current = blocked;
    afterCheck = reachable;
    render(<ContainerHostReachabilityNotice />);
    fireEvent.click(await screen.findByRole("button", { name: "Check again" }));
    await waitFor(() => expect(checkContainerHostReachability).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(screen.queryByTestId("container-host-reachability-banner")).toBeNull(),
    );
  });

  test("Hide suppresses the banner for this problem only", async () => {
    current = blocked;
    window.sessionStorage.setItem(
      "orkestrator.containerHostReachability.autoOpened",
      "blocked::38179",
    );
    render(<ContainerHostReachabilityNotice />);
    fireEvent.click(await screen.findByRole("button", { name: "Hide" }));
    expect(screen.queryByTestId("container-host-reachability-banner")).toBeNull();

    // A different problem (the port moved) is raised again.
    await act(async () => {
      handlers.get(CONTAINER_HOST_REACHABILITY_CHANGED_EVENT)?.({
        payload: { ...blocked, port: 40000 },
      });
    });
    expect(await screen.findByText("Docker containers can't reach Orkestrator")).toBeTruthy();
    fireEvent.click(screen.getAllByRole("button", { name: "Close" }).at(-1)!);
    expect(await screen.findByTestId("container-host-reachability-banner")).toBeTruthy();
  });
});
