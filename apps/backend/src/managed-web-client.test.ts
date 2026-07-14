import { describe, expect, mock, test } from "bun:test";
import { ManagedWebClient } from "./managed-web-client.js";

describe("managed Electron web client", () => {
  test("publishes and removes the loopback browser listener through Tailscale Serve", async () => {
    const start = mock(async () => "https://workstation.example.ts.net/");
    const stop = mock(async () => undefined);
    const client = new ManagedWebClient({ start, stop });
    client.setBrowserListenerUrl("http://127.0.0.1:34121/");

    await expect(client.setEnabled(true)).resolves.toEqual({
      enabled: true,
      running: true,
      url: "https://workstation.example.ts.net/",
      error: null,
    });
    expect(start).toHaveBeenCalledWith(34121, 443);

    await expect(client.setEnabled(false)).resolves.toEqual({
      enabled: false,
      running: false,
      url: null,
      error: null,
    });
    expect(stop).toHaveBeenCalledTimes(1);
  });

  test("keeps the backend available and supports retry when Serve setup fails", async () => {
    const start = mock(async (): Promise<string> => {
      throw new Error("Tailscale is not connected");
    });
    const stop = mock(async () => undefined);
    const logger = { error: mock(() => undefined) };
    const client = new ManagedWebClient({ start, stop }, 8443, logger);
    client.setBrowserListenerUrl("http://127.0.0.1:41234/");

    await expect(client.setEnabled(true)).resolves.toMatchObject({
      enabled: true,
      running: false,
      error: "Tailscale is not connected",
    });
    expect(stop).toHaveBeenCalledTimes(1);

    start.mockImplementationOnce(async () => "https://workstation.example.ts.net:8443/");
    await expect(client.setEnabled(true)).resolves.toMatchObject({ running: true, error: null });
    expect(start).toHaveBeenLastCalledWith(41234, 8443);
  });

  test("reports an unavailable browser listener without invoking Serve", async () => {
    const start = mock(async () => "https://unused.example/");
    const client = new ManagedWebClient({ start, stop: mock(async () => undefined) });

    await expect(client.setEnabled(true)).resolves.toMatchObject({
      enabled: true,
      running: false,
      error: "The backend browser listener is unavailable.",
    });
    expect(start).not.toHaveBeenCalled();
  });
});
