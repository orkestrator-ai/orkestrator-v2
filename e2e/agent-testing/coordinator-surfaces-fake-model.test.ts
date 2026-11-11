import { describe, expect, test } from "bun:test";
import {
  carrierWakeFacts,
  FAKE_ASKED_REPLY,
  FAKE_REPLY,
  FAKE_WAKE_REPLY,
  parseSurfaceRequest,
  scriptedTurn,
  wakeFacts,
  type WakeFacts,
} from "./coordinator-surfaces-fake-model-script";

const tools = (...names: string[]) =>
  names.map((name) => ({ type: "function", function: { name } }));
const COORDINATOR_TOOLS = tools(
  "mcp_orkestrator_request_root_changes",
  "mcp_orkestrator_open_worker_browser",
);
const user = (content: string) => ({ role: "user", content });
const call = (name: string) => ({
  role: "assistant",
  content: null,
  tool_calls: [{ id: name, type: "function", function: { name, arguments: "{}" } }],
});
const result = (value: unknown) => ({ role: "tool", content: JSON.stringify(value, null, 2) });
const ROOT_INPUT = {
  requestId: "surfaces-root-approve",
  environmentId: "env-1",
  files: ["notes.txt", "new-file.txt"],
  reason: "Continue my uncommitted work.",
};

describe("coordinator surfaces fake model", () => {
  test("reads the scripted request line, and nothing else", () => {
    expect(
      parseSurfaceRequest(
        `Please do this.\nsurfaces-fake: request_root_changes ${JSON.stringify(ROOT_INPUT)}\n`,
      ),
    ).toEqual({ tool: "request_root_changes", input: ROOT_INPUT });
    expect(
      parseSurfaceRequest('surfaces-fake: open_worker_browser {"url":"http://localhost:1/"}'),
    ).toEqual({ tool: "open_worker_browser", input: { url: "http://localhost:1/" } });
    expect(parseSurfaceRequest("surfaces-fake: launch_terminal {}")).toBeUndefined();
    expect(parseSurfaceRequest("surfaces-fake: open_worker_browser {not json}")).toBeUndefined();
    expect(parseSurfaceRequest("surfaces-fake: open_worker_browser []")).toBeUndefined();
  });

  test("calls the named tool once with the spec's input, then ends the turn", () => {
    const base = [user(`surfaces-fake: request_root_changes ${JSON.stringify(ROOT_INPUT)}`)];
    expect(scriptedTurn({ messages: base, tools: COORDINATOR_TOOLS })).toEqual({
      step: { kind: "tool", name: "mcp_orkestrator_request_root_changes", input: ROOT_INPUT },
    });
    expect(
      scriptedTurn({
        messages: [...base, call("request"), result({ state: "pending", approvalRequestId: "a" })],
        tools: COORDINATOR_TOOLS,
      }),
    ).toEqual({
      step: { kind: "text", text: FAKE_ASKED_REPLY },
      result: { tool: "request_root_changes", ok: true },
    });
  });

  test("counts a tool error as a failed result", () => {
    const base = [user('surfaces-fake: open_worker_browser {"url":"http://localhost:1/"}')];
    expect(
      scriptedTurn({
        messages: [
          ...base,
          call("open"),
          {
            role: "tool",
            content: "This requestId was used by another conversation of this coordinator.",
          },
        ],
        tools: COORDINATOR_TOOLS,
      }).result,
    ).toEqual({ tool: "open_worker_browser", ok: false });
  });

  test("says so when the tool is not offered", () => {
    const step = scriptedTurn({
      messages: [user('surfaces-fake: open_worker_browser {"url":"http://localhost:1/"}')],
      tools: tools("mcp_orkestrator_request_root_changes"),
    }).step;
    expect(step).toEqual({ kind: "text", text: "The open_worker_browser tool is not offered." });
  });

  test("a wake is answered with text and counted once, by state", () => {
    const carrier = (state: string) =>
      `<orkestrator-peer-message from="Orkestrator">Request ${state}: Apply uncommitted checkout changes to “fixture-local” on this machine</orkestrator-peer-message>`;
    const wake = scriptedTurn({ messages: [user(carrier("executed"))], tools: COORDINATOR_TOOLS });
    expect(wake).toEqual({
      step: { kind: "text", text: FAKE_WAKE_REPLY },
      wakes: [{ rootChanges: true, state: "executed" }],
    });
    // A second request of the same wake turn is not a second wake.
    expect(
      scriptedTurn({
        messages: [user(carrier("rejected")), call("x"), result({})],
        tools: COORDINATOR_TOOLS,
      }).wakes,
    ).toBeUndefined();
    expect(wakeFacts(carrier("rejected"))).toEqual({ rootChanges: true, state: "rejected" });
    expect(wakeFacts("<orkestrator-peer-message>Build finished")).toEqual({
      rootChanges: false,
      state: "other",
    });
  });

  test("a batched wake counts every carrier, duplicates included", () => {
    const carrier = (state: string, id: string) =>
      `<orkestrator-peer-message version="1">Request ${state}: Apply uncommitted checkout changes to “fixture-local” (node-action:${id})</orkestrator-peer-message>`;
    const prompt = [
      carrier("executed", "req-1"),
      carrier("executed", "req-1"),
      '<orkestrator-peer-message version="1">Build finished</orkestrator-peer-message>',
    ].join("\n\n");
    const expected: WakeFacts[] = [
      { rootChanges: true, state: "executed", approvalRequestId: "req-1" },
      { rootChanges: true, state: "executed", approvalRequestId: "req-1" },
      { rootChanges: false, state: "other" },
    ];
    expect(carrierWakeFacts(prompt)).toEqual(expected);
    expect(scriptedTurn({ messages: [user(prompt)], tools: COORDINATOR_TOOLS }).wakes).toEqual(
      expected,
    );
    // One carrier's facts never borrow another's state or request ID.
    expect(
      carrierWakeFacts(
        `${carrier("rejected", "req-2")}\n\n<orkestrator-peer-message version="1">Apply uncommitted checkout changes</orkestrator-peer-message>`,
      ),
    ).toEqual([
      { rootChanges: true, state: "rejected", approvalRequestId: "req-2" },
      { rootChanges: true, state: "other" },
    ]);
  });

  test("anything else is one line of text", () => {
    expect(scriptedTurn({ messages: [user("hello")], tools: COORDINATOR_TOOLS }).step).toEqual({
      kind: "text",
      text: FAKE_REPLY,
    });
  });
});
