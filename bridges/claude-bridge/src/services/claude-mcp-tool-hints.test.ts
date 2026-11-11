import { describe, expect, test } from "bun:test";
import type { McpServerStatus } from "@anthropic-ai/claude-agent-sdk";
import {
  claudeMcpNameSegment,
  claudeMcpToolHintsFromStatus,
  readClaudeMcpToolHints,
} from "./claude-mcp-tool-hints.js";

/**
 * The status the pinned CLI 2.1.319 answered for a local MCP server named
 * `hint.srv x` whose tools declared every hint (`wipe.disk tool`:
 * destructive, not read-only, idempotent, closed-world; `read_thing`:
 * read-only, open-world). Only the `true` hints survive, under the shared
 * keys. `canUseTool` named the calls `mcp__hint_srv_x__wipe_disk_tool` and
 * `mcp__hint_srv_x__read_thing`, with `mcpServer.name` `hint.srv x`.
 */
const OBSERVED: McpServerStatus[] = [
  {
    name: "hint.srv x",
    status: "connected",
    source: "dynamic",
    scope: "dynamic",
    tools: [
      { name: "wipe.disk tool", annotations: { destructive: true } },
      { name: "read_thing", annotations: { readOnly: true, openWorld: true } },
      { name: "plain", annotations: {} },
    ],
  },
];

describe("claudeMcpNameSegment", () => {
  test("replaces what the CLI replaces and keeps the rest", () => {
    expect(claudeMcpNameSegment("hint.srv x")).toBe("hint_srv_x");
    expect(claudeMcpNameSegment("wipe.disk tool")).toBe("wipe_disk_tool");
    expect(claudeMcpNameSegment("Repo-tools_2")).toBe("Repo-tools_2");
    expect(claudeMcpNameSegment("a/b:c@d")).toBe("a_b_c_d");
  });
});

describe("claudeMcpToolHintsFromStatus", () => {
  test("finds the observed tools by the names canUseTool gave them", () => {
    expect(
      claudeMcpToolHintsFromStatus(OBSERVED, "hint.srv x", "mcp__hint_srv_x__wipe_disk_tool"),
    ).toEqual({ destructive: true });
    expect(
      claudeMcpToolHintsFromStatus(OBSERVED, "hint.srv x", "mcp__hint_srv_x__read_thing"),
    ).toEqual({ readOnly: true, openWorld: true });
  });

  test("a tool the server declared nothing for has no hints", () => {
    expect(
      claudeMcpToolHintsFromStatus(OBSERVED, "hint.srv x", "mcp__hint_srv_x__plain"),
    ).toBeUndefined();
    const bare: McpServerStatus[] = [
      { name: "repo", status: "connected", tools: [{ name: "deploy" }] },
    ];
    expect(claudeMcpToolHintsFromStatus(bare, "repo", "mcp__repo__deploy")).toBeUndefined();
  });

  test("keeps only boolean hints under the shared keys", () => {
    const odd = [
      {
        name: "repo",
        status: "connected",
        tools: [
          {
            name: "deploy",
            annotations: { destructive: "yes", readOnlyHint: true, idempotent: false },
          },
          { name: "junk", annotations: "readOnly" },
        ],
      },
    ] as unknown as McpServerStatus[];
    expect(claudeMcpToolHintsFromStatus(odd, "repo", "mcp__repo__deploy")).toEqual({
      idempotent: false,
    });
    expect(claudeMcpToolHintsFromStatus(odd, "repo", "mcp__repo__junk")).toBeUndefined();
  });

  test("names the server by its configured name, never by the call's prefix alone", () => {
    // The call's server segment is `hint_srv_x`; a server configured under
    // that exact name is not the one canUseTool named.
    const lookalike: McpServerStatus[] = [
      {
        name: "hint_srv_x",
        status: "connected",
        tools: [{ name: "wipe.disk tool", annotations: { readOnly: true } }],
      },
    ];
    expect(
      claudeMcpToolHintsFromStatus(lookalike, "hint.srv x", "mcp__hint_srv_x__wipe_disk_tool"),
    ).toBeUndefined();
    // A call whose prefix is not the named server's is not its tool.
    expect(
      claudeMcpToolHintsFromStatus(OBSERVED, "hint.srv x", "mcp__other__wipe_disk_tool"),
    ).toBeUndefined();
  });

  test("ambiguity gives no hints rather than a guess", () => {
    // Two tools the CLI writes the same way.
    const collision: McpServerStatus[] = [
      {
        name: "repo",
        status: "connected",
        tools: [
          { name: "a.b", annotations: { readOnly: true } },
          { name: "a_b", annotations: { destructive: true } },
        ],
      },
    ];
    expect(claudeMcpToolHintsFromStatus(collision, "repo", "mcp__repo__a_b")).toBeUndefined();
    // Two servers reported under one name.
    const twice: McpServerStatus[] = [
      {
        name: "repo",
        status: "connected",
        tools: [{ name: "x", annotations: { readOnly: true } }],
      },
      { name: "repo", status: "failed", tools: [] },
    ];
    expect(claudeMcpToolHintsFromStatus(twice, "repo", "mcp__repo__x")).toBeUndefined();
  });

  test("a tool missing from the status, a non-MCP call or no server name has none", () => {
    expect(
      claudeMcpToolHintsFromStatus(OBSERVED, "hint.srv x", "mcp__hint_srv_x__added_later"),
    ).toBeUndefined();
    expect(claudeMcpToolHintsFromStatus(OBSERVED, "hint.srv x", "Bash")).toBeUndefined();
    expect(claudeMcpToolHintsFromStatus(OBSERVED, "", "mcp____read_thing")).toBeUndefined();
    expect(
      claudeMcpToolHintsFromStatus(
        [{ name: "repo", status: "pending" }],
        "repo",
        "mcp__repo__deploy",
      ),
    ).toBeUndefined();
  });
});

