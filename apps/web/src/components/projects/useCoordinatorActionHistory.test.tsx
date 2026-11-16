import { afterEach, expect, test } from "bun:test";
import { act, waitFor } from "@testing-library/react";
import { cleanupNodeScopes, FakeNodeClient, renderInNodeScope } from "@/test/render-in-node-scope";
import {
  ACTION_HISTORY_RETRY_MS,
  useCoordinatorActionHistory,
} from "./useCoordinatorActionHistory";
import { installControlledTimeout } from "../../../../../tests/helpers/controlled-timeout";
import { coordinatorActionCards } from "./coordinator-action-cards";
import type { NativeMessage } from "@/lib/chat/native-message-types";
import type { NativeAgentTranscriptUpdate } from "@orkestrator/protocol/native-agent";

afterEach(cleanupNodeScopes);
const old: NativeMessage = {
  id: "historic",
  role: "assistant",
  content: "",
  createdAt: "2026-11-09",
  parts: [
    {
      type: "tool-invocation",
      content: "",
      toolName: "orkestrator_mark_question",
      toolArgs: { title: "Historical question" },
      toolState: "success",
    },
  ],
};
function Probe({ enabled = true, session = "session" }: { enabled?: boolean; session?: string }) {
  const evidence = useCoordinatorActionHistory(enabled, "environment", "tab", "codex", session);
  return (
    <output>
      {coordinatorActionCards(evidence ?? [])
        .map((card) => card.title)
        .join(",")}
    </output>
  );
}
function transcriptSnapshot(): Extract<
  NativeAgentTranscriptUpdate<NativeMessage>,
  { status: "snapshot" }
> {
  return {
    viewVersion: 1,
    status: "snapshot",
    token: "token",
    value: {
      identity: {
        backendInstanceId: "backend",
        environmentId: "environment",
        platform: "codex",
        logicalSessionKey: "env-environment:tab",
        providerSessionId: "session",
        sourceGeneration: "1",
      },
      freshness: "current",
      messages: Array.from({ length: 100 }, (_, index) => ({
        ...old,
        id: `tail-${index}`,
        parts: [],
      })),
      historyCursor: "older",
      historyEpoch: "epoch",
      historyComplete: false,
    },
  };
}
function client() {
  return new FakeNodeClient({
    invoke: {
      get_native_agent_transcript_update: transcriptSnapshot(),
      get_native_agent_message_page: {
        syncVersion: 1,
        messages: [old],
        historyEpoch: "epoch",
        complete: true,
        truncated: false,
      },
    },
  });
}
test("two node-scoped clients reload a bounded transcript and independently discover historical cards", async () => {
  for (let index = 0; index < 2; index++) {
    const node = client();
    const view = renderInNodeScope(<Probe />, { client: node });
    await waitFor(() => expect(view.container.textContent).toBe("Historical question"));
    // The view's direct cursor pages the older rows.
    expect(node.calls("get_native_agent_transcript_update")).toHaveLength(1);
    expect(node.calls("get_native_agent_message_page")).toHaveLength(1);
    expect(node.calls("get_native_agent_message_page")[0]!.args).toMatchObject({
      environmentId: "environment",
      before: "older",
      limit: 200,
    });
    view.rerender(<Probe session="replacement" enabled={false} />);
    expect(view.container.textContent).toBe("");
    cleanupNodeScopes();
  }
});
test("worker conversations do not scan action history", () => {
  const node = client();
  renderInNodeScope(<Probe enabled={false} />, { client: node });
  expect(node.invocations).toHaveLength(0);
});

