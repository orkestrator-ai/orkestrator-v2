import { afterAll, afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import * as realBackend from "@/lib/backend";

const realBackendSnapshot = { ...realBackend };
const getContainerLogsMock = mock(async (_containerId: string, _tail: string) => "");

mock.module("@/lib/backend", () => ({
  ...realBackendSnapshot,
  getContainerLogs: getContainerLogsMock,
}));

const { InitializationLogs } = await import("./InitializationLogs");

const originalScrollIntoView = HTMLElement.prototype.scrollIntoView;

afterAll(() => {
  HTMLElement.prototype.scrollIntoView = originalScrollIntoView;
  mock.module("@/lib/backend", () => realBackendSnapshot);
});

afterEach(() => cleanup());

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}

describe("InitializationLogs", () => {
  beforeEach(() => {
    HTMLElement.prototype.scrollIntoView = mock(() => {});
    getContainerLogsMock.mockReset();
    getContainerLogsMock.mockResolvedValue("");
  });

  test("loads the authoritative tail, filters blank lines, and keeps only 500 entries", async () => {
    const lines = Array.from({ length: 510 }, (_, index) => `line-${index}`);
    getContainerLogsMock.mockResolvedValue(`${lines.join("\n")}\n\n`);

    render(<InitializationLogs containerId="container-1" />);

    await waitFor(() => expect(screen.getByText("line-509")).toBeTruthy());
    expect(screen.queryByText("line-0") === null).toBe(true);
    expect(screen.getByText("line-10")).toBeTruthy();
    expect(getContainerLogsMock).toHaveBeenCalledWith("container-1", "500");
  });

  test("shows an initial failure and recovers on a later poll", async () => {
    const consoleError = spyOn(console, "error").mockImplementation(() => undefined);
    const originalSetInterval = globalThis.setInterval;
    let runPoll: (() => void) | undefined;
    globalThis.setInterval = ((
      handler: TimerHandler,
      timeout?: number,
      ...args: unknown[]
    ) => {
      if (timeout === 5 && typeof handler === "function") {
        runPoll = () => handler(...args);
        return 1 as unknown as ReturnType<typeof setInterval>;
      }
      return originalSetInterval(handler, timeout, ...args);
    }) as typeof globalThis.setInterval;
    getContainerLogsMock
      .mockRejectedValueOnce(new Error("daemon unavailable"))
      .mockResolvedValueOnce("container ready");

    try {
      render(<InitializationLogs containerId="container-1" pollIntervalMs={5} />);

      await waitFor(() => expect(screen.getByText(/Failed to load container logs/)).toBeTruthy());
      expect(runPoll).toBeDefined();
      await act(async () => runPoll?.());

      await waitFor(() => expect(screen.getByText("container ready")).toBeTruthy());
      expect(screen.queryByText(/Failed to load container logs/) === null).toBe(true);
    } finally {
      cleanup();
      globalThis.setInterval = originalSetInterval;
      consoleError.mockRestore();
    }
  });

  test("preserves the last snapshot across a transient polling failure", async () => {
    const transientFailure = deferred<string>();
    getContainerLogsMock
      .mockResolvedValueOnce("still useful")
      .mockImplementationOnce(() => transientFailure.promise)
      .mockResolvedValue("recovered");
    render(<InitializationLogs containerId="container-1" pollIntervalMs={5} />);
    await waitFor(() => expect(screen.getByText("still useful")).toBeTruthy());

    await waitFor(() => expect(getContainerLogsMock.mock.calls.length).toBeGreaterThanOrEqual(2));
    expect(screen.getByText("still useful")).toBeTruthy();
    transientFailure.reject(new Error("temporary"));

    await waitFor(() => expect(screen.getByText("recovered")).toBeTruthy());
  });

  test("polls once a second by default", async () => {
    // The interval is only overridable for tests, so nothing else pins the
    // production cadence.
    const originalSetInterval = globalThis.setInterval;
    const intervals: Array<number | undefined> = [];
    globalThis.setInterval = ((
      handler: TimerHandler,
      timeout?: number,
      ...args: unknown[]
    ) => {
      intervals.push(timeout);
      return originalSetInterval(handler, timeout, ...args);
    }) as typeof globalThis.setInterval;

    try {
      render(<InitializationLogs containerId="container-1" />);
      await waitFor(() => expect(intervals.length).toBeGreaterThan(0));
      expect(intervals).toContain(1_000);
    } finally {
      globalThis.setInterval = originalSetInterval;
    }
  });

  test("flags the tail as stale after repeated polling failures", async () => {
    /*
     * A dropped poll used to be swallowed forever: the last snapshot stayed on
     * screen under the "Initializing Container" spinner with nothing to say it
     * had stopped tracking the container.
     */
    const consoleWarn = spyOn(console, "warn").mockImplementation(() => undefined);
    getContainerLogsMock
      .mockResolvedValueOnce("still useful")
      .mockRejectedValue(new Error("daemon unavailable"));
    render(<InitializationLogs containerId="container-1" pollIntervalMs={5} />);
    await waitFor(() => expect(screen.getByText("still useful")).toBeTruthy());

    const stale = await screen.findByRole("status");
    expect(stale.textContent).toContain("stopped refreshing");
    // The last good tail is still the best view of the container.
    expect(screen.getByText("still useful")).toBeTruthy();
    expect(screen.queryByText(/Failed to load container logs/) === null).toBe(true);
    expect(consoleWarn).toHaveBeenCalledWith(
      "[InitializationLogs] Container logs stopped refreshing:",
      "daemon unavailable",
    );

    // A single warning, not one per failed poll.
    const warnCalls = consoleWarn.mock.calls.length;
    await act(async () => new Promise((resolve) => setTimeout(resolve, 40)));
    expect(consoleWarn.mock.calls.length).toBe(warnCalls);

    getContainerLogsMock.mockResolvedValue("recovered");
    await waitFor(() => expect(screen.getByText("recovered")).toBeTruthy());
    expect(screen.queryByRole("status") === null).toBe(true);
    consoleWarn.mockRestore();
  });

  test("tolerates isolated polling failures without flagging staleness", async () => {
    const consoleWarn = spyOn(console, "warn").mockImplementation(() => undefined);
    getContainerLogsMock
      .mockResolvedValueOnce("first")
      .mockRejectedValueOnce(new Error("blip"))
      .mockResolvedValue("second");
    render(<InitializationLogs containerId="container-1" pollIntervalMs={5} />);

    await waitFor(() => expect(screen.getByText("second")).toBeTruthy());
    expect(screen.queryByRole("status") === null).toBe(true);
    expect(consoleWarn).not.toHaveBeenCalled();
    consoleWarn.mockRestore();
  });

  test("suppresses overlapping polls and disposes the interval", async () => {
    const pending = deferred<string>();
    getContainerLogsMock.mockImplementationOnce(() => pending.promise);
    const view = render(<InitializationLogs containerId="container-1" pollIntervalMs={5} />);

    await act(async () => new Promise((resolve) => setTimeout(resolve, 20)));
    expect(getContainerLogsMock).toHaveBeenCalledTimes(1);
    view.unmount();
    pending.resolve("done");
    await act(async () => new Promise((resolve) => setTimeout(resolve, 20)));
    expect(getContainerLogsMock).toHaveBeenCalledTimes(1);
  });
});