describe("readClaudeMcpToolHints", () => {
  test("reads the live status for an MCP call", async () => {
    let reads = 0;
    const control = {
      mcpServerStatus: async () => {
        reads += 1;
        return OBSERVED;
      },
    };
    expect(
      await readClaudeMcpToolHints(control, "hint.srv x", "mcp__hint_srv_x__wipe_disk_tool"),
    ).toEqual({ destructive: true });
    expect(reads).toBe(1);
  });

  test("never reads for a non-MCP call or a call with no server", async () => {
    let reads = 0;
    const control = {
      mcpServerStatus: async () => {
        reads += 1;
        return OBSERVED;
      },
    };
    expect(await readClaudeMcpToolHints(control, "hint.srv x", "Bash")).toBeUndefined();
    expect(
      await readClaudeMcpToolHints(control, undefined, "mcp__hint_srv_x__read_thing"),
    ).toBeUndefined();
    expect(reads).toBe(0);
  });

  test("no control, or one without the method, gives none", async () => {
    expect(
      await readClaudeMcpToolHints(undefined, "hint.srv x", "mcp__hint_srv_x__read_thing"),
    ).toBeUndefined();
    expect(
      await readClaudeMcpToolHints({}, "hint.srv x", "mcp__hint_srv_x__read_thing"),
    ).toBeUndefined();
  });

  test("a failed or closed read gives none instead of failing the approval", async () => {
    const closed = {
      mcpServerStatus: async (): Promise<McpServerStatus[]> => {
        throw new Error("Query closed before response received");
      },
    };
    expect(
      await readClaudeMcpToolHints(closed, "hint.srv x", "mcp__hint_srv_x__read_thing"),
    ).toBeUndefined();
    const throwsAtOnce = {
      mcpServerStatus: (): Promise<McpServerStatus[]> => {
        throw new Error("no transport");
      },
    };
    expect(
      await readClaudeMcpToolHints(throwsAtOnce, "hint.srv x", "mcp__hint_srv_x__read_thing"),
    ).toBeUndefined();
    const notAList = {
      mcpServerStatus: async () => ({}) as unknown as McpServerStatus[],
    };
    expect(
      await readClaudeMcpToolHints(notAList, "hint.srv x", "mcp__hint_srv_x__read_thing"),
    ).toBeUndefined();
  });

  test("a read slower than the timeout parks without hints, and a late rejection is handled", async () => {
    let reject!: (error: Error) => void;
    const slow = {
      mcpServerStatus: () =>
        new Promise<McpServerStatus[]>((_resolve, fail) => {
          reject = fail;
        }),
    };
    const started = Date.now();
    expect(
      await readClaudeMcpToolHints(slow, "hint.srv x", "mcp__hint_srv_x__read_thing", 20),
    ).toBeUndefined();
    expect(Date.now() - started).toBeLessThan(1_000);
    // The race already holds a handler, so this is not an unhandled rejection.
    reject(new Error("Query closed before response received"));
    await Bun.sleep(0);
  });
});
