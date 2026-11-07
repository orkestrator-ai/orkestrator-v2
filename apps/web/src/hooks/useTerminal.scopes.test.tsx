/**
 * Plan item 3010: a terminal belongs to the node whose scope renders it. Its
 * commands, its output and its reconnect re-read all go to that node's client,
 * so input is ordered by that node's transport and never by another's.
 */
import { afterEach, expect, test } from "bun:test";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { BackendId } from "@orkestrator/protocol/federation";
import type { ReactNode } from "react";
import { NodeScopeProvider, WindowScopeProvider } from "@/lib/node-scope/providers";
import type { NodeScope } from "@/lib/node-scope/node-scope";
import { WindowScope } from "@/lib/node-scope/window-scope";
import { FakeNodeClient } from "@/test/render-in-node-scope";
import { useTerminal } from "./useTerminal";

const NODE_A = "bk_terminal-a" as BackendId;
const NODE_B = "bk_terminal-b" as BackendId;

let windowScope: WindowScope | null = null;

afterEach(() => {
  windowScope?.dispose();
  windowScope = null;
});

/** A node with one local PTY, `pty-1`: session ids are node-local, so both nodes use it. */
function nodeClient(nodeId: BackendId): FakeNodeClient {
  return new FakeNodeClient({
    nodeId,
    invoke: {
      create_local_terminal_session: { sessionId: "pty-1", created: true, bootstrapped: false },
      start_local_terminal_session: null,
      local_terminal_write: null,
      local_terminal_resize: null,
      close_local_terminal_session: null,
      get_terminal_session: null,
      get_terminal_state_snapshot: null,
      get_terminal_output_snapshot: { output: "", revision: 0, generation: 1, truncated: false },
      acknowledge_terminal_snapshot: null,
    },
  });
}

function twoNodes() {
  windowScope = new WindowScope();
  const clientA = nodeClient(NODE_A);
  const clientB = nodeClient(NODE_B);
  const a = windowScope.open({ role: "command", client: clientA });
  const b = windowScope.open({ role: "leaf", client: clientB });
  return { a, b, clientA, clientB };
}

function inScope(scope: NodeScope) {
  return ({ children }: { children: ReactNode }) => (
    <WindowScopeProvider windowScope={windowScope!}>
      <NodeScopeProvider scope={scope}>{children}</NodeScopeProvider>
    </WindowScopeProvider>
  );
}

function renderTerminal(scope: NodeScope, received: string[], replayOutputBuffer = false) {
  const decoder = new TextDecoder();
  return renderHook(
    () =>
      useTerminal({
        containerId: null,
        environmentId: "env-1",
        isLocal: true,
        terminalKey: "env-1:default",
        replayOutputBuffer,
        onData: (data) => {
          received.push(decoder.decode(data));
        },
      }),
    { wrapper: inScope(scope) },
  );
}

test("a terminal on node B uses B's commands and B's terminal transport", async () => {
  const { b, clientA, clientB } = twoNodes();
  const received: string[] = [];
  const { result, unmount } = renderTerminal(b, received);

  await act(() => result.current.connect());
  await waitFor(() => expect(result.current.isConnected).toBe(true));

  expect(clientB.calls("create_local_terminal_session")).toHaveLength(1);
  expect(clientB.calls("start_local_terminal_session")).toHaveLength(1);
  expect(clientB.listenerCount("terminal-output-pty-1")).toBe(1);
  expect(clientA.invocations).toEqual([]);
  expect(clientA.listenerCount()).toBe(0);

  act(() => clientB.emitTerminalOutput("pty-1", { text: "from B", revision: 1, generation: 1 }));
  await waitFor(() => expect(received).toEqual(["from B"]));

  // Node A's identical session id is a different PTY: its output never arrives here.
  act(() => clientA.emitTerminalOutput("pty-1", { text: "from A", revision: 2, generation: 1 }));
  expect(received).toEqual(["from B"]);

  await act(() => result.current.write("ls\r"));
  expect(clientB.calls("local_terminal_write").map((call) => call.args)).toEqual([
    { sessionId: "pty-1", data: "ls\r" },
  ]);
  expect(clientA.calls("local_terminal_write")).toEqual([]);

  unmount();
  expect(clientB.listenerCount("terminal-output-pty-1")).toBe(0);
});

test("terminal input is ordered per node", async () => {
  const { a, b, clientA, clientB } = twoNodes();
  const onA = renderTerminal(a, []);
  const onB = renderTerminal(b, []);
  await act(() => onA.result.current.connect());
  await act(() => onB.result.current.connect());
  await waitFor(() => expect(onA.result.current.isConnected).toBe(true));
  await waitFor(() => expect(onB.result.current.isConnected).toBe(true));

  await act(async () => {
    await onA.result.current.write("a1");
    await onB.result.current.write("b1");
    await onA.result.current.write("a2");
    await onB.result.current.write("b2");
  });

  const writes = (client: FakeNodeClient) =>
    client.calls("local_terminal_write").map((call) => call.args.data);
  expect(writes(clientA)).toEqual(["a1", "a2"]);
  expect(writes(clientB)).toEqual(["b1", "b2"]);
  onA.unmount();
  onB.unmount();
});

test("a replaying terminal on node B re-reads when B's connection comes back", async () => {
  const { b, clientB } = twoNodes();
  const { result, unmount } = renderTerminal(b, [], true);
  await act(() => result.current.connect());
  await waitFor(() => expect(result.current.isConnected).toBe(true));
  const reads = () => clientB.calls("get_terminal_state_snapshot").length;
  const before = reads();

  act(() => clientB.connection.set("connecting"));
  act(() => clientB.connection.set("live"));

  await waitFor(() => expect(reads()).toBeGreaterThan(before));
  unmount();
});
