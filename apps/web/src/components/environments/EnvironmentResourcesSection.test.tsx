import { afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { EnvironmentResourcePolicy } from "@orkestrator/protocol/container-resources";

import { invoke as nativeInvoke } from "@/lib/native/backend";
import { EnvironmentResourcesSection } from "./EnvironmentResourcesSection";

const invokeMock = nativeInvoke as unknown as ReturnType<typeof mock>;

const policy: EnvironmentResourcePolicy = {
  environmentId: "env-r",
  requested: { cpus: 2, memoryMiB: 4096, pids: null },
  source: "global",
  applied: { cpus: null, memoryMiB: null, pids: null },
  unsupported: [],
};

function install(update = mock((_args: Record<string, unknown>) => policy)) {
  invokeMock.mockClear();
  invokeMock.mockImplementation(async (command: string, args: Record<string, unknown> = {}) => {
    if (command === "get_environment_resources") return policy;
    if (command === "get_container_usage") {
      return {
        scope: "installation",
        sampledAt: new Date().toISOString(),
        stale: false,
        error: null,
        containers: [
          {
            containerId: "c1",
            environmentId: "env-r",
            state: "running",
            cpuCores: 1.25,
            memoryBytes: 1024 ** 3,
            memoryLimitBytes: null,
            pids: 12,
            oomKilled: false,
            exitCode: null,
          },
        ],
      };
    }
    if (command === "get_docker_capacity") {
      return {
        scope: "docker-daemon",
        cpus: 8,
        memoryBytes: 16 * 1024 ** 3,
        operatingSystem: "Linux",
        rootless: false,
        cgroupVersion: "2",
        support: { cpuQuota: true, memoryLimit: true, pidsLimit: true },
        disk: {
          imagesBytes: null,
          containersBytes: null,
          volumesBytes: null,
          buildCacheBytes: null,
          measuredAt: null,
        },
      };
    }
    if (command === "update_environment_resources") return update(args);
    return undefined;
  });
  return update;
}

describe("environment resources section", () => {
  afterEach(() => {
    cleanup();
    invokeMock.mockImplementation(() => Promise.resolve());
  });

  test("shows requested, applied and measured values separately", async () => {
    install();
    render(<EnvironmentResourcesSection environmentId="env-r" containerId="c1" dockerAvailable />);
    await screen.findByText(/2 CPU · 4 GB/);
    expect(screen.getByText("(default)")).toBeTruthy();
    expect(screen.getByText("unrestricted")).toBeTruthy();
    expect(screen.getByText(/1.25 cores · 1 GB · 12 processes/)).toBeTruthy();
    expect(screen.getByText(/runs with different limits than requested/)).toBeTruthy();
  });

  test("saves an environment override and applies it now", async () => {
    const update = install();
    render(<EnvironmentResourcesSection environmentId="env-r" containerId="c1" dockerAvailable />);
    await screen.findByText(/2 CPU · 4 GB/);
    fireEvent.click(
      screen.getByRole("checkbox", { name: "Use limits specific to this environment" }),
    );
    fireEvent.change(screen.getByLabelText("CPU cores"), { target: { value: "1.5" } });
    fireEvent.click(screen.getByRole("button", { name: "Save resource limits" }));
    await waitFor(() => expect(update).toHaveBeenCalledTimes(1));
    expect(update.mock.calls[0]?.[0]).toEqual({
      environmentId: "env-r",
      limits: { cpus: 1.5, memoryMiB: null, pids: null },
      applyNow: true,
    });
  });

  test("a limit below current use needs an explicit second confirmation", async () => {
    let calls = 0;
    const update = install(
      mock((args: Record<string, unknown>) => {
        calls += 1;
        if (!args.allowBelowUsage) {
          throw new Error(
            "ContainerLifecycleError:confirmation-required: The container is using nearly that much memory now.",
          );
        }
        return policy;
      }),
    );
    render(<EnvironmentResourcesSection environmentId="env-r" containerId="c1" dockerAvailable />);
    await screen.findByText(/2 CPU · 4 GB/);
    fireEvent.click(
      screen.getByRole("checkbox", { name: "Use limits specific to this environment" }),
    );
    fireEvent.change(screen.getByLabelText("CPU cores"), { target: { value: "1.5" } });
    fireEvent.click(screen.getByRole("button", { name: "Save resource limits" }));
    await screen.findByRole("button", { name: "Apply anyway" });
    expect(screen.getByRole("alert").textContent).toContain("nearly that much memory");
    fireEvent.click(screen.getByRole("button", { name: "Apply anyway" }));
    await waitFor(() => expect(calls).toBe(2));
    // The draft the user typed is what is confirmed, not a reloaded value.
    expect(update.mock.calls[1]?.[0]).toEqual({
      environmentId: "env-r",
      limits: { cpus: 1.5, memoryMiB: null, pids: null },
      applyNow: true,
      allowBelowUsage: true,
    });
  });

  test("a rootless daemon is named next to the applied values", async () => {
    install();
    const rootlessPolicy = { ...policy, daemonRootless: true };
    const base = invokeMock.getMockImplementation()!;
    invokeMock.mockImplementation(async (command: string, args?: Record<string, unknown>) =>
      command === "get_environment_resources" ? rootlessPolicy : base(command, args),
    );
    render(<EnvironmentResourcesSection environmentId="env-r" containerId="c1" dockerAvailable />);
    await screen.findByText(/Docker runs rootless/);
  });
});
