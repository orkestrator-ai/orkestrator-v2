import { describe, expect, test } from "bun:test";

import {
  ChannelStartupError,
  startChannel,
  type StartupClient,
} from "../scripts/terminal-input-results-probe-startup.ts";

/** A client whose `ready` behaves as given and that records calls. */
function fakeClient(ready: () => Promise<void>) {
  const calls = { observed: 0, disposed: 0 };
  const client: StartupClient = {
    ready,
    observeSnapshot: () => {
      calls.observed += 1;
    },
    dispose: () => {
      calls.disposed += 1;
    },
  };
  return { client, calls };
}

const never = () => new Promise<void>(() => {});
const diagnostics = () => ({ socketCloses: 3, fallbackRequired: 1 });
const TIMEOUT_MS = 10;

describe("startChannel", () => {
  test("a permanently refused upgrade fails at the socket stage and disposes the client", async () => {
    // The real client retries a refused upgrade for ever: `ready` never settles.
    const { client, calls } = fakeClient(never);
    const failure = await startChannel(client, "s", never(), {
      timeoutMs: TIMEOUT_MS,
      diagnostics,
    }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ChannelStartupError);
    expect((failure as ChannelStartupError).stage).toBe("socket");
    expect((failure as ChannelStartupError).message).toBe(
      "Terminal channel startup failed at the socket stage: not ready within 10 ms " +
        "(socket closes 3, fallbacks 1)",
    );
    expect(calls).toEqual({ observed: 0, disposed: 1 });
  });

  test("a denied subscription fails at the channel stage and disposes the client", async () => {
    // A subscription error settles `ready` but no channel ever becomes ready.
    const { client, calls } = fakeClient(() => Promise.resolve());
    const failure = await startChannel(client, "s", never(), {
      timeoutMs: TIMEOUT_MS,
      diagnostics,
    }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ChannelStartupError);
    expect((failure as ChannelStartupError).stage).toBe("channel");
    expect(calls).toEqual({ observed: 1, disposed: 1 });
  });

  test("a rejected ready propagates and still disposes the client", async () => {
    const { client, calls } = fakeClient(() => Promise.reject(new Error("refused")));
    const failure = await startChannel(client, "s", never(), {
      timeoutMs: 60_000,
      diagnostics,
    }).catch((error: unknown) => error);
    expect((failure as Error).message).toBe("refused");
    expect(calls.disposed).toBe(1);
  });

  test("a channel that becomes ready resolves and keeps the client", async () => {
    const { client, calls } = fakeClient(() => Promise.resolve());
    await startChannel(client, "s", Promise.resolve(), { timeoutMs: 60_000, diagnostics });
    expect(calls).toEqual({ observed: 1, disposed: 0 });
  });
});
