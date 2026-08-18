import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { act, cleanup, render, screen } from "@testing-library/react";
import * as persistence from "@/lib/prompt-queue-persistence";
import {
  hydratePromptQueue,
  promptQueueKey,
  resetPromptQueueRevisions,
  type PromptQueueDispatchError,
  type PromptQueueSource,
} from "@/lib/prompt-queue-persistence";
import { retryAgentPromptQueueDispatch } from "@/lib/prompt-queue-sources";
import { invoke } from "@/lib/native/backend";
import { useClaudeStore } from "@/stores/claudeStore";
import { useClaudeTmuxStore } from "@/stores/claudeTmuxStore";
import { useCodexStore } from "@/stores/codexStore";
import { useOpenCodeStore } from "@/stores/openCodeStore";
import { usePromptQueueDispatchRecovery } from "./usePromptQueueDispatchRecovery";

/**
 * The dispatch-error latch is the only path by which a backend refusal to drain
 * a queue reaches a human, so these tests drive the real persistence module
 * rather than a mock of it: the shared listener set and the snapshot identity it
 * has to preserve are exactly what would break useSyncExternalStore.
 */

const invokeMock = invoke as unknown as ReturnType<typeof mock>;

const stores = [useClaudeStore, useCodexStore, useOpenCodeStore, useClaudeTmuxStore];

let renderCount = 0;
let revision = 0;
let latest: ReturnType<typeof usePromptQueueDispatchRecovery> | null = null;

function Probe({ agent, sessionKey }: { agent: string; sessionKey: string }) {
  renderCount += 1;
  latest = usePromptQueueDispatchRecovery(agent, sessionKey);
  return <div data-testid="dispatch-error">{latest.dispatchError?.message ?? "none"}</div>;
}

function error(message: string): PromptQueueDispatchError {
  return {
    requestId: "req-1",
    messageId: "queued-1",
    messageFingerprint: "fingerprint-1",
    message,
    failedAt: "2026-07-30T00:00:00.000Z",
  };
}

/** A source that only records, so publishing never touches a real store. */
function recordingSource(agent: string): PromptQueueSource {
  return {
    agent,
    getQueues: () => new Map(),
    setQueue: () => {},
    environmentIdFor: () => "abc123",
  };
}

/**
 * Publishes what the backend change feed would deliver. `observeDispatchError`
 * is module-private, so the latch is exercised through its real entry point.
 */
async function publish(
  agent: string,
  sessionKey: string,
  dispatchError: PromptQueueDispatchError | undefined,
) {
  const queueKey = promptQueueKey(agent, sessionKey);
  // Each publish is a distinct backend write, so it must carry a newer revision:
  // a replayed one is discarded as an echo of this client's own state.
  revision += 1;
  await act(async () => {
    await hydratePromptQueue(queueKey, [recordingSource(agent)], async () => ({
      queueKey,
      environmentId: "abc123",
      messages: [{ id: "queued-1" }],
      ...(dispatchError ? { dispatchError } : {}),
      updatedAt: "2026-07-30T00:00:00.000Z",
      revision,
    }));
  });
}

beforeEach(() => {
  renderCount = 0;
  revision = 0;
  latest = null;
  invokeMock.mockClear();
  resetPromptQueueRevisions();
});

afterEach(() => {
  cleanup();
  resetPromptQueueRevisions();
  for (const store of stores) {
    (store as unknown as { setState: (partial: unknown) => void }).setState({
      messageQueue: new Map(),
    });
  }
});

