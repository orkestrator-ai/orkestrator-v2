import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { invoke as nativeInvoke } from "@/lib/native/backend";
import { useProjectStore } from "@/stores";
import {
  ENVIRONMENT_PROCESS_POLL_INTERVAL_MS,
  SYSTEM_USAGE_POLL_INTERVAL_MS,
  SystemUsageIndicator,
  formatProcessRamKb,
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

function processSnapshot(overrides: Record<string, unknown> = {}) {
  return {
    sampledAt: new Date().toISOString(),
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
            command: "/usr/local/bin/node server.js",
            cpuPercent: 18.2,
            ramPercent: 4.4,
            rssKb: 120_000,
          },
        ],
      },
      {
        environmentId: "env-box",
        environmentName: "review-box",
        projectId: "project-2",
        environmentType: "containerized",
        processes: [],
      },
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
    expect(nativeInvokeMock.mock.calls.some((call) => call[0] === "get_environment_process_usage")).toBe(
      false,
    );

    openPanel();
    expect(isPopoverOpen()).toBe(true);
    expect(
      screen
        .getAllByRole("button", { name: "Close environment process usage" })[0]!
        .getAttribute("aria-expanded"),
    ).toBe("true");

    await waitFor(() => expect(screen.getByLabelText("title-bar-layout processes")).toBeTruthy());
    expect(screen.getByText("Process")).toBeTruthy();
    expect(screen.getByText("CPU")).toBeTruthy();
    expect(screen.getByText("RAM")).toBeTruthy();
    expect(screen.getByText("orkestrator-v2 · local")).toBeTruthy();
    expect(screen.getByText("node")).toBeTruthy();
    expect(screen.getByText("18%")).toBeTruthy();
    expect(screen.getByText("117 MB")).toBeTruthy();
    expect(screen.getByLabelText("review-box processes")).toBeTruthy();
    expect(screen.getByText("No processes")).toBeTruthy();
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
});
