import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

import { invoke as nativeInvoke } from "@/lib/native/backend";
import type { ContainerInfo, DockerSystemStats } from "@/lib/backend";
import { DockerAvailabilityProvider } from "@/contexts/DockerAvailabilityContext";
import { AccountMachineProvider } from "@/components/settings/account-machine";
import { DockerSettings } from "./DockerSettings";

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
    if (command === "get_projects") return [];
    return undefined;
  });
  return calls;
}

describe("Docker settings section", () => {
  test("an unassigned pre-label container can be reattached", async () => {
    install(unknownStats, [container({ isAssigned: false, cleanupExclusion: "legacy-unadopted" })]);
    render(<DockerSettings />);
    expect(await screen.findByTitle("Reattach to project")).toBeTruthy();
    expect(screen.getByText("Legacy")).toBeTruthy();
    expect(screen.queryByText("Protected") === null).toBe(true);
  });
  afterEach(() => {
    cleanup();
    invokeMock.mockImplementation(() => Promise.resolve());
  });

  test("what Docker did not report reads as unknown, never as zero", async () => {
    install(unknownStats, [container({})]);
    render(<DockerSettings />);
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
    render(<DockerSettings />);
    await screen.findByText(/CPU: 2.50 cores/);
    expect(screen.getByText("2 out-of-memory kills")).toBeTruthy();
    expect(screen.getByText(/created time unknown/)).toBeTruthy();
    expect(screen.getByText(/2.5 cores/)).toBeTruthy();
    expect(screen.queryAllByText(/stale/)).toHaveLength(0);
  });

  test("refresh reloads both the figures and the containers", async () => {
    const calls = install(unknownStats, []);
    render(<DockerSettings />);
    await screen.findByText(/Not measured/);
    const before = calls.filter((command) => command === "get_docker_system_stats").length;
    fireEvent.click(screen.getAllByRole("button", { name: "Refresh" })[0]!);
    await waitFor(() =>
      expect(calls.filter((command) => command === "get_docker_system_stats").length).toBe(
        before + 1,
      ),
    );
  });

  test("asks for Docker when it is not running, without calling it", async () => {
    const calls = install(unknownStats, []);
    render(
      <DockerAvailabilityProvider available={false}>
        <DockerSettings />
      </DockerAvailabilityProvider>,
    );
    expect(screen.getByText(/Docker is not running/)).toBeTruthy();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(calls).toHaveLength(0);
  });

  test("Docker stopping unmounts the panel and stops its polling until it returns", async () => {
    const callbacks = new Map<number, () => void>();
    let nextId = 0;
    spyOn(globalThis, "setInterval").mockImplementation(((callback: () => void) => {
      callbacks.set(++nextId, callback);
      return nextId;
    }) as typeof setInterval);
    spyOn(globalThis, "clearInterval").mockImplementation(((id: number) => {
      callbacks.delete(id);
    }) as typeof clearInterval);
    try {
      const calls = install(unknownStats, []);
      const view = render(
        <DockerAvailabilityProvider available>
          <DockerSettings />
        </DockerAvailabilityProvider>,
      );
      await screen.findByText("System Resources");
      await act(async () => {
        for (const callback of callbacks.values()) callback();
      });
      expect(calls.filter((command) => command === "get_docker_system_stats")).toHaveLength(2);
      view.rerender(
        <DockerAvailabilityProvider available={false}>
          <DockerSettings />
        </DockerAvailabilityProvider>,
      );
      expect(screen.getByText(/Docker is not running/)).toBeTruthy();
      expect(screen.queryByText("System Resources")).toBeNull();
      expect(callbacks.size).toBe(0);
      view.rerender(
        <DockerAvailabilityProvider available>
          <DockerSettings />
        </DockerAvailabilityProvider>,
      );
      await screen.findByText("System Resources");
      expect(calls.filter((command) => command === "get_docker_system_stats")).toHaveLength(3);
      view.unmount();
      expect(callbacks.size).toBe(0);
    } finally {
      cleanup();
      mock.restore();
    }
  });

  test("remote availability ignores the window status and stops reads when remote Docker stops", async () => {
    const callbacks = new Map<number, { callback: () => void; delay: number | undefined }>();
    let nextId = 0;
    spyOn(globalThis, "setInterval").mockImplementation(((callback: () => void, delay?: number) => {
      callbacks.set(++nextId, { callback, delay });
      return nextId;
    }) as typeof setInterval);
    spyOn(globalThis, "clearInterval").mockImplementation(((id: number) => {
      callbacks.delete(id);
    }) as typeof clearInterval);
    let available = true;
    const calls: string[] = [];
    const remote = mock(async (_command: string, args: Record<string, unknown> = {}) => {
      const command = args.command as string;
      calls.push(command);
      const result =
        command === "check_docker"
          ? { available, reason: null }
          : command === "get_docker_system_stats"
            ? unknownStats
            : command === "get_orkestrator_containers" || command === "get_projects"
              ? []
              : undefined;
      return { outcome: "ok", result };
    });
    window.orkestratorPortal = { invoke: remote } as never;
    invokeMock.mockClear();
    try {
      const view = render(
        <DockerAvailabilityProvider available={false}>
          <AccountMachineProvider value={{ machine: "bk_remote", name: "Build box" }}>
            <DockerSettings />
          </AccountMachineProvider>
        </DockerAvailabilityProvider>,
      );
      await screen.findByText("System Resources");
      available = false;
      // The first timer belongs to the availability probe; the panel has its own timer.
      const probe = [...callbacks.values()].find(({ delay }) => delay === 5_000)!;
      await act(async () => probe.callback());
      expect(screen.getByText(/Docker is not running/)).toBeTruthy();
      expect(screen.queryByText("System Resources")).toBeNull();
      expect(callbacks.size).toBe(1);
      const statsReads = calls.filter((command) => command === "get_docker_system_stats").length;
      await act(async () => probe.callback());
      expect(calls.filter((command) => command === "get_docker_system_stats")).toHaveLength(
        statsReads,
      );
      expect(invokeMock).not.toHaveBeenCalled();
      view.unmount();
      expect(callbacks.size).toBe(0);
    } finally {
      cleanup();
      delete window.orkestratorPortal;
      mock.restore();
    }
  });
});
