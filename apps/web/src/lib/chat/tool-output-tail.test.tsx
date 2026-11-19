/**
 * The bounded output tail of an expanded running tool row
 * (docs/architecture/push-events.md, "The `tool-output` topic"): expanding
 * reads the tail and subscribes to the call's key, a frame reads forward from
 * the held end, "load earlier" reads before the held start, and collapsing
 * releases the subscription and stops reading.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { useMemo, useState, type ReactNode } from "react";
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import {
  sliceToolOutput,
  type NativeAgentToolOutputRead,
} from "@orkestrator/protocol/native-agent-tool-output";
import {
  PUSH_CHANGED_EVENT,
  PUSH_STREAM_STATE_EVENT,
  formatToolOutputPushKey,
  type PushSetSubscriptionsArgs,
} from "@orkestrator/protocol/push-events";
import { ManualClock } from "@orkestrator/protocol/testing/manual-clock";
import { FakeNodeClient, cleanupNodeScopes, renderInNodeScope } from "@/test/render-in-node-scope";
import { useNodeScope } from "@/lib/node-scope/providers";
import { pushClientFor } from "@/lib/push/push-subscriptions";
import { TerminalProvider } from "@/contexts";
import { NativeMessage } from "@/components/chat/NativeMessage";
import { useMessagePartExpansionStore } from "@/stores/messagePartExpansionStore";
import type { NativeMessagePart } from "@/lib/chat/native-message-types";
import {
  ToolOutputTailContext,
  useToolOutputTail,
  type ToolOutputTailSource,
} from "./tool-output-tail";

const STREAM = "stream-aaaaaaaaaaaaaaaa";
const SESSION = { environmentId: "env-1", agent: "codex" as const, logicalSessionKey: "tab-1" };
const KEY = formatToolOutputPushKey({ ...SESSION, toolUseId: "call-1" });

type ReadInput = Parameters<ToolOutputTailSource["read"]>[0];

/** The call's output on the "backend", and every read made of it. */
function fakeCall(initial: string, complete = false) {
  const state = { output: initial, complete, status: "ok" as "ok" | "missing" };
  const reads: ReadInput[] = [];
  const read = async (input: ReadInput): Promise<NativeAgentToolOutputRead> => {
    reads.push(input);
    if (state.status !== "ok") return { status: state.status };
    return {
      status: "ok",
      complete: state.complete,
      ...sliceToolOutput(state.output, input),
    };
  };
  return { state, reads, read };
}

function pushClient() {
  return new FakeNodeClient({
    invoke: {
      push_set_subscriptions: (args: Readonly<Record<string, unknown>>) => {
        const set = args as unknown as PushSetSubscriptionsArgs;
        return {
          status: "applied",
          setRevision: set.setRevision,
          seqBase: 0,
          subscriptions: set.subscriptions.map(({ topic, key }) => ({
            topic,
            key,
            status: "ok",
            generation: "g1",
            revision: 0,
          })),
        };
      },
    },
  });
}

function TailProvider({
  read,
  timers,
  children,
}: {
  read: ToolOutputTailSource["read"];
  timers: ManualClock;
  children: ReactNode;
}) {
  const scope = useNodeScope();
  const value = useMemo<ToolOutputTailSource>(
    () => ({ scope, ...SESSION, read, timers }),
    [scope, read, timers],
  );
  return <ToolOutputTailContext.Provider value={value}>{children}</ToolOutputTailContext.Provider>;
}

function Probe({ initiallyOpen = true }: { initiallyOpen?: boolean }) {
  const [open, setOpen] = useState(initiallyOpen);
  const tail = useToolOutputTail("call-1", "ref-1", open);
  return (
    <div>
      <button type="button" onClick={() => setOpen((value) => !value)}>
        toggle
      </button>
      <button type="button" onClick={() => tail?.loadEarlier()}>
        earlier
      </button>
      <pre data-testid="text">{tail?.text ?? ""}</pre>
      <span
        data-testid="tail"
        data-active={tail ? "yes" : "no"}
        data-loading={tail?.loading ? "yes" : "no"}
        data-earlier={tail?.earlierBytes ?? -1}
        data-complete={tail?.complete ? "yes" : "no"}
      />
    </div>
  );
}

