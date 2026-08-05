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
    expect(screen.queryByText("line-0")).toBeNull();
    expect(screen.getByText("line-10")).toBeTruthy();
    expect(getContainerLogsMock).toHaveBeenCalledWith("container-1", "500");
  });

  test("shows an initial failure and recovers on a later poll", async () => {
    const consoleError = spyOn(console, "error").mockImplementation(() => undefined);
    getContainerLogsMock
      .mockRejectedValueOnce(new Error("daemon unavailable"))
      .mockResolvedValueOnce("container ready");
    render(<InitializationLogs containerId="container-1" pollIntervalMs={5} />);

    await waitFor(() => expect(screen.getByText(/Failed to load container logs/)).toBeTruthy());

    await waitFor(() => expect(screen.getByText("container ready")).toBeTruthy());
    expect(screen.queryByText(/Failed to load container logs/)).toBeNull();
    consoleError.mockRestore();
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
