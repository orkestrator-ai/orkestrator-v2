import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { StrictMode } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { EnvironmentProcessGroup } from "@/lib/backend";
import { Button, buttonVariants } from "@/components/ui/button";
import { invoke as nativeInvoke } from "@/lib/native/backend";
import { useProjectStore } from "@/stores";
import { SYSTEM_USAGE_STALE_AFTER_MS } from "./AgentInfoButton.panels";
import {
  ENVIRONMENT_PROCESS_POLL_INTERVAL_MS,
  SYSTEM_USAGE_POLL_INTERVAL_MS,
  SystemUsageIndicator,
  environmentProcessGroupCount,
  environmentProcessGroupCpu,
  environmentProcessGroupRamKb,
  formatProcessRamKb,
  mergeFrozenEnvironmentIds,
  orderEnvironmentProcessGroups,
  sanitizeProcessCommand,
  sortEnvironmentProcessGroupsByCpu,
} from "./SystemUsageIndicator";

const nativeInvokeMock = nativeInvoke as ReturnType<typeof mock>;

function usageSnapshot(overrides: Record<string, unknown> = {}) {
  return {
    cpuPercent: 12.4,
    ramPercent: 47.6,
    gpuPercent: null,
    diskPercent: 63.2,
    sampledAt: new Date().toISOString(),
    ...overrides,
  };
}

function withProcessTotals(
  group: Omit<EnvironmentProcessGroup, "totalCpuPercent" | "totalRssKb" | "processCount"> &
    Partial<
      Pick<EnvironmentProcessGroup, "totalCpuPercent" | "totalRssKb" | "processCount" | "truncated">
    >,
): EnvironmentProcessGroup {
  return {
    truncated: false,
    totalCpuPercent: group.processes.reduce((total, process) => total + process.cpuPercent, 0),
    totalRssKb: group.processes.reduce((total, process) => total + process.rssKb, 0),
    processCount: group.processes.length,
    ...group,
  };
}

function processSnapshot(overrides: Record<string, unknown> = {}) {
  return {
    sampledAt: new Date().toISOString(),
    truncated: false,
    environments: [
      withProcessTotals({
        environmentId: "env-local",
        environmentName: "title-bar-layout",
        projectId: "project-1",
        environmentType: "local",
        processes: [
          {
            pid: 11,
            name: "node",
            command: "/usr/local/bin/node server.js",
            cpuPercent: 18.2,
            ramPercent: 4.4,
            rssKb: 120_000,
          },
        ],
      }),
      withProcessTotals({
        environmentId: "env-box",
        environmentName: "review-box",
        projectId: "project-2",
        environmentType: "containerized",
        processes: [],
      }),
    ],
    ...overrides,
  };
}

function isPopoverOpen(): boolean {
  return screen.queryByRole("dialog", { name: "Environment process usage" }) !== null;
}

function popover(): HTMLElement {
  return document.getElementById("environment-process-usage-popover")!;
}

function openPanel() {
  fireEvent.click(screen.getByRole("button", { name: "Open environment process usage" }));
}

function processGroup(
  environmentId: string,
  environmentName: string,
  cpuPercent: number,
): EnvironmentProcessGroup {
  return withProcessTotals({
    environmentId,
    environmentName,
    projectId: "project-1",
    environmentType: "local",
    processes:
      cpuPercent === 0
        ? []
        : [
            {
              pid: 11,
              name: "node",
              command: "node",
              cpuPercent,
              ramPercent: 1,
              rssKb: 10,
            },
          ],
  });
}

function listedEnvironmentNames(): string[] {
  return screen
    .getAllByLabelText(/ processes$/)
    .map((section) => section.getAttribute("aria-label")?.replace(/ processes$/, "") ?? "");
}