function setup(initial: string, ui: ReactNode = <Probe />, complete = false) {
  const call = fakeCall(initial, complete);
  const client = pushClient();
  // The row's poll runs on this clock; nothing in it fires unless advanced.
  const clock = new ManualClock();
  const view = renderInNodeScope(
    <TailProvider read={call.read} timers={clock}>
      {ui}
    </TailProvider>,
    { client },
  );
  const sets = () => client.calls("push_set_subscriptions");
  const lastKeys = () =>
    (sets().at(-1)?.args as unknown as PushSetSubscriptionsArgs | undefined)?.subscriptions.map(
      (entry) => entry.key,
    ) ?? [];
  const connect = async () => {
    await act(async () => {
      client.emit(PUSH_STREAM_STATE_EVENT, {
        state: "connected",
        offer: { versions: [1], streamId: STREAM },
      });
    });
  };
  let seq = 0;
  const frame = async () => {
    seq += 1;
    await act(async () => {
      client.emit(PUSH_CHANGED_EVENT, {
        seq,
        changes: [
          { topic: "tool-output", key: KEY, generation: "g1", revision: seq, parts: ["output"] },
        ],
      });
    });
  };
  const text = () => screen.getByTestId("text").textContent;
  const tail = () => screen.getByTestId("tail");
  /** Run the row's due poll ticks and settle the reads they start. */
  const advance = (ms: number) => act(async () => void (await clock.advanceAsync(ms)));
  return { call, client, clock, view, sets, lastKeys, connect, frame, text, tail, advance };
}

afterEach(() => {
  cleanupNodeScopes();
  useMessagePartExpansionStore.getState().reset();
});

