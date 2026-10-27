import { afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import {
  initialContainerHostReachability,
  type ContainerHostReachability,
} from "@orkestrator/protocol/container-host-reachability";

import { invoke as nativeInvoke } from "@/lib/native/backend";
import { EnvironmentAgentToolsStatus } from "./EnvironmentAgentToolsStatus";
import { expectDomAbsent } from "../../../../../tests/bounded-test-diagnostics";

const invokeMock = nativeInvoke as unknown as ReturnType<typeof mock>;

function serve(value: ContainerHostReachability) {
  invokeMock.mockClear();
  invokeMock.mockImplementation(async (command: string) =>
    command === "get_container_host_reachability" ? value : undefined,
  );
}

const rootlessBlocked: ContainerHostReachability = {
  ...initialContainerHostReachability(),
  status: "blocked",
  reason: null,
  summary:
    "Agents in Docker containers can't reach Orkestrator's agent tools server on port 38179.",
  checkedAt: "2026-10-26T00:00:00.000Z",
  port: 38179,
  url: "http://host.docker.internal:38179/mcp",
  dockerRootless: true,
  remediation: {
    title: "Let rootless Docker containers reach Orkestrator",
    steps: ["Allow host loopback."],
    commands: ["systemctl --user restart docker"],
  },
};

describe("environment agent tools status", () => {
  afterEach(() => {
    cleanup();
    invokeMock.mockImplementation(() => Promise.resolve());
  });

  test("says the environment's agent tools are unavailable on a blocked rootless host", async () => {
    serve(rootlessBlocked);
    render(<EnvironmentAgentToolsStatus />);
    const status = await screen.findByTestId("environment-agent-tools-status");
    expect(status.textContent).toContain("Agent tools unavailable");
    expect(status.textContent).toContain("Docker runs rootless");
    fireEvent.click(screen.getByRole("button", { name: "How to fix" }));
    await screen.findByText("Let rootless Docker containers reach Orkestrator");
    expect(screen.getByText("Rootless")).toBeTruthy();
  });

  test("names the host firewall when Docker is rootful", async () => {
    serve({ ...rootlessBlocked, dockerRootless: false });
    render(<EnvironmentAgentToolsStatus />);
    const status = await screen.findByTestId("environment-agent-tools-status");
    expect(status.textContent).toContain("A firewall on this computer");
  });

  test("shows nothing while containers can reach the tools server", async () => {
    serve({ ...rootlessBlocked, status: "reachable", remediation: null, hostAddress: "10.0.2.2" });
    render(<EnvironmentAgentToolsStatus />);
    await waitFor(() => expect(invokeMock).toHaveBeenCalled());
    expectDomAbsent(
      screen.queryByTestId("environment-agent-tools-status"),
      "agent tools status while reachable",
    );
  });
});
