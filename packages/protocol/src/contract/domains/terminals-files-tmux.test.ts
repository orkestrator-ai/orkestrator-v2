/**
 * The `terminals`, `files` and `claude-tmux` domains (plan item 7002): every
 * command is defined in version 1 of its domain, classifies reads as the
 * routing classifier does, decodes tolerantly, and has a client with a
 * version-1 adapter (envelope) and a version-0 legacy adapter (today's body).
 * Hot-path results skip decoding only where the transport asks for it.
 */
import { describe, expect, it } from "bun:test";
import * as Result from "effect/Result";
import { isNodeReadCommand } from "../../command-nodes.js";
import type { NegotiatedDomains } from "../../node-client.js";
import { createDomainClient, type ContractEnvelopeFields } from "../client.js";
import { DOMAIN_CLIENTS, buildAdapterList } from "../client-adapters.js";
import { decodeCommandArgs, decodeCommandResult, type AnyCommandDef } from "../command.js";
import { canonicalJsonSchema } from "../json-schema.js";
import { CLAUDE_TMUX_COMMANDS, claudeTmuxClient } from "./claude-tmux/index.js";
import { FILES_COMMANDS, filesClient } from "./files/index.js";
import { TERMINALS_COMMANDS, terminalsClient } from "./terminals/index.js";

const ALL: readonly AnyCommandDef[] = [
  ...TERMINALS_COMMANDS,
  ...FILES_COMMANDS,
  ...CLAUDE_TMUX_COMMANDS,
];

/** Backend-internal callers only (in-process `commands.get(...)`), so not grant-reachable. */
const INTERNAL = new Set([
  "check_container_workspace_paths",
  "delete_container_annotation_evidence",
  "claude_tmux_reconcile_orphans",
  "claude_tmux_submit_queued",
  "reconcile_claude_state_polling",
]);

const HOT_PATH = new Set([
  "terminal_write",
  "terminal_resize",
  "local_terminal_write",
  "local_terminal_resize",
  "get_terminal_output_buffer",
  "get_terminal_output_snapshot",
  "get_terminal_state_snapshot",
  "get_terminal_history_page",
  "claude_tmux_write_interactive_terminal",
  "claude_tmux_resize_interactive_terminal",
]);

const CRITICAL: Record<string, readonly string[]> = {
  launch_terminal_job: ["requestId"],
  write_local_file: ["expected"],
  write_container_file: ["expected"],
  delete_container_annotation_evidence: ["digest"],
  claude_tmux_answer_selection_prompt: [
    "expectedGeneration",
    "expectedRevision",
    "expectedPromptFingerprint",
  ],
};