describe("useToolOutputTail", () => {
  test("reads the tail on expanding, subscribes, and appends from its cursor on each frame", async () => {
    const h = setup("line 1\n");
    await waitFor(() => expect(h.text()).toBe("line 1\n"));
    expect(h.call.reads[0]).toMatchObject({ mode: "tail", toolUseId: "call-1" });
    await h.connect();
    await waitFor(() =>
      expect(pushClientFor(h.view.scope).isHealthy("tool-output", KEY)).toBe(true),
    );
    expect(h.lastKeys()).toEqual([KEY]);

    h.call.state.output += "line 2\n";
    const before = h.call.reads.length;
    await h.frame();
    await waitFor(() => expect(h.text()).toBe("line 1\nline 2\n"));
    const forward = h.call.reads.slice(before).find((read) => read.mode === "range");
    expect(forward).toMatchObject({ mode: "range", cursor: 7 });
    expect(forward?.anchor).toBeDefined();
  });

  test("collapsing releases the subscription and stops reading", async () => {
    const h = setup("running\n");
    await waitFor(() => expect(h.text()).toBe("running\n"));
    await h.connect();
    await waitFor(() => expect(h.lastKeys()).toEqual([KEY]));
    fireEvent.click(screen.getByText("toggle"));
    await waitFor(() => expect(h.lastKeys()).toEqual([]));
    expect(h.tail().dataset.active).toBe("no");
    expect(h.text()).toBe("");
    // Nothing is armed: no poll, and a frame for the key reads nothing (a
    // read would have been sent synchronously from the frame's listener).
    expect(h.clock.pendingCount()).toBe(0);
    const reads = h.call.reads.length;
    h.call.state.output += "more\n";
    await h.frame();
    await h.advance(60_000);
    expect(h.call.reads.length).toBe(reads);
  });

  test("a collapsed row reads and subscribes to nothing", async () => {
    const h = setup("quiet\n", <Probe initiallyOpen={false} />);
    await h.connect();
    expect(h.clock.pendingCount()).toBe(0);
    await h.advance(60_000);
    expect(h.call.reads).toHaveLength(0);
    expect(h.lastKeys()).toEqual([]);
  });

  test("load earlier reads the range before the held start and prepends it", async () => {
    const output = `${"a".repeat(40_000)}\n${"b".repeat(20_000)}\n`;
    const h = setup(output);
    await waitFor(() => expect(h.tail().dataset.loading).toBe("no"));
    expect(Number(h.tail().dataset.earlier)).toBe(output.length - 32 * 1024);
    fireEvent.click(screen.getByText("earlier"));
    await waitFor(() => expect(h.tail().dataset.earlier).toBe("0"));
    const earlier = h.call.reads.find((read) => read.mode === "before");
    expect(earlier).toMatchObject({ cursor: output.length - 32 * 1024 });
    expect(h.text()).toBe(output);
  });

  test("a completed call stops subscribing", async () => {
    const h = setup("done\n", <Probe />, true);
    await waitFor(() => expect(h.tail().dataset.complete).toBe("yes"));
    // Completion disarms the poll and leaves nothing to subscribe.
    expect(h.clock.pendingCount()).toBe(0);
    await h.connect();
    expect(h.lastKeys()).toEqual([]);
    await h.advance(60_000);
    expect(h.call.reads).toHaveLength(1);
  });

  test("an answer the node cannot serve falls back to the row's details", async () => {
    const h = setup("x");
    h.call.state.status = "missing";
    // The first read already raced; the next one answers missing.
    await waitFor(() => expect(h.call.reads.length).toBeGreaterThanOrEqual(1));
    await h.connect();
    await h.frame();
    await waitFor(() => expect(h.tail().dataset.active).toBe("no"));
  });

  test("without a healthy subscription a running call is polled", async () => {
    const h = setup("tick\n");
    await waitFor(() => expect(h.text()).toBe("tick\n"));
    h.call.state.output += "tock\n";
    expect(h.clock.pendingDelays()).toEqual([2_000]);
    await h.advance(2_000);
    await waitFor(() => expect(h.text()).toBe("tick\ntock\n"));
  });
});

describe("expanded running tool row", () => {
  type ToolCall = Extract<NativeMessagePart, { type: "tool-invocation" }>;
  const running: ToolCall = {
    type: "tool-invocation",
    content: "make test",
    toolName: "Bash",
    toolArgs: { command: "make test" },
    toolState: "pending",
    toolUseId: "call-1",
    detailRef: "ref-1",
    createdAt: "2026-11-19T10:00:00.000Z",
  };

  function row(part: ToolCall) {
    return (
      <TerminalProvider>
        <NativeMessage
          agentExpansionScope="tail-test"
          loadToolDetails={async () => {
            throw new Error("details must not be read while the tail serves the row");
          }}
          message={{
            id: "m1",
            role: "assistant",
            content: "",
            createdAt: "2026-11-19T10:00:00.000Z",
            parts: [part],
          }}
        />
      </TerminalProvider>
    );
  }

  test("expanding shows the tail with its truncation marker; collapsing stops it", async () => {
    const output = `${"x".repeat(50_000)}\nlast line\n`;
    const h = setup(output, row(running));
    expect(h.call.reads).toHaveLength(0);
    const trigger = screen
      .getAllByRole("button")
      .find((button) => button.hasAttribute("aria-expanded"))!;
    fireEvent.click(trigger);
    await waitFor(() => expect(screen.getByText(/last line/)).toBeTruthy());
    expect(screen.getByTestId("tool-output-truncation").textContent).toContain(
      "of earlier output not shown",
    );
    expect(screen.getByRole("button", { name: "Load earlier" })).toBeTruthy();
    await h.connect();
    await waitFor(() => expect(h.lastKeys()).toEqual([KEY]));
    fireEvent.click(trigger);
    await waitFor(() => expect(h.lastKeys()).toEqual([]));
  });
});
