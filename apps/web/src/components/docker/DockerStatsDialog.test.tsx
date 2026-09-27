import { afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

import { invoke as nativeInvoke } from "@/lib/native/backend";
import type { ContainerInfo, DockerSystemStats } from "@/lib/backend";
import { DockerStatsDialog } from "./DockerStatsDialog";

const invokeMock = nativeInvoke as unknown as ReturnType<typeof mock>;

const unknownStats: DockerSystemStats = {
  memoryUsed: null,
  memoryTotal: null,
  cpus: null,
  cpuUsagePercent: null,
  diskUsed: null,
  diskTotal: null,
  containersRunning: 1,
  containersTotal: 2,
  imagesTotal: null,
  sampledAt: null,
  stale: true,
  cpuCoresUsed: null,
};

const container = (overrides: Partial<ContainerInfo>): ContainerInfo => ({
  id: "0123456789abcdef",
  name: "env",
  status: "Up",
  state: "running",
  image: "orkestrator-v2:latest",
  created: null,
  environmentId: "env-1",
  projectId: "project-1",
  isAssigned: true,
  cleanupExclusion: "assigned",
  cpuPercent: 250,
  memoryBytes: 1024 * 1024,
  oomKilled: false,
  oomEvents: 2,
  ...overrides,
});

function install(stats: DockerSystemStats, containers: ContainerInfo[]) {
  const calls: string[] = [];
  invokeMock.mockClear();
  invokeMock.mockImplementation(async (command: string) => {
    calls.push(command);
    if (command === "get_docker_system_stats") return stats;
    if (command === "get_orkestrator_containers") return containers;
    return undefined;
  });
  return calls;
}

describe("Docker stats dialog", () => {
  afterEach(() => {
    cleanup();
    invokeMock.mockImplementation(() => Promise.resolve());
  });

  test("what Docker did not report reads as unknown, never as zero", async () => {
    install(unknownStats, [container({})]);
    render(<DockerStatsDialog open onOpenChange={() => undefined} />);
    await screen.findByText(/Not measured: Docker did not answer/);
    expect(screen.getAllByText(/unknown/).length).toBeGreaterThanOrEqual(4);
    expect(screen.queryAllByText("0 B")).toHaveLength(0);
    expect(screen.queryAllByText(/0%/)).toHaveLength(0);
  });

  test("per-container figures are cores, a child's out-of-memory kills show while running", async () => {
    install(
      {
        ...unknownStats,
        memoryUsed: 2 * 1024 * 1024,
        memoryTotal: 8 * 1024 * 1024 * 1024,
        cpus: 8,
        cpuUsagePercent: 31.3,
        cpuCoresUsed: 2.5,
        sampledAt: new Date().toISOString(),
        stale: false,
      },
      [container({})],
    );
    render(<DockerStatsDialog open onOpenChange={() => undefined} />);
    await screen.findByText(/CPU: 2.50 cores/);
    expect(screen.getByText("2 out-of-memory kills")).toBeTruthy();
    expect(screen.getByText(/created time unknown/)).toBeTruthy();
    expect(screen.getByText(/2.5 cores/)).toBeTruthy();
    expect(screen.queryAllByText(/stale/)).toHaveLength(0);
  });

  test("refresh reloads both the figures and the containers", async () => {
    const calls = install(unknownStats, []);
    render(<DockerStatsDialog open onOpenChange={() => undefined} />);
    await screen.findByText(/Not measured/);
    const before = calls.filter((command) => command === "get_docker_system_stats").length;
    fireEvent.click(screen.getAllByRole("button", { name: "Refresh" })[0]!);
    await waitFor(() =>
      expect(calls.filter((command) => command === "get_docker_system_stats").length).toBe(
        before + 1,
      ),
    );
  });
});
