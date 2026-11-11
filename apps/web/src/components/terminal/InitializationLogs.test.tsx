import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { captureLogs } from "@orkestrator/protocol/testing/log-capture";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import * as realBackend from "@/lib/backend";
import { resetReadCoordinatorForTests } from "@/lib/read-coordinator";
import {
  flushMicrotasks,
  installFakeReadCoordinator,
  type FakeReadEnvironment,
} from "@/lib/testing/read-coordinator";

const realBackendSnapshot = { ...realBackend };
const getContainerLogsMock = mock(async (_containerId: string, _tail: string) => "");

mock.module("@/lib/backend", () => ({
  ...realBackendSnapshot,
  getContainerLogs: getContainerLogsMock,
}));

const { InitializationLogs } = await import("./InitializationLogs");

const originalScrollIntoView = HTMLElement.prototype.scrollIntoView;
const originalScrollTo = HTMLElement.prototype.scrollTo;

afterAll(() => {
  HTMLElement.prototype.scrollIntoView = originalScrollIntoView;
  HTMLElement.prototype.scrollTo = originalScrollTo;
  mock.module("@/lib/backend", () => realBackendSnapshot);
});

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
  let reads: FakeReadEnvironment;
  let scrollIntoView: ReturnType<typeof mock>;
  /** The log box's own scroll; `this` is the element scrolled. */
  let scrollTo: ReturnType<typeof mock>;
  let scrolled: Element[];

  async function advance(ms: number) {
    await act(async () => {
      await flushMicrotasks();
      await reads.clock.advance(ms);
    });
  }

  beforeEach(() => {
    reads = installFakeReadCoordinator();
    scrollIntoView = mock(() => {});
    HTMLElement.prototype.scrollIntoView = scrollIntoView as never;
    scrolled = [];
    scrollTo = mock(function (this: Element) {
      scrolled.push(this);
    });
    HTMLElement.prototype.scrollTo = scrollTo as never;
    getContainerLogsMock.mockReset();
    getContainerLogsMock.mockResolvedValue("");
  });

  afterEach(() => {
    cleanup();
    resetReadCoordinatorForTests();
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
    const logs = captureLogs();
    getContainerLogsMock
      .mockRejectedValueOnce(new Error("daemon unavailable"))
      .mockResolvedValueOnce("container ready");
    try {
      render(<InitializationLogs containerId="container-1" />);
      await waitFor(() => expect(screen.getByText(/Failed to load container logs/)).toBeTruthy());
      await advance(1_000);
      await waitFor(() => expect(screen.getByText("container ready")).toBeTruthy());
      expect(screen.queryByText(/Failed to load container logs/) === null).toBe(true);
    } finally {
      logs.restore();
    }
  });

  test("preserves the last snapshot across a transient polling failure", async () => {
    const transientFailure = deferred<string>();
    getContainerLogsMock
      .mockResolvedValueOnce("still useful")
      .mockImplementationOnce(() => transientFailure.promise)
      .mockResolvedValue("recovered");
    render(<InitializationLogs containerId="container-1" />);
    await waitFor(() => expect(screen.getByText("still useful")).toBeTruthy());

    await advance(1_000);
    expect(getContainerLogsMock).toHaveBeenCalledTimes(2);
    expect(screen.getByText("still useful")).toBeTruthy();
    transientFailure.reject(new Error("temporary"));
    await advance(1_000);
    await waitFor(() => expect(screen.getByText("recovered")).toBeTruthy());
  });

  test("a remount shows the kept tail while refreshes are failing", async () => {
    getContainerLogsMock.mockResolvedValueOnce("kept tail").mockRejectedValue(new Error("offline"));
    const first = render(<InitializationLogs containerId="container-1" />);
    await waitFor(() => expect(screen.getByText("kept tail")).toBeTruthy());
    await advance(1_000);
    first.unmount();
    render(<InitializationLogs containerId="container-1" />);
    await waitFor(() => expect(screen.getByText("kept tail")).toBeTruthy());
    expect(screen.queryByText("Loading container logs...") === null).toBe(true);
  });

  test("polls once a second by default and not while the document is hidden", async () => {
    getContainerLogsMock.mockResolvedValue("tail");
    render(<InitializationLogs containerId="container-1" />);
    await advance(0);
    const entry = reads.coordinator
      .getDiagnostics()
      .entries.find((candidate) => candidate.id.includes("container-init-logs"));
    expect(entry?.cadenceMs).toBe(1_000);
    await advance(3_000);
    expect(getContainerLogsMock).toHaveBeenCalledTimes(4);

    act(() => reads.document.setVisibility("hidden"));
    await advance(60_000);
    expect(getContainerLogsMock).toHaveBeenCalledTimes(4);
    act(() => reads.document.setVisibility("visible"));
    await advance(500);
    expect(getContainerLogsMock).toHaveBeenCalledTimes(5);
  });

  test("identical tails write no state: no re-render, no re-scroll", async () => {
    getContainerLogsMock.mockResolvedValue("same line");
    render(<InitializationLogs containerId="container-1" />);
    /*
     * Land the first read inside act() so its commit and the auto-scroll
     * effect both flush before the baseline is taken. Resolved outside act()
     * (via waitFor), the passive scroll effect runs on React's setImmediate
     * task, racing waitFor's setTimeout(0) drain; a stall of a millisecond or
     * more lets waitFor return first and the initial scroll then lands inside
     * the identical-tail polls below (flake 0176).
     */
    await advance(0);
    const shown = screen.getByText("same line");
    expect(scrollTo).toHaveBeenCalledTimes(1);
    await advance(5_000);
    expect(getContainerLogsMock).toHaveBeenCalledTimes(6);
    expect(screen.getByText("same line")).toBe(shown);
    expect(scrollTo).toHaveBeenCalledTimes(1);

    getContainerLogsMock.mockResolvedValue("same line\nnew line");
    await advance(1_000);
    expect(screen.getByText("new line")).toBeTruthy();
    expect(scrollTo).toHaveBeenCalledTimes(2);
  });

  test("follows the tail by scrolling only its own log box, never its ancestors", async () => {
    getContainerLogsMock.mockResolvedValue("first\nsecond");
    render(<InitializationLogs containerId="container-1" />);
    await advance(0);
    expect(screen.getByText("second")).toBeTruthy();

    expect(scrollTo).toHaveBeenCalledTimes(1);
    const box = scrolled[0]!;
    expect(box.contains(screen.getByText("second"))).toBe(true);
    expect(box.className).toContain("overflow-auto");
    expect(scrollTo.mock.calls[0]?.[0]).toEqual({ top: box.scrollHeight, behavior: "smooth" });
    // `scrollIntoView` scrolls every scrollable ancestor too, the window's
    // `overflow: hidden` layout roots included.
    expect(scrollIntoView).not.toHaveBeenCalled();
  });

  test("two views of the same container share one read", async () => {
    getContainerLogsMock.mockResolvedValue("shared");
    render(
      <>
        <InitializationLogs containerId="container-1" />
        <InitializationLogs containerId="container-1" />
      </>,
    );
    await waitFor(() => expect(screen.getAllByText("shared")).toHaveLength(2));
    await advance(3_000);
    expect(getContainerLogsMock).toHaveBeenCalledTimes(4);
  });

  test("flags the tail as stale after repeated polling failures", async () => {
    /*
     * A dropped poll used to be swallowed forever: the last snapshot stayed on
     * screen under the "Initializing Container" spinner with nothing to say it
     * had stopped tracking the container.
     */
    const logs = captureLogs();
    const warnings = () => logs.records().filter((record) => record.level === "warn");
    getContainerLogsMock
      .mockResolvedValueOnce("still useful")
      .mockRejectedValue(new Error("daemon unavailable"));
    try {
      render(<InitializationLogs containerId="container-1" />);
      await waitFor(() => expect(screen.getByText("still useful")).toBeTruthy());

      // Failures retry with capped backoff; three of them mark the tail stale.
      await advance(30_000);
      const stale = await screen.findByRole("status");
      expect(stale.textContent).toContain("stopped refreshing");
      // The last good tail is still the best view of the container.
      expect(screen.getByText("still useful")).toBeTruthy();
      expect(screen.queryByText(/Failed to load container logs/) === null).toBe(true);
      expect(logs.records()).toContainEqual(
        expect.objectContaining({
          level: "warn",
          area: "terminal",
          event: "init-logs.refresh-stopped",
          fields: expect.objectContaining({
            error: expect.objectContaining({ message: "daemon unavailable" }),
          }),
        }),
      );

      // A single warning, not one per failed poll.
      const warnCalls = warnings().length;
      await advance(60_000);
      expect(warnings().length).toBe(warnCalls);

      getContainerLogsMock.mockResolvedValue("recovered");
      await advance(30_000);
      await waitFor(() => expect(screen.getByText("recovered")).toBeTruthy());
      expect(screen.queryByRole("status") === null).toBe(true);
    } finally {
      logs.restore();
    }
  });

  test("tolerates isolated polling failures without flagging staleness", async () => {
    const logs = captureLogs();
    getContainerLogsMock
      .mockResolvedValueOnce("first")
      .mockRejectedValueOnce(new Error("blip"))
      .mockResolvedValue("second");
    try {
      render(<InitializationLogs containerId="container-1" />);
      await waitFor(() => expect(screen.getByText("first")).toBeTruthy());
      await advance(1_000);
      await advance(1_000);
      await waitFor(() => expect(screen.getByText("second")).toBeTruthy());
      expect(screen.queryByRole("status") === null).toBe(true);
      expect(logs.records().filter((record) => record.level === "warn")).toEqual([]);
    } finally {
      logs.restore();
    }
  });

  test("suppresses overlapping polls and stops reading after unmount", async () => {
    const pending = deferred<string>();
    getContainerLogsMock.mockImplementationOnce(() => pending.promise);
    const view = render(<InitializationLogs containerId="container-1" />);

    await advance(5_000);
    expect(getContainerLogsMock).toHaveBeenCalledTimes(1);
    view.unmount();
    pending.resolve("done");
    await advance(10_000);
    expect(getContainerLogsMock).toHaveBeenCalledTimes(1);
  });
});