describe("SystemUsageIndicator", () => {
  beforeEach(() => {
    nativeInvokeMock.mockReset();
    nativeInvokeMock.mockImplementation(async (command: string) => {
      if (command === "get_system_usage") return usageSnapshot();
      if (command === "get_environment_process_usage") return processSnapshot();
      return undefined;
    });
    useProjectStore.setState({
      projects: [
        {
          id: "project-1",
          name: "orkestrator-v2",
          gitUrl: "git@example.com:org/repo.git",
          localPath: null,
          addedAt: "2026-09-13T00:00:00.000Z",
          order: 0,
        },
      ],
    });
  });

  afterEach(() => {
    cleanup();
    useProjectStore.setState({ projects: [] });
  });

  test("renders rounded CPU, RAM, GPU and disk readings", async () => {
    render(<SystemUsageIndicator />);

    await waitFor(() =>
      expect(screen.getByLabelText("Central processing unit (CPU) usage: 12%")).toBeTruthy(),
    );
    expect(screen.getByLabelText("Random-access memory (RAM) usage: 48%")).toBeTruthy();
    expect(screen.getByLabelText("Graphics processing unit (GPU) usage: —")).toBeTruthy();
    expect(screen.getByLabelText("Disk storage usage: 63%")).toBeTruthy();
    expect(screen.getAllByRole("img")).toHaveLength(4);
  });

  test("shows unavailable readings until a snapshot arrives", async () => {
    nativeInvokeMock.mockImplementation(async () => undefined);

    render(<SystemUsageIndicator />);

    await waitFor(() => expect(screen.getByTestId("system-usage-indicator")).toBeTruthy());
    expect(screen.getAllByRole("img").map((metric) => metric.textContent)).toEqual([
      "—",
      "—",
      "—",
      "—",
    ]);
  });

  test("polls on its own cadence and keeps the last reading across a failure", async () => {
    let calls = 0;
    nativeInvokeMock.mockImplementation(async (command: string) => {
      if (command !== "get_system_usage") return undefined;
      calls += 1;
      if (calls === 1) return usageSnapshot({ cpuPercent: 10, ramPercent: 20 });
      throw new Error("backend unavailable");
    });

    const timers: Array<() => unknown> = [];
    const originalSetTimeout = window.setTimeout;
    window.setTimeout = ((handler: TimerHandler, timeout?: number, ...args: unknown[]) => {
      if (timeout === SYSTEM_USAGE_POLL_INTERVAL_MS && typeof handler === "function") {
        timers.push(() => handler());
        return 9_000 + timers.length;
      }
      return originalSetTimeout(handler, timeout, ...args);
    }) as typeof window.setTimeout;

    try {
      render(<SystemUsageIndicator />);
      await waitFor(() => expect(calls).toBe(1));
      expect(screen.getByLabelText("Central processing unit (CPU) usage: 10%")).toBeTruthy();

      await act(async () => {
        timers.shift()?.();
      });
      await waitFor(() => expect(calls).toBe(2));
      // The rejected read must not blank a reading the backend already gave us.
      expect(screen.getByLabelText("Central processing unit (CPU) usage: 10%")).toBeTruthy();
      expect(screen.getByLabelText("Random-access memory (RAM) usage: 20%")).toBeTruthy();
    } finally {
      window.setTimeout = originalSetTimeout;
    }
  });

  test("opens a process panel from the meters and groups rows by environment", async () => {
    render(<SystemUsageIndicator />);
    await waitFor(() => expect(screen.getByLabelText("Disk storage usage: 63%")).toBeTruthy());

    expect(isPopoverOpen()).toBe(false);
    expect(popover().className).toContain("invisible");
    expect(
      nativeInvokeMock.mock.calls.some((call) => call[0] === "get_environment_process_usage"),
    ).toBe(false);

    openPanel();
    expect(isPopoverOpen()).toBe(true);
    expect(
      screen
        .getAllByRole("button", { name: "Close environment process usage" })[0]!
        .getAttribute("aria-expanded"),
    ).toBe("true");

    await waitFor(() => expect(screen.getByLabelText("title-bar-layout processes")).toBeTruthy());
    expect(screen.getByText("Process (1)")).toBeTruthy();
    expect(screen.getByText("CPU")).toBeTruthy();
    expect(screen.getByText("RAM")).toBeTruthy();
    expect(screen.getByText("orkestrator-v2 · local")).toBeTruthy();
    expect(screen.getByText("node")).toBeTruthy();
    expect(screen.getAllByText("18%")).toHaveLength(2);
    expect(screen.getAllByText("117 MB")).toHaveLength(2);
    expect(screen.getByLabelText("title-bar-layout total usage: 18% CPU, 117 MB RAM")).toBeTruthy();
    expect(screen.getByLabelText("review-box processes")).toBeTruthy();
    expect(screen.getByText("No processes")).toBeTruthy();
    expect(
      screen.getByRole("group", { name: "review-box total usage: 0% CPU, 0 MB RAM" }),
    ).toBeTruthy();
    expect(screen.queryByText("Process (0)") === null).toBe(true);
  });

  test("shows summed CPU and RAM to the right of each environment name", async () => {
    nativeInvokeMock.mockImplementation(async (command: string) => {
      if (command === "get_system_usage") return usageSnapshot();
      if (command === "get_environment_process_usage") {
        return processSnapshot({
          environments: [
            {
              environmentId: "env-busy",
              environmentName: "busy-box",
              projectId: "project-1",
              environmentType: "local",
              processes: [
                {
                  pid: 11,
                  name: "node",
                  command: "node",
                  cpuPercent: 12.4,
                  ramPercent: 2,
                  rssKb: 80_000,
                },
                {
                  pid: 12,
                  name: "bun",
                  command: "bun",
                  cpuPercent: 7.6,
                  ramPercent: 1,
                  rssKb: 40_000,
                },
              ],
            },
          ],
        });
      }
      return undefined;
    });

    render(<SystemUsageIndicator />);
    openPanel();
    const section = await waitFor(() => screen.getByLabelText("busy-box processes"));
    const totals = within(section).getByRole("group", {
      name: "busy-box total usage: 20% CPU, 117 MB RAM",
    });
    expect(section.textContent?.indexOf("busy-box") ?? -1).toBeLessThan(
      section.textContent?.indexOf("20%") ?? -1,
    );
    expect(section.textContent?.indexOf("20%") ?? -1).toBeLessThan(
      section.textContent?.indexOf("orkestrator-v2") ?? -1,
    );
    expect(section.textContent?.indexOf("orkestrator-v2") ?? -1).toBeLessThan(
      section.textContent?.indexOf("Process (2)") ?? -1,
    );
    expect(totals.textContent).toContain("20%");
    expect(totals.textContent).toContain("117 MB");
    expect(within(section).getByText("Process (2)")).toBeTruthy();
    expect(within(section).getByText("12%")).toBeTruthy();
    expect(within(section).getByText("8%")).toBeTruthy();
    expect(within(section).getByText("78 MB")).toBeTruthy();
    expect(within(section).getByText("39 MB")).toBeTruthy();
  });

  test("paints environment names and totals in the PR-button blue at process metric size", async () => {
    render(
      <>
        <Button aria-label="Create PR">PR</Button>
        <SystemUsageIndicator />
      </>,
    );
    openPanel();
    const section = await waitFor(() => screen.getByLabelText("title-bar-layout processes"));
    const heading = within(section).getByRole("heading", { name: "title-bar-layout" });
    const totals = within(section).getByRole("group", {
      name: "title-bar-layout total usage: 18% CPU, 117 MB RAM",
    });
    const processRow = within(section).getByText("node").closest("li");
    const createPr = screen.getByRole("button", { name: "Create PR" });
    expect(heading.className).toContain("text-primary");
    expect(totals.className).toContain("text-primary");
    expect(totals.className).toContain("text-xs");
    expect(processRow?.className).toContain("text-xs");
    expect(createPr.className).toContain("bg-primary");
    expect(buttonVariants({ variant: "default" })).toContain("bg-primary");
  });

  test("repeats host CPU, RAM, GPU and disk readings under the process panel title", async () => {
    render(<SystemUsageIndicator />);
    await waitFor(() => expect(screen.getByLabelText("Disk storage usage: 63%")).toBeTruthy());
    expect(screen.queryByRole("region", { name: "System usage" }) === null).toBe(true);

    openPanel();
    const dialog = screen.getByRole("dialog", { name: "Environment process usage" });
    const system = await waitFor(() => screen.getByRole("region", { name: "System usage" }));
    const metrics = Array.from(system.querySelectorAll("button"));
    expect(metrics.map((metric) => metric.textContent)).toEqual(["12%", "48%", "—", "63%"]);
    expect(screen.queryByText("System") === null).toBe(true);
    expect(dialog.querySelector("header")?.contains(system)).toBe(true);
    expect(dialog.textContent?.indexOf("Process usage") ?? -1).toBeLessThan(
      dialog.textContent?.indexOf("12%") ?? -1,
    );
    expect(
      screen.getByRole("button", { name: "Central processing unit (CPU) usage: 12%" }),
    ).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Random-access memory (RAM) usage: 48%" }),
    ).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Graphics processing unit (GPU) usage: —" }),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "Disk storage usage: 63%" })).toBeTruthy();
    await waitFor(() => expect(screen.getByLabelText("title-bar-layout processes")).toBeTruthy());
    expect(dialog.textContent?.indexOf("12%") ?? -1).toBeLessThan(
      dialog.textContent?.indexOf("title-bar-layout") ?? -1,
    );
  });

  test("closes from a second click, the backdrop, Escape, and the header button", async () => {
    const { container } = render(<SystemUsageIndicator />);
    await waitFor(() => expect(screen.getByLabelText("Disk storage usage: 63%")).toBeTruthy());
    const trigger = screen.getByRole("button", { name: "Open environment process usage" });

    openPanel();
    expect(isPopoverOpen()).toBe(true);
    fireEvent.click(screen.getAllByRole("button", { name: "Close environment process usage" })[0]!);
    expect(isPopoverOpen()).toBe(false);

    openPanel();
    const backdrop = container.querySelector("button.fixed.inset-0");
    expect(backdrop).toBeTruthy();
    fireEvent.click(backdrop!);
    expect(isPopoverOpen()).toBe(false);
    await waitFor(() => expect(document.activeElement).toBe(trigger));

    openPanel();
    const consumed = new KeyboardEvent("keydown", { key: "Escape", cancelable: true });
    consumed.preventDefault();
    act(() => {
      window.dispatchEvent(consumed);
    });
    expect(isPopoverOpen()).toBe(true);
    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", cancelable: true }));
    });
    expect(isPopoverOpen()).toBe(false);

    openPanel();
    const headerClose = screen
      .getAllByRole("button", { name: "Close environment process usage" })
      .find((button) => button.classList.contains("-mr-1"));
    fireEvent.click(headerClose!);
    expect(isPopoverOpen()).toBe(false);
  });

  test("does not load processes until opened and keeps polling while open", async () => {
    let processCalls = 0;
    nativeInvokeMock.mockImplementation(async (command: string) => {
      if (command === "get_system_usage") return usageSnapshot();
      if (command !== "get_environment_process_usage") return undefined;
      processCalls += 1;
      return processSnapshot({
        environments: [
          {
            environmentId: "env-local",
            environmentName: "title-bar-layout",
            projectId: "project-1",
            environmentType: "local",
            processes: [
              {
                pid: 11,
                name: processCalls === 1 ? "node" : "bun",
                command: "refresh",
                cpuPercent: 1,
                ramPercent: 1,
                rssKb: 10,
              },
            ],
          },
        ],
      });
    });

    const timers: Array<() => unknown> = [];
    const originalSetTimeout = window.setTimeout;
    window.setTimeout = ((handler: TimerHandler, timeout?: number, ...args: unknown[]) => {
      if (timeout === ENVIRONMENT_PROCESS_POLL_INTERVAL_MS && typeof handler === "function") {
        timers.push(() => handler());
        return 8_000 + timers.length;
      }
      return originalSetTimeout(handler, timeout, ...args);
    }) as typeof window.setTimeout;

    try {
      render(<SystemUsageIndicator />);
      await waitFor(() => expect(screen.getByLabelText("Disk storage usage: 63%")).toBeTruthy());
      expect(processCalls).toBe(0);

      openPanel();
      await waitFor(() => expect(screen.getByText("node")).toBeTruthy());
      expect(processCalls).toBe(1);

      await act(async () => {
        timers.shift()?.();
      });
      await waitFor(() => expect(screen.getByText("bun")).toBeTruthy());
      expect(processCalls).toBe(2);
    } finally {
      window.setTimeout = originalSetTimeout;
    }
  });

  test("formats process RAM as whole megabytes or one-decimal gigabytes", () => {
    expect(formatProcessRamKb(0)).toBe("0 MB");
    expect(formatProcessRamKb(512)).toBe("1 MB");
    expect(formatProcessRamKb(120_000)).toBe("117 MB");
    expect(formatProcessRamKb(1024 * 1024)).toBe("1 GB");
    expect(formatProcessRamKb(1.5 * 1024 * 1024)).toBe("1.5 GB");
    expect(formatProcessRamKb(2 * 1024 * 1024)).toBe("2 GB");
    expect(formatProcessRamKb(1.04 * 1024 * 1024)).toBe("1 GB");
  });

  test("redacts secret flags from process command tooltips", async () => {
    nativeInvokeMock.mockImplementation(async (command: string) => {
      if (command === "get_system_usage") return usageSnapshot();
      if (command === "get_environment_process_usage") {
        return processSnapshot({
          environments: [
            {
              environmentId: "env-local",
              environmentName: "title-bar-layout",
              projectId: "project-1",
              environmentType: "local",
              processes: [
                {
                  pid: 11,
                  name: "node",
                  command: "node server.js --token supersecret --cwd /private/home",
                  cpuPercent: 1,
                  ramPercent: 1,
                  rssKb: 10,
                },
              ],
            },
          ],
        });
      }
      return undefined;
    });

    render(<SystemUsageIndicator />);
    openPanel();
    await waitFor(() => expect(screen.getByText("node")).toBeTruthy());
    const row = screen.getByText("node").closest("li");
    expect(row?.getAttribute("title")).toBe("node server.js --token *** --cwd /private/home");
    expect(row?.getAttribute("title")).not.toContain("supersecret");
    expect(document.body.textContent).not.toContain("supersecret");
    expect(sanitizeProcessCommand("curl Authorization Bearer.secret")).toBe(
      "curl Authorization ***",
    );
  });

  test("shows Data unavailable when the last process snapshot is stale", async () => {
    nativeInvokeMock.mockImplementation(async (command: string) => {
      if (command === "get_system_usage") return usageSnapshot();
      if (command === "get_environment_process_usage") {
        return processSnapshot({
          sampledAt: new Date(Date.now() - SYSTEM_USAGE_STALE_AFTER_MS - 1_000).toISOString(),
        });
      }
      return undefined;
    });

    render(<SystemUsageIndicator />);
    openPanel();
    await waitFor(() =>
      expect(screen.getByRole("status").textContent).toContain("Data unavailable"),
    );
    expect(screen.getByText("node")).toBeTruthy();
    expect(screen.getAllByText("117 MB")).toHaveLength(2);
  });

  test("tears the meter poll down on unmount and pauses while the document is hidden", async () => {
    let calls = 0;
    nativeInvokeMock.mockImplementation(async (command: string) => {
      if (command !== "get_system_usage") return undefined;
      calls += 1;
      return usageSnapshot({ cpuPercent: 10, ramPercent: 20 });
    });

    const timers = new Map<number, () => unknown>();
    let nextId = 9_000;
    const originalSetTimeout = window.setTimeout;
    const originalClearTimeout = window.clearTimeout;
    const originalVisibility = Object.getOwnPropertyDescriptor(document, "visibilityState");
    window.setTimeout = ((handler: TimerHandler, timeout?: number, ...args: unknown[]) => {
      if (timeout === SYSTEM_USAGE_POLL_INTERVAL_MS && typeof handler === "function") {
        const id = (nextId += 1);
        timers.set(id, () => handler());
        return id;
      }
      return originalSetTimeout(handler, timeout, ...args);
    }) as typeof window.setTimeout;
    window.clearTimeout = ((id?: number) => {
      if (typeof id === "number" && timers.delete(id)) return;
      return originalClearTimeout(id);
    }) as typeof window.clearTimeout;

    try {
      const { unmount } = render(<SystemUsageIndicator />);
      await waitFor(() => expect(calls).toBe(1));
      expect(timers.size).toBe(1);

      Object.defineProperty(document, "visibilityState", {
        configurable: true,
        get: () => "hidden",
      });
      act(() => {
        document.dispatchEvent(new Event("visibilitychange"));
      });
      expect(timers.size).toBe(0);

      Object.defineProperty(document, "visibilityState", {
        configurable: true,
        get: () => "visible",
      });
      await act(async () => {
        document.dispatchEvent(new Event("visibilitychange"));
      });
      await waitFor(() => expect(calls).toBe(2));

      unmount();
      expect(timers.size).toBe(0);
      expect(calls).toBe(2);
    } finally {
      window.setTimeout = originalSetTimeout;
      window.clearTimeout = originalClearTimeout;
      if (originalVisibility)
        Object.defineProperty(document, "visibilityState", originalVisibility);
      else delete (document as { visibilityState?: unknown }).visibilityState;
    }
  });

  test("shows an empty running-environment message when nothing is sampled", async () => {
    nativeInvokeMock.mockImplementation(async (command: string) => {
      if (command === "get_system_usage") return usageSnapshot();
      if (command === "get_environment_process_usage") {
        return { environments: [], sampledAt: new Date().toISOString() };
      }
      return undefined;
    });

    render(<SystemUsageIndicator />);
    openPanel();
    await waitFor(() => expect(screen.getByText("No running environment processes")).toBeTruthy());
  });

  test("sorts environments by CPU when the panel opens and keeps that order while open", async () => {
    let processCalls = 0;
    nativeInvokeMock.mockImplementation(async (command: string) => {
      if (command === "get_system_usage") return usageSnapshot();
      if (command !== "get_environment_process_usage") return undefined;
      processCalls += 1;
      const firstOpen = processCalls === 1;
      return processSnapshot({
        environments: [
          processGroup("env-low", "quiet-box", firstOpen ? 4 : 91),
          processGroup("env-high", "busy-box", firstOpen ? 62 : 3),
          processGroup("env-mid", "warm-box", firstOpen ? 18 : 40),
        ],
      });
    });

    const timers: Array<() => unknown> = [];
    const originalSetTimeout = window.setTimeout;
    window.setTimeout = ((handler: TimerHandler, timeout?: number, ...args: unknown[]) => {
      if (timeout === ENVIRONMENT_PROCESS_POLL_INTERVAL_MS && typeof handler === "function") {
        timers.push(() => handler());
        return 8_000 + timers.length;
      }
      return originalSetTimeout(handler, timeout, ...args);
    }) as typeof window.setTimeout;

    try {
      render(<SystemUsageIndicator />);
      await waitFor(() => expect(screen.getByLabelText("Disk storage usage: 63%")).toBeTruthy());

      openPanel();
      await waitFor(() => expect(screen.getByLabelText("busy-box processes")).toBeTruthy());
      expect(listedEnvironmentNames()).toEqual(["busy-box", "warm-box", "quiet-box"]);
      expect(screen.getAllByText("62%").length).toBeGreaterThan(0);

      await act(async () => {
        timers.shift()?.();
      });
      await waitFor(() => expect(screen.getAllByText("91%").length).toBeGreaterThan(0));
      expect(listedEnvironmentNames()).toEqual(["busy-box", "warm-box", "quiet-box"]);
      expect(screen.getAllByText("3%").length).toBeGreaterThan(0);
      expect(screen.getAllByText("40%").length).toBeGreaterThan(0);
    } finally {
      window.setTimeout = originalSetTimeout;
    }
  });

  test("re-sorts environments by CPU the next time the panel opens", async () => {
    let processCalls = 0;
    nativeInvokeMock.mockImplementation(async (command: string) => {
      if (command === "get_system_usage") return usageSnapshot();
      if (command !== "get_environment_process_usage") return undefined;
      processCalls += 1;
      return processSnapshot({
        environments: [
          processGroup("env-alpha", "alpha-box", processCalls === 1 ? 80 : 5),
          processGroup("env-beta", "beta-box", processCalls === 1 ? 10 : 70),
        ],
      });
    });

    render(<SystemUsageIndicator />);
    await waitFor(() => expect(screen.getByLabelText("Disk storage usage: 63%")).toBeTruthy());

    openPanel();
    await waitFor(() => expect(screen.getByLabelText("alpha-box processes")).toBeTruthy());
    expect(listedEnvironmentNames()).toEqual(["alpha-box", "beta-box"]);

    fireEvent.click(screen.getAllByRole("button", { name: "Close environment process usage" })[0]!);
    expect(isPopoverOpen()).toBe(false);

    openPanel();
    await waitFor(() => expect(screen.getAllByText("70%").length).toBeGreaterThan(0));
    expect(listedEnvironmentNames()).toEqual(["beta-box", "alpha-box"]);
  });

  test("appends environments that appear after the panel is already open", async () => {
    let processCalls = 0;
    nativeInvokeMock.mockImplementation(async (command: string) => {
      if (command === "get_system_usage") return usageSnapshot();
      if (command !== "get_environment_process_usage") return undefined;
      processCalls += 1;
      const environments = [
        processGroup("env-high", "busy-box", 20),
        processGroup("env-low", "quiet-box", 2),
      ];
      if (processCalls > 1) {
        environments.push(processGroup("env-new-hot", "new-hot-box", 95));
        environments.push(processGroup("env-new-cool", "new-cool-box", 8));
      }
      return processSnapshot({ environments });
    });

    const timers: Array<() => unknown> = [];
    const originalSetTimeout = window.setTimeout;
    window.setTimeout = ((handler: TimerHandler, timeout?: number, ...args: unknown[]) => {
      if (timeout === ENVIRONMENT_PROCESS_POLL_INTERVAL_MS && typeof handler === "function") {
        timers.push(() => handler());
        return 8_000 + timers.length;
      }
      return originalSetTimeout(handler, timeout, ...args);
    }) as typeof window.setTimeout;

    try {
      render(<SystemUsageIndicator />);
      openPanel();
      await waitFor(() => expect(listedEnvironmentNames()).toEqual(["busy-box", "quiet-box"]));

      await act(async () => {
        timers.shift()?.();
      });
      await waitFor(() => expect(screen.getByLabelText("new-hot-box processes")).toBeTruthy());
      expect(listedEnvironmentNames()).toEqual([
        "busy-box",
        "quiet-box",
        "new-hot-box",
        "new-cool-box",
      ]);
    } finally {
      window.setTimeout = originalSetTimeout;
    }
  });

  test("keeps the first ranking when a later poll returns a single environment", async () => {
    let processCalls = 0;
    nativeInvokeMock.mockImplementation(async (command: string) => {
      if (command === "get_system_usage") return usageSnapshot();
      if (command !== "get_environment_process_usage") return undefined;
      processCalls += 1;
      const environments =
        processCalls === 2
          ? [processGroup("env-mid", "warm-box", 18)]
          : [
              processGroup("env-low", "quiet-box", processCalls === 1 ? 4 : 91),
              processGroup("env-high", "busy-box", processCalls === 1 ? 62 : 3),
              processGroup("env-mid", "warm-box", processCalls === 1 ? 18 : 40),
            ];
      return processSnapshot({ environments });
    });

    const timers: Array<() => unknown> = [];
    const originalSetTimeout = window.setTimeout;
    window.setTimeout = ((handler: TimerHandler, timeout?: number, ...args: unknown[]) => {
      if (timeout === ENVIRONMENT_PROCESS_POLL_INTERVAL_MS && typeof handler === "function") {
        timers.push(() => handler());
        return 8_000 + timers.length;
      }
      return originalSetTimeout(handler, timeout, ...args);
    }) as typeof window.setTimeout;

    try {
      render(<SystemUsageIndicator />);
      openPanel();
      await waitFor(() =>
        expect(listedEnvironmentNames()).toEqual(["busy-box", "warm-box", "quiet-box"]),
      );

      await act(async () => {
        timers.shift()?.();
      });
      await waitFor(() => expect(listedEnvironmentNames()).toEqual(["warm-box"]));

      await act(async () => {
        timers.shift()?.();
      });
      await waitFor(() => expect(screen.getAllByText("91%").length).toBeGreaterThan(0));
      expect(listedEnvironmentNames()).toEqual(["busy-box", "warm-box", "quiet-box"]);
    } finally {
      window.setTimeout = originalSetTimeout;
    }
  });

  test("ranks and totals environments from full-set aggregates, not clipped rows", async () => {
    nativeInvokeMock.mockImplementation(async (command: string) => {
      if (command === "get_system_usage") return usageSnapshot();
      if (command === "get_environment_process_usage") {
        return processSnapshot({
          truncated: true,
          environments: [
            withProcessTotals({
              environmentId: "env-light",
              environmentName: "light-box",
              projectId: "project-1",
              environmentType: "local",
              processes: [
                {
                  pid: 21,
                  name: "bun",
                  command: "bun",
                  cpuPercent: 30,
                  ramPercent: 1,
                  rssKb: 30_000,
                },
                {
                  pid: 22,
                  name: "node",
                  command: "node",
                  cpuPercent: 30,
                  ramPercent: 1,
                  rssKb: 30_000,
                },
                {
                  pid: 23,
                  name: "zsh",
                  command: "zsh",
                  cpuPercent: 30,
                  ramPercent: 1,
                  rssKb: 30_000,
                },
              ],
            }),
            withProcessTotals({
              environmentId: "env-heavy",
              environmentName: "heavy-box",
              projectId: "project-1",
              environmentType: "local",
              processes: Array.from({ length: 40 }, (_, index) => ({
                pid: 100 + index,
                name: `worker-${index}`,
                command: `worker-${index}`,
                cpuPercent: 2,
                ramPercent: 1,
                rssKb: 1_024,
              })),
              totalCpuPercent: 100,
              totalRssKb: 51_200,
              processCount: 50,
              truncated: true,
            }),
          ],
        });
      }
      return undefined;
    });

    render(
      <StrictMode>
        <SystemUsageIndicator />
      </StrictMode>,
    );
    openPanel();
    await waitFor(() => expect(screen.getByLabelText("heavy-box processes")).toBeTruthy());
    expect(listedEnvironmentNames()).toEqual(["heavy-box", "light-box"]);
    expect(screen.getByText("List truncated")).toBeTruthy();
    const heavy = screen.getByLabelText("heavy-box processes");
    expect(
      within(heavy).getByRole("group", { name: "heavy-box total usage: 100% CPU, 50 MB RAM" }),
    ).toBeTruthy();
    expect(within(heavy).getByText("Process (50)")).toBeTruthy();
    expect(within(heavy).getAllByRole("listitem")).toHaveLength(40);
    const light = screen.getByLabelText("light-box processes");
    expect(
      within(light).getByRole("group", { name: "light-box total usage: 90% CPU, 88 MB RAM" }),
    ).toBeTruthy();
    expect(within(light).getAllByRole("listitem")).toHaveLength(3);
  });

  test("shows a header Data unavailable row when host usage is stale without a System heading", async () => {
    const staleAt = new Date(Date.now() - SYSTEM_USAGE_STALE_AFTER_MS - 1_000).toISOString();
    nativeInvokeMock.mockImplementation(async (command: string) => {
      if (command === "get_system_usage") return usageSnapshot({ sampledAt: staleAt });
      if (command === "get_environment_process_usage") {
        return processSnapshot({ sampledAt: staleAt });
      }
      return undefined;
    });

    render(<SystemUsageIndicator />);
    await waitFor(() => expect(screen.getByLabelText("Disk storage usage: —")).toBeTruthy());
    openPanel();
    const dialog = await waitFor(() =>
      screen.getByRole("dialog", { name: "Environment process usage" }),
    );
    await waitFor(() => expect(screen.getByLabelText("title-bar-layout processes")).toBeTruthy());
    expect(screen.queryByText("System") === null).toBe(true);
    const statuses = screen.getAllByRole("status");
    expect(statuses.map((status) => status.textContent)).toEqual([
      "Data unavailable",
      "Data unavailable",
    ]);
    expect(dialog.querySelector("header")?.contains(statuses[0]!)).toBe(true);
    expect(dialog.querySelector("header")?.contains(statuses[1]!)).toBe(false);
  });
});