describe("usePromptQueueDispatchRecovery", () => {
  test("reports a dispatch error already latched for its queue key", async () => {
    await publish("claude", "env-abc123:tab-1", error("Provider rejected this prompt."));

    render(<Probe agent="claude" sessionKey="env-abc123:tab-1" />);

    expect(screen.getByTestId("dispatch-error").textContent).toBe("Provider rejected this prompt.");
  });

  test("re-renders when the backend parks and later unparks its queue", async () => {
    render(<Probe agent="claude" sessionKey="env-abc123:tab-1" />);
    expect(screen.getByTestId("dispatch-error").textContent).toBe("none");

    await publish("claude", "env-abc123:tab-1", error("Agent session is gone."));
    expect(screen.getByTestId("dispatch-error").textContent).toBe("Agent session is gone.");

    await publish("claude", "env-abc123:tab-1", undefined);
    expect(screen.getByTestId("dispatch-error").textContent).toBe("none");
  });

  test("scopes the error to its own queue key across agents and tabs", async () => {
    render(<Probe agent="claude" sessionKey="env-abc123:tab-1" />);
    const rendersAfterMount = renderCount;

    // Same session key, different agent namespace, then same agent, other tab.
    await publish("codex", "env-abc123:tab-1", error("Codex refused."));
    await publish("claude", "env-abc123:tab-2", error("Other tab refused."));

    expect(screen.getByTestId("dispatch-error").textContent).toBe("none");
    // A shared listener set notifies every subscriber; an unchanged snapshot is
    // what stops an unrelated queue from re-rendering this tab.
    expect(renderCount).toBe(rendersAfterMount);
  });

  test("keeps the snapshot identity when an equal error is republished", async () => {
    render(<Probe agent="claude" sessionKey="env-abc123:tab-1" />);
    await publish("claude", "env-abc123:tab-1", error("Provider rejected this prompt."));
    const first = latest?.dispatchError;
    const rendersAfterFirst = renderCount;

    await publish("claude", "env-abc123:tab-1", error("Provider rejected this prompt."));

    // useSyncExternalStore loops forever on a getSnapshot that returns a fresh
    // object for unchanged state.
    expect(latest?.dispatchError).toBe(first);
    expect(renderCount).toBe(rendersAfterFirst);
  });

  test("retry clears the latch through the matching agent source", async () => {
    render(<Probe agent="codex" sessionKey="env-abc123:tab-1" />);

    await act(async () => {
      await latest?.retry();
    });

    expect(invokeMock).toHaveBeenCalledWith("retry_prompt_queue_dispatch", {
      queueKey: promptQueueKey("codex", "env-abc123:tab-1"),
    });
  });

  test("retry stays stable per queue and does not touch another agent", async () => {
    render(<Probe agent="opencode" sessionKey="env-abc123:tab-9" />);
    const retry = latest?.retry;

    await publish("opencode", "env-abc123:tab-9", error("OpenCode refused."));
    expect(latest?.retry).toBe(retry);

    await act(async () => {
      await latest?.retry();
    });

    expect(invokeMock.mock.calls).toEqual([
      [
        "retry_prompt_queue_dispatch",
        {
          queueKey: promptQueueKey("opencode", "env-abc123:tab-9"),
        },
      ],
    ]);
  });

  test("unsubscribes from the latch on unmount", async () => {
    const realSubscribe = persistence.subscribePromptQueueDispatchErrors;
    const unsubscribes: Array<ReturnType<typeof mock>> = [];
    const subscribeSpy = spyOn(persistence, "subscribePromptQueueDispatchErrors");
    subscribeSpy.mockImplementation((listener: () => void) => {
      const detach = realSubscribe(listener);
      const spied = mock(() => detach());
      unsubscribes.push(spied);
      return spied;
    });

    try {
      const { unmount } = render(<Probe agent="claude" sessionKey="env-abc123:tab-1" />);
      expect(unsubscribes).toHaveLength(1);
      expect(unsubscribes[0]).not.toHaveBeenCalled();

      unmount();

      expect(unsubscribes[0]).toHaveBeenCalledTimes(1);
    } finally {
      subscribeSpy.mockRestore();
    }

    // A leaked listener would keep publishing into the unmounted tree.
    renderCount = 0;
    await publish("claude", "env-abc123:tab-1", error("After unmount."));
    expect(renderCount).toBe(0);
  });
});

describe("retryAgentPromptQueueDispatch", () => {
  test("delegates to the source that owns the agent namespace", async () => {
    await retryAgentPromptQueueDispatch("claude-tmux", "env:abc123:tab:tab-1");

    expect(invokeMock).toHaveBeenCalledWith("retry_prompt_queue_dispatch", {
      queueKey: promptQueueKey("claude-tmux", "env:abc123:tab:tab-1"),
    });
  });

  test("is a no-op for an agent with no registered source", async () => {
    // A tab for an agent that is not mirrored must not reach the backend with a
    // key no source could ever reconcile.
    await retryAgentPromptQueueDispatch("gemini", "env-abc123:tab-1");

    expect(invokeMock).not.toHaveBeenCalled();
  });
});
