import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act, cleanup, render, screen } from "@testing-library/react";
import { resetReadCoordinatorForTests } from "@/lib/read-coordinator";
import { installFakeReadCoordinator } from "@/lib/testing/read-coordinator";
import {
  resetTransportConnectivityForTests,
  setTransportDisconnected,
} from "@/lib/transport-connectivity";
import { ConnectionStatusBanner } from "./ConnectionStatusBanner";

const wait = (ms: number) => act(() => new Promise<void>((resolve) => setTimeout(resolve, ms)));

beforeEach(() => {
  installFakeReadCoordinator();
  resetTransportConnectivityForTests();
});

afterEach(() => {
  cleanup();
  resetTransportConnectivityForTests();
  resetReadCoordinatorForTests();
});

describe("ConnectionStatusBanner", () => {
  test("stays hidden while connected", () => {
    render(<ConnectionStatusBanner delayMs={0} />);
    expect(screen.queryByTestId("connection-status-banner") === null).toBe(true);
  });

  test("a blip that recovers within the delay never shows", async () => {
    render(<ConnectionStatusBanner delayMs={40} />);
    act(() => setTransportDisconnected("gateway-event-stream", true));
    await wait(10);
    act(() => setTransportDisconnected("gateway-event-stream", false));
    await wait(60);
    expect(screen.queryByTestId("connection-status-banner") === null).toBe(true);
  });

  test("shows after the delay and clears as soon as the transport reconnects", async () => {
    render(<ConnectionStatusBanner delayMs={20} />);
    act(() => setTransportDisconnected("gateway-event-stream", true));
    expect(screen.queryByTestId("connection-status-banner") === null).toBe(true);
    await wait(40);
    expect(screen.getByTestId("connection-status-banner").textContent).toContain(
      "last data received",
    );

    act(() => setTransportDisconnected("gateway-event-stream", false));
    expect(screen.queryByTestId("connection-status-banner") === null).toBe(true);

    // A new outage waits out its own delay.
    act(() => setTransportDisconnected("desktop-connection", true));
    expect(screen.queryByTestId("connection-status-banner") === null).toBe(true);
    await wait(40);
    expect(screen.getByTestId("connection-status-banner")).toBeTruthy();
  });
});