describe("environment process group order", () => {
  test("ranks groups by summed CPU and uses name then id for ties", () => {
    const busy = withProcessTotals({
      environmentId: "env-b",
      environmentName: "busy-box",
      projectId: "project-1",
      environmentType: "local",
      processes: [
        {
          pid: 11,
          name: "node",
          command: "node",
          cpuPercent: 12,
          ramPercent: 1,
          rssKb: 10,
        },
        {
          pid: 12,
          name: "bun",
          command: "bun",
          cpuPercent: 8,
          ramPercent: 1,
          rssKb: 10,
        },
      ],
    });
    const tiedLater = processGroup("env-z", "same-name", 5);
    const tiedEarlier = processGroup("env-a", "same-name", 5);
    const quiet = processGroup("env-q", "quiet-box", 0);

    expect(environmentProcessGroupCpu(busy)).toBe(20);
    expect(environmentProcessGroupRamKb(busy)).toBe(20);
    expect(environmentProcessGroupRamKb(quiet)).toBe(0);
    expect(environmentProcessGroupCount(quiet)).toBe(0);
    expect(
      sortEnvironmentProcessGroupsByCpu([quiet, tiedLater, busy, tiedEarlier]).map(
        (group) => group.environmentId,
      ),
    ).toEqual(["env-b", "env-a", "env-z", "env-q"]);
  });

  test("uses backend aggregates when displayed rows would rank a lighter environment first", () => {
    const heavy = withProcessTotals({
      environmentId: "env-heavy",
      environmentName: "heavy-box",
      projectId: "project-1",
      environmentType: "local",
      processes: Array.from({ length: 40 }, (_, index) => ({
        pid: index + 1,
        name: "worker",
        command: "worker",
        cpuPercent: 2,
        ramPercent: 1,
        rssKb: 1_024,
      })),
      totalCpuPercent: 100,
      totalRssKb: 51_200,
      processCount: 50,
      truncated: true,
    });
    const light = withProcessTotals({
      environmentId: "env-light",
      environmentName: "light-box",
      projectId: "project-1",
      environmentType: "local",
      processes: [
        {
          pid: 1,
          name: "bun",
          command: "bun",
          cpuPercent: 90,
          ramPercent: 1,
          rssKb: 10,
        },
      ],
    });
    expect(environmentProcessGroupCpu(heavy)).toBe(100);
    expect(environmentProcessGroupCount(heavy)).toBe(50);
    expect(heavy.processes.reduce((total, process) => total + process.cpuPercent, 0)).toBe(80);
    expect(
      sortEnvironmentProcessGroupsByCpu([light, heavy]).map((group) => group.environmentId),
    ).toEqual(["env-heavy", "env-light"]);
  });

  test("freezes the first ranking and appends later arrivals by current CPU", () => {
    const first = [
      processGroup("env-low", "quiet-box", 1),
      processGroup("env-high", "busy-box", 40),
    ];
    const opened = orderEnvironmentProcessGroups(first, null);
    expect(opened.map((group) => group.environmentId)).toEqual(["env-high", "env-low"]);

    const refreshed = orderEnvironmentProcessGroups(
      [
        processGroup("env-low", "quiet-box", 90),
        processGroup("env-high", "busy-box", 2),
        processGroup("env-new", "new-box", 50),
      ],
      opened.map((group) => group.environmentId),
    );
    expect(refreshed.map((group) => group.environmentId)).toEqual([
      "env-high",
      "env-low",
      "env-new",
    ]);
    expect(environmentProcessGroupCpu(refreshed[1]!)).toBe(90);
  });

  test("keeps a frozen order after a one-environment poll", () => {
    const first = [
      processGroup("env-low", "quiet-box", 4),
      processGroup("env-high", "busy-box", 62),
      processGroup("env-mid", "warm-box", 18),
    ];
    const opened = orderEnvironmentProcessGroups(first, null);
    expect(opened.map((group) => group.environmentId)).toEqual(["env-high", "env-mid", "env-low"]);

    const onlyMid = orderEnvironmentProcessGroups(
      [processGroup("env-mid", "warm-box", 18)],
      opened.map((group) => group.environmentId),
    );
    expect(onlyMid.map((group) => group.environmentId)).toEqual(["env-mid"]);

    const restored = orderEnvironmentProcessGroups(
      first,
      mergeFrozenEnvironmentIds(
        opened.map((group) => group.environmentId),
        onlyMid,
      ),
    );
    expect(restored.map((group) => group.environmentId)).toEqual([
      "env-high",
      "env-mid",
      "env-low",
    ]);
  });
});
