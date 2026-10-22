import "./testing/unit-test-env.js";
import { afterEach, describe, expect, test } from "bun:test";
import type { AcpProcess, SessionState } from "./acp-context.js";
import { clearApprovals, parkPermission, permissionDetail } from "./acp-session.js";
import { publicApprovals } from "./acp-public.js";

const OPTIONS = [
  { optionId: "allow", name: "Allow once", kind: "allow_once" },
  { optionId: "reject", name: "Reject", kind: "reject_once" },
];

describe("permissionDetail", () => {
  test("an execute call with a command is a command approval", () => {
    expect(
      permissionDetail({
        toolCall: { toolCallId: "1", kind: "execute", rawInput: { command: "bun test" } },
      }),
    ).toEqual({ kind: "command", command: "bun test" });
    expect(
      permissionDetail({
        toolCall: { toolCallId: "1", kind: "execute", rawInput: { command: ["git", "status"] } },
      }),
    ).toEqual({ kind: "command", command: "git status" });
  });

  test("an edit, delete or move with a path is a file change", () => {
    expect(
      permissionDetail({
        toolCall: {
          toolCallId: "1",
          kind: "edit",
          locations: [{ path: "/w/a.ts" }, { path: "/w/b.ts" }, { path: "/w/a.ts" }],
        },
      }),
    ).toEqual({ kind: "file-change", paths: ["/w/a.ts", "/w/b.ts"] });
    expect(
      permissionDetail({
        toolCall: { toolCallId: "1", kind: "delete", rawInput: { file_path: "/w/old.ts" } },
      }),
    ).toEqual({ kind: "file-change", paths: ["/w/old.ts"] });
  });

  test("reads the kind and input recorded for the call when the request names only its id", () => {
    expect(
      permissionDetail(
        { toolCall: { toolCallId: "1", title: "Run" } },
        { kind: "execute", input: { command: "make" } },
      ),
    ).toEqual({ kind: "command", command: "make" });
    expect(
      permissionDetail({ toolCall: { toolCallId: "1" } }, { kind: "edit", locationPath: "/w/x" }),
    ).toEqual({ kind: "file-change", paths: ["/w/x"] });
    // Without a kind anywhere, a known tool name still classifies it.
    expect(
      permissionDetail({
        toolCall: { toolCallId: "1", rawInput: { _toolName: "bash", command: "ls" } },
      }),
    ).toEqual({ kind: "command", command: "ls" });
  });

  test("reads through Grok's use_tool wrapper", () => {
    expect(
      permissionDetail({
        toolCall: {
          toolCallId: "1",
          kind: "execute",
          rawInput: {
            variant: "UseTool",
            tool_name: "bash",
            tool_input: JSON.stringify({ command: "rm -rf build" }),
          },
        },
      }),
    ).toEqual({ kind: "command", command: "rm -rf build" });
  });

  test("anything else, or a command or file change without its detail, stays a permission", () => {
    for (const toolCall of [
      { toolCallId: "1", kind: "fetch", rawInput: { url: "https://example.com" } },
      { toolCallId: "1", kind: "other" },
      { toolCallId: "1", kind: "execute", rawInput: {} },
      { toolCallId: "1", kind: "edit", locations: [] },
      { toolCallId: "1", title: "Something" },
    ]) {
      expect(permissionDetail({ toolCall })).toEqual({ kind: "permission" });
    }
    expect(permissionDetail({})).toEqual({ kind: "permission" });
  });

  test("bounds the command and the path list", () => {
    const long = permissionDetail({
      toolCall: { toolCallId: "1", kind: "execute", rawInput: { command: "x".repeat(10_000) } },
    });
    expect(long.kind === "command" && Buffer.byteLength(long.command)).toBeLessThanOrEqual(4_096);
    const many = permissionDetail({
      toolCall: {
        toolCallId: "1",
        kind: "edit",
        locations: Array.from({ length: 50 }, (_, index) => ({ path: `/w/${index}` })),
      },
    });
    expect(many.kind === "file-change" && many.paths.length).toBe(20);
  });
});

describe("published approvals", () => {
  const parked: SessionState[] = [];
  afterEach(() => {
    for (const state of parked.splice(0)) clearApprovals(state);
  });

  test("carry the kind and what the call runs beside the agent's options", () => {
    const child = { respond: () => undefined } as unknown as AcpProcess;
    const state = {
      id: "detail-test",
      acpSessionId: "vendor-session",
      child,
      approvals: new Map(),
      interactions: new Map(),
      messages: [],
      revision: 0,
      status: "running",
    } as unknown as SessionState;
    parked.push(state);
    parkPermission(state, child, 1, {
      sessionId: "vendor-session",
      toolCall: {
        toolCallId: "call-1",
        title: "Run tests",
        kind: "execute",
        rawInput: { command: "bun test" },
      },
      options: OPTIONS,
    });
    parkPermission(state, child, 2, {
      sessionId: "vendor-session",
      toolCall: { toolCallId: "call-2", title: "Fetch a page", kind: "fetch" },
      options: OPTIONS,
    });
    expect(publicApprovals(state)).toEqual([
      expect.objectContaining({ title: "Run tests", kind: "command", command: "bun test" }),
      expect.objectContaining({ title: "Fetch a page", kind: "permission" }),
    ]);
    expect(publicApprovals(state)[1]).not.toHaveProperty("command");
  });
});
