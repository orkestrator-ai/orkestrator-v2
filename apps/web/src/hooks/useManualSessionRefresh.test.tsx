import { afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, render, waitFor } from "@testing-library/react";
import { mockToastError } from "../../../../tests/mocks/sonner";
import {
  useManualSessionRefresh,
  type RefreshSessionOptions,
} from "./useManualSessionRefresh";

function Harness({
  refreshRequestId,
  isReady = true,
  refresh,
}: {
  refreshRequestId: number;
  isReady?: boolean;
  refresh: (options: RefreshSessionOptions) => Promise<void>;
}) {
  useManualSessionRefresh({
    refreshRequestId,
    isReady,
    agentLabel: "Test",
    refresh,
  });
  return null;
}

afterEach(() => {
  cleanup();
  mockToastError.mockClear();
});

describe("useManualSessionRefresh", () => {
  test("marks the refresh as manual so it is not treated as a background poll", async () => {
    /**
     * The flag is what keeps the user's refresh on its own sequence and pays for
     * the forced model-catalog reload. Without it a watchdog tick could silently
     * supersede the click.
     */
    const refresh = mock(async () => {});
    render(<Harness refreshRequestId={1} refresh={refresh} />);

    await waitFor(() => expect(refresh).toHaveBeenCalledWith({ manual: true }));
  });

  test("does not re-run for an unchanged watermark", async () => {
    const refresh = mock(async () => {});
    const { rerender } = render(<Harness refreshRequestId={1} refresh={refresh} />);
    await waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));

    rerender(<Harness refreshRequestId={1} refresh={refresh} />);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  test("runs again for each newer watermark", async () => {
    // A watermark rather than a boolean precisely so a second click while the
    // first refresh is still running is not swallowed.
    const refresh = mock(async () => {});
    const { rerender } = render(<Harness refreshRequestId={1} refresh={refresh} />);
    await waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));

    rerender(<Harness refreshRequestId={2} refresh={refresh} />);
    await waitFor(() => expect(refresh).toHaveBeenCalledTimes(2));
  });

  test("ignores a stale watermark that goes backwards", async () => {
    const refresh = mock(async () => {});
    const { rerender } = render(<Harness refreshRequestId={5} refresh={refresh} />);
    await waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));

    rerender(<Harness refreshRequestId={3} refresh={refresh} />);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  test("waits until the tab is ready, then honours the pending request", async () => {
    const refresh = mock(async () => {});
    const { rerender } = render(
      <Harness refreshRequestId={1} isReady={false} refresh={refresh} />,
    );
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(refresh).not.toHaveBeenCalled();

    rerender(<Harness refreshRequestId={1} isReady refresh={refresh} />);
    await waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
  });

  test("surfaces a failed refresh to the user", async () => {
    const refresh = mock(async () => {
      throw new Error("session changed while refreshing");
    });
    render(<Harness refreshRequestId={1} refresh={refresh} />);

    await waitFor(() =>
      expect(mockToastError).toHaveBeenCalledWith("Failed to refresh Test tab", {
        description: "session changed while refreshing",
      }),
    );
  });
});