describe("terminals, files and claude-tmux definitions", () => {
  it("define 26, 28 and 28 commands, each in version 1 of its domain", () => {
    expect(TERMINALS_COMMANDS).toHaveLength(26);
    expect(FILES_COMMANDS).toHaveLength(28);
    expect(CLAUDE_TMUX_COMMANDS).toHaveLength(28);
    expect(new Set(ALL.map((def) => def.name)).size).toBe(ALL.length);
    for (const def of ALL) {
      expect(def.since).toBe(1);
      expect(def.domain.version).toBe(1);
      expect(def.domain.min).toBe(1);
    }
    expect(new Set(TERMINALS_COMMANDS.map((def) => def.domain.name))).toEqual(
      new Set(["terminals"]),
    );
    expect(new Set(FILES_COMMANDS.map((def) => def.domain.name))).toEqual(new Set(["files"]));
    expect(new Set(CLAUDE_TMUX_COMMANDS.map((def) => def.domain.name))).toEqual(
      new Set(["claude-tmux"]),
    );
  });

  it("classify reads as isNodeReadCommand does", () => {
    for (const def of ALL)
      expect([def.name, def.read]).toEqual([def.name, isNodeReadCommand(def.name)]);
  });

  it("are workspace commands except the backend-internal callers", () => {
    for (const def of ALL) {
      expect([def.name, def.access]).toEqual([
        def.name,
        INTERNAL.has(def.name) ? "internal" : "workspace",
      ]);
    }
  });

  it("mark the idempotency and safety keys critical, and nothing else", () => {
    for (const def of ALL)
      expect([def.name, def.critical]).toEqual([def.name, CRITICAL[def.name] ?? []]);
  });

  it("mark terminal input, resize and output reads as the hot path", () => {
    for (const def of ALL)
      expect([def.name, def.hotPath]).toEqual([def.name, HOT_PATH.has(def.name)]);
  });

  it("export a stable JSON Schema for every argument and result schema", () => {
    for (const def of ALL) {
      expect(canonicalJsonSchema(def.args)).toBe(canonicalJsonSchema(def.args));
      expect(() => canonicalJsonSchema(def.result)).not.toThrow();
    }
  });

  it("decode tolerantly: an unknown key is dropped, a lenient key keeps any value", () => {
    const write = TERMINALS_COMMANDS.find((def) => def.name === "terminal_write")!;
    const decoded = decodeCommandArgs(write, { sessionId: "s", data: "x", future: true });
    expect(Result.isSuccess(decoded) && decoded.success).toEqual({ sessionId: "s", data: "x" });
    const resize = TERMINALS_COMMANDS.find((def) => def.name === "terminal_resize")!;
    expect(Result.isSuccess(decodeCommandArgs(resize, { sessionId: "s", cols: "wide" }))).toBe(
      true,
    );
    // The strict handler before (assertOnlyKeys) refused this.
    const read = FILES_COMMANDS.find((def) => def.name === "read_environment_file_base64")!;
    expect(
      Result.isSuccess(decodeCommandArgs(read, { environmentId: "e", filePath: "a", extra: 1 })),
    ).toBe(true);
  });

  it("refuse a missing required string with the commands-validation text's path", () => {
    const write = TERMINALS_COMMANDS.find((def) => def.name === "terminal_write")!;
    const decoded = decodeCommandArgs(write, { data: "x" });
    expect(Result.isFailure(decoded)).toBe(true);
  });

  it("accept the result shapes older backends answer", () => {
    const def = (name: string) => ALL.find((candidate) => candidate.name === name)!;
    const ok = (name: string, value: unknown) =>
      expect([name, Result.isSuccess(decodeCommandResult(def(name), value))]).toEqual([name, true]);
    ok("terminal_write", undefined);
    ok("terminal_write", { delivered: false });
    ok("create_terminal_session", { sessionId: "s", created: true });
    ok("get_terminal_output_snapshot", { output: "", revision: 0, generation: 1 });
    ok("claude_tmux_transcript", [{ type: "user", message: { content: "hi" } }]);
    ok("claude_tmux_transcript", { lines: [], earlierCursor: null });
    ok("get_file_tree", [{ name: "a", path: "a", isDirectory: true, children: [] }]);
    ok("get_file_tree", { unchanged: true, digest: "d" });
    ok("get_worktree_snapshot_revisions", { entries: [] });
    ok("get_worktree_snapshot_revisions", { status: "unchanged", generation: "g", revision: 3 });
  });

  it("keep a transcript line whole: its keys are Claude's", () => {
    const def = CLAUDE_TMUX_COMMANDS.find((c) => c.name === "claude_tmux_transcript")!;
    const line = { type: "assistant", _raw: "{}", taskSnapshots: { t: { items: [] } } };
    const decoded = decodeCommandResult(def, { lines: [line], earlierCursor: null });
    expect(Result.isSuccess(decoded) && decoded.success).toEqual({
      lines: [line],
      earlierCursor: null,
    });
  });

  it("are listed in the adapter list with a legacy adapter each", () => {
    for (const client of [terminalsClient, filesClient, claudeTmuxClient]) {
      expect(DOMAIN_CLIENTS).toContain(client);
      expect(client.versions).toEqual([1, 0]);
      expect(buildAdapterList().domains[client.domain.name]).toEqual({
        current: 1,
        adapters: [1, 0],
      });
    }
  });
});

interface Sent {
  readonly command: string;
  readonly args: unknown;
  readonly envelope: ContractEnvelopeFields | undefined;
}

function fakeNode(answer: (command: string, args: unknown) => unknown) {
  const sent: Sent[] = [];
  const usage: Array<[string, number]> = [];
  return {
    sent,
    usage,
    options: (
      domains: NegotiatedDomains | null,
      extra: { validateHotPathResults?: boolean } = {},
    ) => ({
      call: async (
        def: AnyCommandDef,
        args: unknown,
        envelope: ContractEnvelopeFields | undefined,
      ) => {
        sent.push({ command: def.name, args, envelope });
        return answer(def.name, args);
      },
      // The legacy adapter's untyped call: today's body, no envelope.
      invoke: async (command: string, args?: Readonly<Record<string, unknown>>) => {
        sent.push({ command, args, envelope: undefined });
        return answer(command, args);
      },
      domains,
      usage: (domain: string, version: number) => usage.push([domain, version]),
      ...extra,
    }),
  };
}

const CURRENT: NegotiatedDomains = {
  terminals: { min: 1, max: 1 },
  files: { min: 1, max: 1 },
  "claude-tmux": { min: 1, max: 1 },
};

