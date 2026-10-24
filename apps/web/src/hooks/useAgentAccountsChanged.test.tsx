import { afterEach, expect, mock, test } from "bun:test";
import { act, cleanup, render } from "@testing-library/react";
import { listen, NATIVE_EVENT_STREAM_CONNECTED_EVENT } from "@/lib/native/events";
import { useAgentAccountsChanged } from "./useAgentAccountsChanged";
import type { AgentAccountPlatform } from "@orkestrator/protocol/agent-accounts";

const listenMock = listen as ReturnType<typeof mock>;
afterEach(() => {
  cleanup();
  listenMock.mockReset();
  listenMock.mockImplementation(() => Promise.resolve(() => {}));
});

test("filters malformed and unrelated events and reconciles after reconnect with the latest callback", async () => {
  const handlers = new Map<string, (event: { payload: unknown }) => unknown>();
  const signals: AbortSignal[] = [];
  listenMock.mockImplementation(async (event, callback, options) => {
    handlers.set(event, callback);
    if (options?.signal) signals.push(options.signal);
    return () => handlers.delete(event);
  });
  const first = mock(() => {});
  const next = mock(() => {});
  function Probe({
    platform,
    changed,
  }: {
    platform: AgentAccountPlatform | null;
    changed: () => void;
  }) {
    useAgentAccountsChanged(platform, changed);
    return null;
  }
  const view = render(<Probe platform="claude" changed={first} />);
  await act(async () => {});
  const send = (payload: unknown) => handlers.get("agent-accounts-changed")!({ payload });
  for (const payload of [
    null,
    [],
    "claude",
    {},
    { platform: "codex" },
    { platform: "grok" },
    { platform: 1 },
  ])
    send(payload);
  expect(first).not.toHaveBeenCalled();
  send({ platform: "claude" });
  expect(first).toHaveBeenCalledTimes(1);
  view.rerender(<Probe platform="claude" changed={next} />);
  await act(async () => {
    handlers.get(NATIVE_EVENT_STREAM_CONNECTED_EVENT)!({ payload: undefined });
  });
  expect(first).toHaveBeenCalledTimes(1);
  expect(next).toHaveBeenCalledTimes(1);
  view.unmount();
  expect(signals.every((signal) => signal.aborted)).toBe(true);
});