test("an incomplete cold preview retries until historical cards recover without a remount", async () => {
  // Keep Testing Library's timeout distinct from the controlled 1s retry.
  const timer = installControlledTimeout(ACTION_HISTORY_RETRY_MS);
  const node = client();
  const snapshot = transcriptSnapshot();
  let reads = 0;
  node.respond("get_native_agent_transcript_update", () =>
    ++reads <= 2
      ? {
          ...snapshot,
          token: "preview",
          value: {
            ...snapshot.value,
            freshness: "cached",
            historyCursor: undefined,
            historyComplete: false,
          },
        }
      : snapshot,
  );
  try {
    const view = renderInNodeScope(<Probe />, { client: node });
    for (let attempt = 0; attempt < 2; attempt++) {
      await waitFor(() => expect(timer.pendingCount()).toBe(1), { timeout: 2_000 });
      expect(view.container.textContent).toBe("");
      expect(node.calls("get_native_agent_message_page")).toHaveLength(0);
      act(() => {
        expect(timer.advance()).toBe(1);
      });
    }
    await waitFor(() => expect(view.container.textContent).toBe("Historical question"), {
      timeout: 2_000,
    });
    expect(reads).toBe(3);
    expect(node.calls("get_native_agent_message_page")).toHaveLength(1);
    timer.assertDrained();
  } finally {
    cleanupNodeScopes();
    expect(timer.restore()).toBe(0);
  }
});

test("disabling or unmounting cancels a preview retry", async () => {
  for (const unmount of [false, true]) {
    const timer = installControlledTimeout(ACTION_HISTORY_RETRY_MS);
    const snapshot = transcriptSnapshot();
    const node = client().respond("get_native_agent_transcript_update", {
      ...snapshot,
      value: { ...snapshot.value, messages: [], historyCursor: undefined, historyComplete: false },
    });
    try {
      const view = renderInNodeScope(<Probe />, { client: node });
      await waitFor(() => expect(timer.pendingCount()).toBe(1), { timeout: 2_000 });
      if (unmount) view.unmount();
      else view.rerender(<Probe enabled={false} />);
      expect(timer.pendingCount()).toBe(0);
      expect(timer.advance()).toBe(0);
      expect(node.calls("get_native_agent_transcript_update")).toHaveLength(1);
    } finally {
      cleanupNodeScopes();
      expect(timer.restore()).toBe(0);
    }
  }
});

test("an abandoned preview response cannot schedule a retry or publish stale evidence", async () => {
  const timer = installControlledTimeout(ACTION_HISTORY_RETRY_MS);
  let finish!: (value: unknown) => void;
  const pending = new Promise((resolve) => {
    finish = resolve;
  });
  const node = client().respond("get_native_agent_transcript_update", () => pending);
  try {
    const view = renderInNodeScope(<Probe />, { client: node });
    expect(node.calls("get_native_agent_transcript_update")).toHaveLength(1);
    view.rerender(<Probe session="replacement" enabled={false} />);
    await act(async () => {
      const snapshot = transcriptSnapshot();
      finish({
        ...snapshot,
        value: { ...snapshot.value, historyCursor: undefined, historyComplete: false },
      });
      await pending;
    });
    expect(view.container.textContent).toBe("");
    expect(timer.pendingCount()).toBe(0);
    expect(node.calls("get_native_agent_message_page")).toHaveLength(0);
  } finally {
    cleanupNodeScopes();
    expect(timer.restore()).toBe(0);
  }
});

test("a complete cursorless view recovers cards without scheduling a retry", async () => {
  const timer = installControlledTimeout(ACTION_HISTORY_RETRY_MS);
  const snapshot = transcriptSnapshot();
  const node = client().respond("get_native_agent_transcript_update", {
    ...snapshot,
    value: { ...snapshot.value, messages: [old], historyCursor: undefined, historyComplete: true },
  });
  try {
    const view = renderInNodeScope(<Probe />, { client: node });
    await waitFor(() => expect(view.container.textContent).toBe("Historical question"), {
      timeout: 2_000,
    });
    expect(timer.pendingCount()).toBe(0);
    expect(node.calls("get_native_agent_message_page")).toHaveLength(0);
  } finally {
    cleanupNodeScopes();
    expect(timer.restore()).toBe(0);
  }
});