describe("terminals client", () => {
  it("version 1 sends the envelope, with requestId critical on a job launch", async () => {
    const node = fakeNode(() => ({
      jobId: "j",
      environmentId: "e",
      tabId: "t",
      tabType: "plain",
      status: "started",
    }));
    const client = createDomainClient(terminalsClient, node.options(CURRENT));
    expect(client.version()).toBe(1);
    await client.api().launch_terminal_job({
      environmentId: "e",
      requestId: "r",
      tabType: "plain",
      data: "ls\n",
    });
    expect(node.sent[0]?.envelope).toEqual({
      domain: "terminals",
      version: 1,
      critical: ["requestId"],
    });
    expect(node.usage).toEqual([]);
  });

  it("version 0: a pre-contract node gets today's body, and the call is counted", async () => {
    const node = fakeNode(() => undefined);
    const client = createDomainClient(terminalsClient, node.options(null));
    expect(client.version()).toBe(0);
    await expect(client.api().terminal_write({ sessionId: "s", data: "x" })).resolves.toBe(
      undefined,
    );
    expect(node.sent).toEqual([
      { command: "terminal_write", args: { sessionId: "s", data: "x" }, envelope: undefined },
    ]);
    expect(node.usage).toEqual([["terminals", 0]]);
  });

  it("version 0 answers as sent: a pre-contract node's own shapes are not decoded", async () => {
    const node = fakeNode(() => ({ sessionId: "s", created: "yes", legacy: 1 }));
    const created = await createDomainClient(terminalsClient, node.options(null))
      .api()
      .create_terminal_session({ containerId: "c" });
    expect(created).toEqual({ sessionId: "s", created: "yes", legacy: 1 } as never);
  });

  it("decodes hot-path results unless the transport opts out", async () => {
    // A malformed answer is refused when decoding, and passed through when not.
    const node = fakeNode(() => ({ delivered: "yes" }));
    const decoding = createDomainClient(terminalsClient, node.options(CURRENT));
    await expect(decoding.api().terminal_write({ sessionId: "s", data: "x" })).rejects.toThrow(
      /Invalid result from terminal_write/u,
    );
    const trusting = createDomainClient(
      terminalsClient,
      node.options(CURRENT, { validateHotPathResults: false }),
    );
    await expect(trusting.api().terminal_write({ sessionId: "s", data: "x" })).resolves.toEqual({
      delivered: "yes",
    } as never);
    // Other commands are always decoded.
    await expect(trusting.api().get_terminal_session({ sessionId: "s" })).rejects.toThrow(
      /Invalid result from get_terminal_session/u,
    );
  });
});

describe("files client", () => {
  it("sends the write precondition as critical to a node with the domain, today's body otherwise", async () => {
    const node = fakeNode(() => "src/a.ts");
    const args = {
      worktreePath: "/w",
      filePath: "src/a.ts",
      base64Data: "",
      expected: { sha256: "0".repeat(64) },
    };
    await createDomainClient(filesClient, node.options(CURRENT)).api().write_local_file(args);
    await createDomainClient(filesClient, node.options({})).api().write_local_file(args);
    expect(node.sent.map((sent) => sent.envelope)).toEqual([
      { domain: "files", version: 1, critical: ["expected"] },
      undefined,
    ]);
  });

  it("drops undeclared keys of a tree node and keeps the declared ones", async () => {
    const node = fakeNode(() => [
      {
        name: "a",
        path: "a",
        isDirectory: true,
        future: 1,
        children: [{ name: "b", path: "a/b", isDirectory: false, extension: "ts" }],
      },
    ]);
    const tree = await createDomainClient(filesClient, node.options(CURRENT))
      .api()
      .get_local_file_tree({ worktreePath: "/w" });
    expect(tree).toEqual([
      {
        name: "a",
        path: "a",
        isDirectory: true,
        children: [{ name: "b", path: "a/b", isDirectory: false, extension: "ts" }],
      },
    ]);
  });
});

describe("claude-tmux client", () => {
  it("sends the expected prompt as critical and reads a pre-paging node's array", async () => {
    const node = fakeNode((command) => (command === "claude_tmux_transcript" ? [] : undefined));
    const current = createDomainClient(claudeTmuxClient, node.options(CURRENT)).api();
    await current.claude_tmux_answer_selection_prompt({
      environmentId: "e",
      tabId: "t",
      expectedGeneration: "g",
      expectedRevision: 2,
      expectedPromptFingerprint: "f",
      optionIndex: 0,
    });
    expect(node.sent[0]?.envelope?.critical).toEqual([
      "expectedGeneration",
      "expectedRevision",
      "expectedPromptFingerprint",
    ]);
    const legacy = createDomainClient(claudeTmuxClient, node.options(null)).api();
    await expect(
      legacy.claude_tmux_transcript({ environmentId: "e", tabId: "t", page: {} }),
    ).resolves.toEqual([]);
    expect(node.sent[1]?.envelope).toBeUndefined();
  });
});
