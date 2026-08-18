import { describe, expect, mock, test } from "bun:test";
import path from "node:path";
import {
  agentMcpConfigJson,
  agentToolConnectionTarget,
  boundedInfoEventMessage,
  containerExecArgs,
  fastModeFromPane,
  fastModeRejectionFromPane,
  isDirectJsonlChild,
  isMissingTmuxSessionError,
  jsonlByMtimeFindCommand,
  listLocalJsonlByMtime,
  newestJsonlFindCommand,
  newestJsonlInDir,
  parseFreshJsonlFindOutput,
  parseTmuxSessionNames,
  parseTranscriptHeadOutput,
  PREVIOUS_SESSION_STAT_CONCURRENCY,
  probeThinkingDisplaySupport,
  selectReapableTmuxSessions,
  tailFromOffsetCommand,
  thinkingDisplayProbeArgs,
  thinkingDisplayProbeIndicatesSupport,
  TMUX_HOOK_PAYLOAD_MAX_BYTES,
  tmuxSessionName,
  tmuxSessionNamePrefix,
  transcriptContainsSessionId,
  transcriptHeadCommand,
  TranscriptTail,
} from "../../../apps/backend/src/core/tmux";
import { tmuxSelectionPromptFingerprint } from "../../../packages/protocol/src/tmux-observation";
import { spawnSync } from "node:child_process";
import { existsSync, promises as fs } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";

import {
  createHandlers,
  createTempDir,
  deferred,
  encodeCwd,
  invoke,
  waitFor,
  withFakeTmuxRuntime,
} from "./tmux-test-harness.js";

test("fast-mode pane parsing uses the newest acknowledgement and strips ANSI", () => {
  expect(fastModeFromPane("Fast mode ON\n\u001b[31mFast mode OFF\u001b[0m")).toBe(false);
  expect(fastModeFromPane("Fast mode ON")).toBe(true);
  expect(fastModeFromPane("ordinary transcript text")).toBeUndefined();
  expect(fastModeFromPane("fAsT MoDe oN")).toBe(true);
});

test("fast-mode pane parsing surfaces visible command rejections", () => {
  expect(fastModeRejectionFromPane("Fast mode is unavailable for this model")).toBe(
    "Fast mode is unavailable for this model",
  );
  expect(fastModeRejectionFromPane("Unknown command: /fast")).toBe("Unknown command: /fast");
  expect(fastModeRejectionFromPane("Fast mode requires an eligible plan")).toBe(
    "Fast mode requires an eligible plan",
  );
  expect(fastModeRejectionFromPane("/fast requires Claude Code 2.1")).toBe(
    "/fast requires Claude Code 2.1",
  );
  expect(fastModeRejectionFromPane("Fast mode ON")).toBeUndefined();
});

test("Claude tmux agent MCP config uses Claude's mcpServers document shape", () => {
  expect(
    JSON.parse(
      agentMcpConfigJson({
        url: "http://127.0.0.1:4567/mcp",
        token: "project-token",
      }),
    ),
  ).toEqual({
    mcpServers: {
      orkestrator: {
        type: "http",
        url: "http://127.0.0.1:4567/mcp",
        headers: {
          Authorization: "Bearer project-token",
        },
      },
    },
  });
});

test("Claude's installed parser accepts the generated agent MCP config", async () => {
  const isolatedHome = await createTempDir("ork-claude-mcp-parser-");
  const parse = (config: string) => {
    const result = spawnSync(
      "claude",
      ["--mcp-config", config, "--strict-mcp-config", "--print", ""],
      {
        encoding: "utf8",
        timeout: 10_000,
        env: {
          ...process.env,
          HOME: isolatedHome,
          CLAUDE_CONFIG_DIR: path.join(isolatedHome, ".claude"),
          ANTHROPIC_API_KEY: "",
          CLAUDE_CODE_OAUTH_TOKEN: "",
        },
      },
    );
    if (result.error) throw result.error;
    return `${result.stdout}\n${result.stderr}`;
  };

  const rejected = parse(
    JSON.stringify({
      orkestrator: {
        type: "http",
        url: "http://127.0.0.1:4567/mcp",
      },
    }),
  );
  expect(rejected).toContain("Invalid MCP configuration");
  expect(rejected).toContain("mcpServers");

  const accepted = parse(
    agentMcpConfigJson({
      url: "http://127.0.0.1:4567/mcp",
      token: "project-token",
    }),
  );
  expect(accepted).not.toContain("Invalid MCP configuration");
  expect(accepted).toContain("Input must be provided");
});

test("Claude tmux selects the agent tool endpoint for its execution backend", () => {
  expect(agentToolConnectionTarget("local")).toBe("host");
  expect(agentToolConnectionTarget("container")).toBe("container");
});

describe("tmux session cleanup helpers", () => {
  test("recognizes tmux's ordinary missing-session diagnostics", () => {
    for (const diagnostic of [
      "can't find session: missing",
      "no server running on /tmp/tmux-501/default",
      "failed to connect to server",
      "no sessions",
    ]) {
      expect(isMissingTmuxSessionError(diagnostic)).toBe(true);
    }
    expect(isMissingTmuxSessionError("permission denied")).toBe(false);
    expect(isMissingTmuxSessionError(new Error("unrelated failure"))).toBe(false);
  });

  test("derives stable sanitized prefixes and parses list-sessions output", () => {
    expect(tmuxSessionNamePrefix("environment/with spaces and a long suffix")).toBe(
      "orkestrator-environmentwiths-",
    );
    expect(tmuxSessionNamePrefix("///")).toBe("orkestrator-id-");
    expect(parseTmuxSessionNames(" first \n\nsecond\r\n  third  \n")).toEqual([
      "first",
      "second",
      "third",
    ]);
  });

  test("selects only an environment's sessions and fails closed on a contested prefix", () => {
    const environmentId = "0123456789abcdef-target";
    const own = tmuxSessionName(environmentId, "tab-own");
    const other = tmuxSessionName("other", "tab-other");
    expect(
      selectReapableTmuxSessions({
        names: [other, own],
        environmentId,
        survivingEnvironmentIds: [environmentId, "other"],
      }),
    ).toEqual([own]);

    expect(
      selectReapableTmuxSessions({
        names: [own],
        environmentId,
        survivingEnvironmentIds: ["0123456789abcdef-survivor"],
      }),
    ).toEqual([]);
  });
});

describe("container transcript discovery helpers", () => {
  test("builds a GNU find query scoped to fresh jsonl files in the project dir", () => {
    const command = newestJsonlFindCommand("/home/node/.claude/projects/-workspace", 1_700_000_000);
    expect(command).toContain("'/home/node/.claude/projects/-workspace'/");
    expect(command).toContain("-name '*.jsonl'");
    expect(command).toContain("-newermt @1700000000");
    expect(command).toContain("-printf '%T@ %p\\0'");
    expect(command).toContain("sort -z -rn");
  });

  test("parses a single NUL-framed find record into a path/mtime record", () => {
    const output = "1700000002.5 /home/node/.claude/projects/p/new.jsonl\0";
    expect(parseFreshJsonlFindOutput(output)).toEqual([
      { path: "/home/node/.claude/projects/p/new.jsonl", mtime: 1700000002.5 },
    ]);
  });

  test("returns no records for empty, legacy newline, or unterminated output", () => {
    expect(parseFreshJsonlFindOutput("")).toEqual([]);
    expect(parseFreshJsonlFindOutput("\n  \n")).toEqual([]);
    expect(parseFreshJsonlFindOutput("1700000002 /home/node/.claude/projects/p/new.jsonl")).toEqual(
      [],
    );
  });

  test("parses every candidate when output contains multiple NUL records", () => {
    const output = `${[
      "1700000003 /home/node/.claude/projects/p/b.jsonl",
      "1700000002 /home/node/.claude/projects/p/a.jsonl",
    ].join("\0")}\0`;
    expect(parseFreshJsonlFindOutput(output)).toEqual([
      { path: "/home/node/.claude/projects/p/b.jsonl", mtime: 1700000003 },
      { path: "/home/node/.claude/projects/p/a.jsonl", mtime: 1700000002 },
    ]);
  });

  test("preserves spaces in the parsed path", () => {
    const output = "1700000002 /home/node/.claude/projects/p/with space.jsonl\0";
    expect(parseFreshJsonlFindOutput(output)).toEqual([
      { path: "/home/node/.claude/projects/p/with space.jsonl", mtime: 1700000002 },
    ]);
  });

  test("preserves newlines inside a filename rather than forging another record", () => {
    const pathWithNewline = "/home/node/.claude/projects/p/real.jsonl\n1700000999 outside.jsonl";
    expect(parseFreshJsonlFindOutput(`1700000002 ${pathWithNewline}\0`)).toEqual([
      { path: pathWithNewline, mtime: 1700000002 },
    ]);
  });

  test("skips records lacking a path field or with a non-finite mtime", () => {
    expect(parseFreshJsonlFindOutput("1700000002\0")).toEqual([]);
    expect(parseFreshJsonlFindOutput("notanumber /home/node/.claude/projects/p/x.jsonl\0")).toEqual(
      [],
    );
    const mixed = `${[
      "1700000003 /home/node/.claude/projects/p/good.jsonl",
      "1700000002", // no path
      "bad /home/node/.claude/projects/p/skip.jsonl", // non-finite mtime
    ].join("\0")}\0`;
    expect(parseFreshJsonlFindOutput(mixed)).toEqual([
      { path: "/home/node/.claude/projects/p/good.jsonl", mtime: 1700000003 },
    ]);
  });

  test("accepts only normalized direct jsonl children", () => {
    const dir = "/home/node/.claude/projects/p";
    expect(isDirectJsonlChild(dir, `${dir}/session.jsonl`)).toBe(true);
    expect(isDirectJsonlChild(dir, `${dir}/with\nnewline.jsonl`)).toBe(true);
    expect(isDirectJsonlChild(dir, `${dir}/nested/session.jsonl`)).toBe(false);
    expect(isDirectJsonlChild(dir, `${dir}/../outside.jsonl`)).toBe(false);
    expect(isDirectJsonlChild(dir, "outside.jsonl")).toBe(false);
    expect(isDirectJsonlChild(dir, `${dir}/session.txt`)).toBe(false);
  });

  test("bounds local stat concurrency and returns only the newest fifty jsonl files", async () => {
    const names = Array.from({ length: 100 }, (_, index) => `session-${index}.jsonl`);
    names.push("ignore.txt");
    let inFlight = 0;
    let maxInFlight = 0;
    const entries = await listLocalJsonlByMtime("/tmp/transcripts", names, async (filePath) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await delay(1);
      inFlight -= 1;
      return Number(filePath.match(/(\d+)\.jsonl$/)?.[1] ?? 0);
    });

    expect(maxInFlight).toBeLessThanOrEqual(PREVIOUS_SESSION_STAT_CONCURRENCY);
    expect(entries).toHaveLength(50);
    expect(entries[0]?.path).toEndWith("session-99.jsonl");
    expect(entries.at(-1)?.path).toEndWith("session-50.jsonl");
  });
});

describe("boundedInfoEventMessage", () => {
  test("returns short, empty, and exactly-at-the-bound messages unchanged", () => {
    expect(boundedInfoEventMessage("")).toBe("");
    expect(boundedInfoEventMessage("Claude finished responding")).toBe(
      "Claude finished responding",
    );
    const atBound = "a".repeat(2_000);
    expect(boundedInfoEventMessage(atBound)).toBe(atBound);
    expect(boundedInfoEventMessage(`${atBound}b`)).toBe(atBound);
  });

  test("never emits half of a surrogate pair", () => {
    // 1000 astral code points are exactly 2000 UTF-16 units, so the 1001st is
    // dropped whole rather than split.
    const bounded = boundedInfoEventMessage("😀".repeat(1_001));
    expect(bounded).toHaveLength(2_000);
    expect(Array.from(bounded)).toHaveLength(1_000);
    expect(bounded.charCodeAt(1_999)).toBeGreaterThanOrEqual(0xdc00);

    // An odd astral boundary must round down rather than keep a lone lead unit.
    const odd = boundedInfoEventMessage(`a${"😀".repeat(1_001)}`);
    expect(odd).toHaveLength(1_999);
    expect(odd.endsWith("\ud83d")).toBe(false);
  });

  test("keeps a grapheme cluster's joined code points together up to the bound", () => {
    // A ZWJ sequence is several code points; truncation is per code point, so
    // the cluster may be cut, but never inside one of its code points.
    const family = "👨‍👩‍👧‍👦";
    const bounded = boundedInfoEventMessage(family.repeat(1_000));
    expect(bounded.length).toBeLessThanOrEqual(2_000);
    expect(Array.from(bounded).join("")).toBe(bounded);
    expect(/[\ud800-\udbff]$/.test(bounded)).toBe(false);
  });
});

describe("transcriptContainsSessionId", () => {
  test("matches a top-level camelCase sessionId", () => {
    const content = `${JSON.stringify({ sessionId: "abc-123", type: "assistant" })}\n`;
    expect(transcriptContainsSessionId(content, "abc-123")).toBe(true);
  });

  test("matches a top-level snake_case session_id", () => {
    const content = `${JSON.stringify({ session_id: "abc-123", type: "user" })}\n`;
    expect(transcriptContainsSessionId(content, "abc-123")).toBe(true);
  });

  test("matches a session id nested inside objects and arrays", () => {
    const content = `${JSON.stringify({
      type: "assistant",
      message: { meta: [{ session_id: "deep-999" }] },
    })}\n`;
    expect(transcriptContainsSessionId(content, "deep-999")).toBe(true);
  });

  test("does not match a different session id", () => {
    const content = `${JSON.stringify({ sessionId: "other-session", type: "assistant" })}\n`;
    expect(transcriptContainsSessionId(content, "abc-123")).toBe(false);
  });

  test("scans later lines and skips malformed JSON lines", () => {
    const content = [
      "not json at all",
      "{ still not: valid",
      JSON.stringify({ sessionId: "abc-123", type: "assistant" }),
    ].join("\n");
    expect(transcriptContainsSessionId(content, "abc-123")).toBe(true);
  });

  test("returns false for empty content or empty session id", () => {
    expect(transcriptContainsSessionId("", "abc-123")).toBe(false);
    expect(transcriptContainsSessionId(`${JSON.stringify({ sessionId: "abc-123" })}\n`, "")).toBe(
      false,
    );
  });

  test("parses each line of a non-matching transcript exactly once", () => {
    // The miss is the hot case: discovery re-reads every candidate transcript
    // in the project directory on each 250ms poll tick until one binds. A
    // shallow pre-pass over the whole file can only ever win on a *match*,
    // because the deep walk tests the same top-level keys before it recurses —
    // so running both doubled the JSON.parse cost of every file that does not
    // own the session.
    const content = Array.from({ length: 20 }, (_, index) =>
      JSON.stringify({ sessionId: `other-${index}`, message: { role: "user" } }),
    ).join("\n");

    const realParse = JSON.parse;
    let parses = 0;
    JSON.parse = ((text: string) => {
      parses += 1;
      return realParse(text);
    }) as typeof JSON.parse;
    try {
      expect(transcriptContainsSessionId(content, "wanted-session")).toBe(false);
    } finally {
      JSON.parse = realParse;
    }

    expect(parses).toBe(20);
  });
});

describe("newestJsonlInDir container backend", () => {
  type Backend = Parameters<typeof newestJsonlInDir>[0];

  function makeContainerBackend(
    findStdout: string,
    files: Record<string, string>,
  ): { backend: Backend; readPaths: string[] } {
    const readPaths: string[] = [];
    const backend = {
      kind: "container",
      async exec(_args: string[]) {
        return { stdout: findStdout, stderr: "", exitCode: 0 };
      },
      async readFile(filePath: string) {
        readPaths.push(filePath);
        return files[filePath];
      },
    } as unknown as Backend;
    return { backend, readPaths };
  }

  test("resolves the single container jsonl owned by the session", async () => {
    const findStdout = `${[
      "1700000003 /home/node/.claude/projects/p/other.jsonl",
      "1700000002 /home/node/.claude/projects/p/owned.jsonl",
    ].join("\0")}\0`;
    const { backend } = makeContainerBackend(findStdout, {
      "/home/node/.claude/projects/p/other.jsonl": `${JSON.stringify({ sessionId: "other" })}\n`,
      "/home/node/.claude/projects/p/owned.jsonl": `${JSON.stringify({ sessionId: "mine" })}\n`,
    });
    await expect(
      newestJsonlInDir(backend, "/home/node/.claude/projects/p", 1700000000, "mine"),
    ).resolves.toBe("/home/node/.claude/projects/p/owned.jsonl");
  });

  test("returns undefined when no container jsonl claims the session", async () => {
    const findStdout = "1700000003 /home/node/.claude/projects/p/other.jsonl\0";
    const { backend } = makeContainerBackend(findStdout, {
      "/home/node/.claude/projects/p/other.jsonl": `${JSON.stringify({ sessionId: "other" })}\n`,
    });
    await expect(
      newestJsonlInDir(backend, "/home/node/.claude/projects/p", 1700000000, "mine"),
    ).resolves.toBeUndefined();
  });

  test("returns undefined when multiple container jsonls claim the same session", async () => {
    const findStdout = `${[
      "1700000003 /home/node/.claude/projects/p/a.jsonl",
      "1700000002 /home/node/.claude/projects/p/b.jsonl",
    ].join("\0")}\0`;
    const { backend } = makeContainerBackend(findStdout, {
      "/home/node/.claude/projects/p/a.jsonl": `${JSON.stringify({ sessionId: "mine" })}\n`,
      "/home/node/.claude/projects/p/b.jsonl": `${JSON.stringify({ sessionId: "mine" })}\n`,
    });
    await expect(
      newestJsonlInDir(backend, "/home/node/.claude/projects/p", 1700000000, "mine"),
    ).resolves.toBeUndefined();
  });

  test("never turns a newline filename into an out-of-directory read", async () => {
    const dir = "/home/node/.claude/projects/p";
    const findStdout = `${[
      `1700000005 ${dir}/safe.jsonl\n1700000999 outside.jsonl`,
      `1700000004 ${dir}/nested/owned.jsonl`,
      `1700000003 ${dir}/../outside.jsonl`,
      "1700000002 relative.jsonl",
      `1700000001 ${dir}/owned.txt`,
      `1700000000 ${dir}/owned.jsonl`,
    ].join("\0")}\0`;
    const { backend, readPaths } = makeContainerBackend(findStdout, {
      [`${dir}/owned.jsonl`]: `${JSON.stringify({ sessionId: "mine" })}\n`,
    });

    await expect(newestJsonlInDir(backend, dir, 1700000000, "mine")).resolves.toBe(
      `${dir}/owned.jsonl`,
    );
    expect(readPaths).toEqual([
      `${dir}/safe.jsonl\n1700000999 outside.jsonl`,
      `${dir}/owned.jsonl`,
    ]);
    expect(readPaths).not.toContain("outside.jsonl");
    expect(readPaths.every((readPath) => path.posix.dirname(readPath) === dir)).toBe(true);
  });
});

describe("thinking display capability probe", () => {
  function result(overrides: Partial<ExecOutput>): ExecOutput {
    return { status: 0, stdout: "", stderr: "", ...overrides };
  }

  const invalidDisplayArgument =
    "error: option '--thinking-display <display>' argument '__orkestrator_probe__' is invalid." +
    " Allowed choices are summarized, omitted.";

  test("probes both launch flags at once and stays off the API path", () => {
    expect(thinkingDisplayProbeArgs("/opt/toolchains/claude")).toEqual([
      "/opt/toolchains/claude",
      "--thinking",
      "adaptive",
      "--thinking-display",
      "__orkestrator_probe__",
      "--version",
    ]);
  });

  test("reads an argument-validation failure that names the flag as support", () => {
    expect(
      thinkingDisplayProbeIndicatesSupport(result({ status: 1, stderr: invalidDisplayArgument })),
    ).toBe(true);
    // Some CLIs report usage errors on stdout.
    expect(
      thinkingDisplayProbeIndicatesSupport(result({ status: 1, stdout: invalidDisplayArgument })),
    ).toBe(true);
  });

  test("rejects a CLI that does not know --thinking", () => {
    expect(
      thinkingDisplayProbeIndicatesSupport(
        result({ status: 1, stderr: "error: unknown option '--thinking'" }),
      ),
    ).toBe(false);
  });

  test("rejects a CLI that does not know --thinking-display", () => {
    expect(
      thinkingDisplayProbeIndicatesSupport(
        result({ status: 1, stderr: "error: unknown option '--thinking-display'" }),
      ),
    ).toBe(false);
  });

  test("rejects an unknown-option report whatever its casing", () => {
    expect(
      thinkingDisplayProbeIndicatesSupport(
        result({ status: 2, stderr: "Unknown option: --thinking-display" }),
      ),
    ).toBe(false);
  });

  test("rejects a CLI that ignores the flags and exits 0", () => {
    expect(
      thinkingDisplayProbeIndicatesSupport(
        result({ status: 0, stdout: "2.1.2", stderr: "ignoring --thinking-display" }),
      ),
    ).toBe(false);
  });

  test("rejects a probe that failed without naming the flag", () => {
    expect(thinkingDisplayProbeIndicatesSupport(result({ status: 1, stderr: "boom" }))).toBe(false);
    // A killed probe: execWithOutput reports -1 and appends this to stderr.
    expect(
      thinkingDisplayProbeIndicatesSupport(result({ status: -1, stderr: "Command timed out" })),
    ).toBe(false);
  });

  test("bounds the probe so a hung CLI cannot stall session start", async () => {
    const calls: Array<{ args: string[]; stdin?: string; timeoutMs?: number }> = [];
    const supported = await probeThinkingDisplaySupport(async (args, stdin, timeoutMs) => {
      calls.push({ args, stdin, timeoutMs });
      return result({ status: 1, stderr: invalidDisplayArgument });
    }, "claude");

    expect(supported).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.args).toEqual(thinkingDisplayProbeArgs("claude"));
    expect(calls[0]!.stdin).toBeUndefined();
    expect(calls[0]!.timeoutMs).toBeGreaterThan(0);
    expect(calls[0]!.timeoutMs).toBeLessThanOrEqual(15_000);
  });

  test("survives the container wrapper unchanged", () => {
    // Container environments run the same probe through `docker exec`; a
    // rewritten or re-ordered argv would change what the CLI validates.
    expect(containerExecArgs("container-1", thinkingDisplayProbeArgs("claude"), false)).toEqual([
      "exec",
      "-u",
      "node",
      "-w",
      "/workspace",
      "container-1",
      "claude",
      "--thinking",
      "adaptive",
      "--thinking-display",
      "__orkestrator_probe__",
      "--version",
    ]);
    // `-i` is attached only when the caller actually pipes stdin.
    expect(containerExecArgs("container-1", ["cat"], true).slice(0, 7)).toEqual([
      "exec",
      "-u",
      "node",
      "-w",
      "/workspace",
      "-i",
      "container-1",
    ]);
  });

  test("fails closed when the probe cannot be spawned at all", async () => {
    const missingBinary = Object.assign(new Error("spawn claude ENOENT"), { code: "ENOENT" });
    await expect(
      probeThinkingDisplaySupport(async () => {
        throw missingBinary;
      }, "claude"),
    ).resolves.toBe(false);
  });
});

describe("TranscriptTail incremental reads", () => {
  type Backend = Parameters<TranscriptTail["readNew"]>[0];

  /**
   * A backend whose file can be replaced between reads, recording the offset of
   * every read so "only the appended bytes were fetched" is assertable.
   */
  function fakeBackend(file: { bytes: Buffer }): {
    backend: Backend;
    reads: Array<{ offset: number; length: number }>;
  } {
    const reads: Array<{ offset: number; length: number }> = [];
    const backend = {
      async fileSize() {
        return file.bytes.length;
      },
      async readFileBytesFrom(_filePath: string, offset: number) {
        const slice = Buffer.from(file.bytes.subarray(offset));
        reads.push({ offset, length: slice.length });
        return slice;
      },
      async readFile() {
        throw new Error("the tail must never read the whole transcript");
      },
    } as unknown as Backend;
    return { backend, reads };
  }

  const jsonl = (value: unknown) => `${JSON.stringify(value)}\n`;

  test("fetches only what was appended since the previous read", async () => {
    const first = jsonl({ n: 1 });
    const second = jsonl({ n: 2 });
    const file = { bytes: Buffer.from(first, "utf8") };
    const { backend, reads } = fakeBackend(file);
    const tail = new TranscriptTail("/transcript.jsonl");

    await expect(tail.readNew(backend)).resolves.toEqual([{ n: 1 }]);
    expect(reads).toEqual([{ offset: 0, length: Buffer.byteLength(first) }]);

    file.bytes = Buffer.from(first + second, "utf8");
    await expect(tail.readNew(backend)).resolves.toEqual([{ n: 2 }]);
    expect(reads[1]).toEqual({
      offset: Buffer.byteLength(first),
      length: Buffer.byteLength(second),
    });
  });

  test("does not read at all when the known size says nothing was appended", async () => {
    const line = jsonl({ n: 1 });
    const file = { bytes: Buffer.from(line, "utf8") };
    const { backend, reads } = fakeBackend(file);
    const tail = new TranscriptTail("/transcript.jsonl");

    await tail.readNew(backend, Buffer.byteLength(line));
    expect(reads).toHaveLength(1);
    // The poll loop already stat'd the file in its snapshot; an unchanged size
    // must cost neither a second stat nor a read.
    await expect(tail.readNew(backend, Buffer.byteLength(line))).resolves.toEqual([]);
    expect(reads).toHaveLength(1);
  });

  test("keeps its byte offset when the size read fails transiently", async () => {
    const first = jsonl({ n: 1 });
    const second = jsonl({ n: 2 });
    const file = { bytes: Buffer.from(first, "utf8") };
    const { backend, reads } = fakeBackend(file);
    const tail = new TranscriptTail("/transcript.jsonl");

    await expect(tail.readNew(backend)).resolves.toEqual([{ n: 1 }]);
    const unavailable = {
      ...backend,
      fileSize: async () => {
        throw new Error("combined poll unavailable");
      },
    } as Backend;
    await expect(tail.readNew(unavailable)).rejects.toThrow("combined poll unavailable");

    file.bytes = Buffer.from(first + second, "utf8");
    await expect(tail.readNew(backend)).resolves.toEqual([{ n: 2 }]);
    expect(reads.at(-1)).toEqual({
      offset: Buffer.byteLength(first),
      length: Buffer.byteLength(second),
    });
  });

  test("rejoins a multi-byte character split across two reads", async () => {
    // Reading from an offset means a chunk can end in the middle of a UTF-8
    // sequence. Decoding each chunk on its own would turn the split character
    // into two U+FFFD replacements and the line would no longer parse.
    const full = Buffer.from(jsonl({ text: "£100 — done" }), "utf8");
    const poundStart = full.indexOf(0xc2);
    expect(poundStart).toBeGreaterThan(0);
    const splitAt = poundStart + 1;

    const file = { bytes: Buffer.from(full.subarray(0, splitAt)) };
    const { backend, reads } = fakeBackend(file);
    const tail = new TranscriptTail("/transcript.jsonl");

    // No newline yet, so nothing is emitted and the half character is carried.
    await expect(tail.readNew(backend)).resolves.toEqual([]);

    file.bytes = full;
    await expect(tail.readNew(backend)).resolves.toEqual([{ text: "£100 — done" }]);
    expect(reads[1]!.offset).toBe(splitAt);
  });

  test("carries an unterminated line until its newline arrives", async () => {
    const line = jsonl({ n: 7 });
    const partialAt = line.length - 3;
    const file = { bytes: Buffer.from(line.slice(0, partialAt), "utf8") };
    const { backend } = fakeBackend(file);
    const tail = new TranscriptTail("/transcript.jsonl");

    await expect(tail.readNew(backend)).resolves.toEqual([]);
    file.bytes = Buffer.from(line, "utf8");
    await expect(tail.readNew(backend)).resolves.toEqual([{ n: 7 }]);
  });

  test("restarts from byte zero and discards stale partial data after truncation or rotation", async () => {
    const original = `${jsonl({ old: 1 })}${JSON.stringify({ stale: true }).slice(0, 8)}`;
    const file = { bytes: Buffer.from(original, "utf8") };
    const { backend, reads } = fakeBackend(file);
    const tail = new TranscriptTail("/transcript.jsonl");

    await expect(tail.readNew(backend)).resolves.toEqual([{ old: 1 }]);

    const replacement = jsonl({ fresh: 2 });
    expect(Buffer.byteLength(replacement)).toBeLessThan(Buffer.byteLength(original));
    file.bytes = Buffer.from(replacement, "utf8");
    await expect(tail.readNew(backend)).resolves.toEqual([{ fresh: 2 }]);
    expect(reads.at(-1)).toEqual({ offset: 0, length: Buffer.byteLength(replacement) });
  });

  test("skips malformed lines without losing the ones around them", async () => {
    const content = `${JSON.stringify({ n: 1 })}\nnot json\n${JSON.stringify({ n: 2 })}\n`;
    const file = { bytes: Buffer.from(content, "utf8") };
    const { backend } = fakeBackend(file);

    await expect(new TranscriptTail("/transcript.jsonl").readNew(backend)).resolves.toEqual([
      { n: 1 },
      { n: 2 },
    ]);
  });

  test("reads from the byte after the offset in container mode", () => {
    // `tail -c +N` is 1-based: +1 is the whole file, so the first unread byte
    // of a 40-byte prefix is +41. An off-by-one here duplicates or drops a byte
    // of every append.
    expect(tailFromOffsetCommand("/home/node/.claude/t.jsonl", 0)).toContain(
      "tail -c +1 '/home/node/.claude/t.jsonl'",
    );
    expect(tailFromOffsetCommand("/home/node/.claude/t.jsonl", 40)).toContain(
      "tail -c +41 '/home/node/.claude/t.jsonl'",
    );
  });
});

describe("previous-session metadata reads", () => {
  test("asks for the line count and only the head of a transcript", () => {
    const command = transcriptHeadCommand("/home/node/.claude/projects/p/a.jsonl", 65536);
    expect(command).toContain("wc -l < '/home/node/.claude/projects/p/a.jsonl'");
    expect(command).toContain("head -c 65536 '/home/node/.claude/projects/p/a.jsonl'");
    expect(command).not.toContain("cat ");
  });

  test("parses the count and head back out of the combined output", () => {
    expect(parseTranscriptHeadOutput('  12 \n__ork_head__\n{"a":1}\n{"b":2}\n')).toEqual({
      lineCount: 12,
      head: '{"a":1}\n{"b":2}\n',
    });
  });

  test("degrades to empty rather than guessing when the marker is missing", () => {
    expect(parseTranscriptHeadOutput("")).toEqual({ lineCount: 0, head: "" });
  });

  test("lists jsonl files newest-first without reading any of them", () => {
    const command = jsonlByMtimeFindCommand("/home/node/.claude/projects/p");
    expect(command).toContain("-name '*.jsonl'");
    expect(command).toContain("-printf '%T@ %p\\0'");
    expect(command).toContain("sort -z -rn");
  });
});

describe("live session read paths", () => {
  test("sending prompt keys forces an immediate authoritative observation", async () => {
    const handlers = createHandlers();

    await withFakeTmuxRuntime(async ({ environment, alive }) => {
      const observations: Array<{ revision: number; prompt: unknown }> = [];
      const context = {
        storage: { getEnvironment: async () => environment },
        emit: (event: string, payload: unknown) => {
          const candidate = payload as {
            kind?: string;
            observation?: { revision: number; prompt: unknown };
          };
          if (event === "claude-tmux:event" && candidate.kind === "observation") {
            observations.push(candidate.observation!);
          }
        },
        appRoot: "",
        resourceRoot: "",
      };
      const tabId = "tab-prompt-refresh";
      await invoke(
        handlers,
        "claude_tmux_start",
        { tabId, environmentId: environment.id },
        context,
      );
      const session = tmuxSessionName(environment.id, tabId);
      await fs.writeFile(path.join(alive, `${session}.mode`), "selection");
      await waitFor(() => observations.some((entry) => entry.prompt !== null), 5_000);
      const before = observations.length;

      await invoke(
        handlers,
        "claude_tmux_send_keys",
        { tabId, environmentId: environment.id, keys: ["Down"] },
        context,
      );

      // The ordinary idle cadence is three seconds. A fresh frame inside one
      // second proves input reset the cadence and forced an authoritative
      // emission even though the fake pane deliberately stayed unchanged.
      await waitFor(() => observations.length > before, 1_000);
      expect(observations.at(-1)?.prompt).not.toBeNull();
      expect(observations.at(-1)?.revision).toBeGreaterThan(observations[before - 1]!.revision);

      await invoke(handlers, "claude_tmux_stop", { tabId, environmentId: environment.id }, context);
    });
  }, 15_000);

  test("answers only the exact selection prompt observed by the renderer", async () => {
    const handlers = createHandlers();

    await withFakeTmuxRuntime(async ({ environment, alive, log }) => {
      const observations: Array<{
        generation?: string;
        revision: number;
        prompt: TmuxSelectionPrompt | null;
      }> = [];
      const context = {
        storage: { getEnvironment: async () => environment },
        emit: (event: string, payload: unknown) => {
          const candidate = payload as {
            kind?: string;
            observation?: (typeof observations)[number];
          };
          if (event === "claude-tmux:event" && candidate.kind === "observation") {
            observations.push(candidate.observation!);
          }
        },
        appRoot: "",
        resourceRoot: "",
      };
      const tabId = "tab-bound-prompt";
      const session = tmuxSessionName(environment.id, tabId);
      await invoke(
        handlers,
        "claude_tmux_start",
        { tabId, environmentId: environment.id },
        context,
      );
      await fs.writeFile(path.join(alive, `${session}.mode`), "selection");
      await waitFor(() => observations.some((entry) => entry.prompt !== null), 5_000);
      const observed = observations.findLast((entry) => entry.prompt !== null)!;
      const input = {
        expectedGeneration: observed.generation!,
        expectedRevision: observed.revision,
        expectedPromptFingerprint: tmuxSelectionPromptFingerprint(observed.prompt!),
        optionIndex: 1,
      };
      const logBefore = await fs.readFile(log, "utf8");

      await expect(
        invoke(
          handlers,
          "claude_tmux_answer_selection_prompt",
          {
            tabId,
            environmentId: environment.id,
            ...input,
            expectedRevision: input.expectedRevision - 1,
          },
          context,
        ),
      ).rejects.toThrow("no longer current");
      await expect(
        invoke(
          handlers,
          "claude_tmux_answer_selection_prompt",
          {
            tabId,
            environmentId: environment.id,
            ...input,
            expectedPromptFingerprint: `${input.expectedPromptFingerprint}-spoofed`,
          },
          context,
        ),
      ).rejects.toThrow("no longer current");

      await fs.writeFile(path.join(alive, `${session}.mode`), "bypassPermissions");
      await expect(
        invoke(
          handlers,
          "claude_tmux_answer_selection_prompt",
          {
            tabId,
            environmentId: environment.id,
            ...input,
          },
          context,
        ),
      ).rejects.toThrow("no longer current");
      expect((await fs.readFile(log, "utf8")).match(/send-keys/g)?.length ?? 0).toBe(
        logBefore.match(/send-keys/g)?.length ?? 0,
      );

      await fs.writeFile(path.join(alive, `${session}.mode`), "selection");
      await waitFor(
        () =>
          observations.some((entry) => entry.prompt !== null && entry.revision > observed.revision),
        5_000,
      );
      const current = observations.findLast((entry) => entry.prompt !== null)!;
      await invoke(
        handlers,
        "claude_tmux_answer_selection_prompt",
        {
          tabId,
          environmentId: environment.id,
          expectedGeneration: current.generation,
          expectedRevision: current.revision,
          expectedPromptFingerprint: tmuxSelectionPromptFingerprint(current.prompt!),
          optionIndex: 1,
        },
        context,
      );
      expect(await fs.readFile(log, "utf8")).toContain(`send-keys -t ${session} -- 2`);

      await invoke(handlers, "claude_tmux_stop", { tabId, environmentId: environment.id }, context);
    });
  }, 20_000);

  test("a failed poll snapshot skips the tick without ending the loop", async () => {
    const handlers = createHandlers();

    await withFakeTmuxRuntime(async ({ environment, runtimeRoot }) => {
      const emitted: Array<{ event: string; payload: unknown }> = [];
      const context = {
        storage: { getEnvironment: async () => environment },
        emit: (event: string, payload: unknown) => emitted.push({ event, payload }),
        appRoot: "",
        resourceRoot: "",
      };
      const tabId = "tab-poll-failure";
      const status = (await invoke(
        handlers,
        "claude_tmux_start",
        { tabId, environmentId: environment.id },
        context,
      )) as { session_id: string };
      const pendingDir = path.join(runtimeRoot, "sessions", status.session_id, "pending");
      await fs.mkdir(pendingDir, { recursive: true });

      // An unreadable hook directory is what a transient snapshot failure looks
      // like from the loop's side. A throw that escapes the tick ends the poll
      // for the whole session, and the tab silently stops receiving hooks and
      // transcript lines with nothing reporting an error.
      await fs.chmod(pendingDir, 0o000);
      try {
        await delay(750);
      } finally {
        await fs.chmod(pendingDir, 0o755);
      }

      await fs.writeFile(
        path.join(pendingDir, "Stop-after-failure.json"),
        JSON.stringify({ ok: true }),
      );
      await waitFor(
        () =>
          emitted.some(
            (item) =>
              item.event === "claude-tmux:event" &&
              (item.payload as { kind?: string }).kind === "hook" &&
              (item.payload as { event_id?: string }).event_id === "after-failure",
          ),
        5_000,
      );

      await invoke(handlers, "claude_tmux_stop", { tabId, environmentId: environment.id }, context);
    });
  }, 20_000);

  test("bounds informational hook snapshots and rehydrates Unicode-safe messages", async () => {
    const handlers = createHandlers();

    await withFakeTmuxRuntime(async ({ environment, runtimeRoot }) => {
      const emitted: Array<{ event: string; payload: unknown }> = [];
      const context = {
        storage: { getEnvironment: async () => environment },
        emit: (event: string, payload: unknown) => emitted.push({ event, payload }),
        appRoot: "",
        resourceRoot: "",
      };
      const tabId = "tab-info-events";
      const status = (await invoke(
        handlers,
        "claude_tmux_start",
        { tabId, environmentId: environment.id },
        context,
      )) as { session_id: string };
      const pendingDir = path.join(runtimeRoot, "sessions", status.session_id, "pending");
      // Much larger than the retained bound: truncation must not make a
      // code-point array proportional to this untrusted hook payload.
      const longMessage = `${"😀".repeat(250_000)}tail`;
      await Promise.all(
        Array.from({ length: 22 }, async (_, index) => {
          const id = `info-${String(index).padStart(2, "0")}`;
          await fs.writeFile(
            path.join(pendingDir, `Notification-${id}.json`),
            JSON.stringify({ message: index === 21 ? longMessage : `message-${index}` }),
          );
        }),
      );
      await waitFor(
        () =>
          emitted.some(
            (entry) =>
              entry.event === "claude-tmux:event" &&
              (entry.payload as { event_id?: string }).event_id === "info-21",
          ),
        5_000,
      );

      const bounded = (await invoke(
        handlers,
        "claude_tmux_status",
        {
          tabId,
          environmentId: environment.id,
        },
        context,
      )) as {
        info_events: Array<{ id: string; kind: string; message: string; receivedAt: string }>;
      };
      expect(bounded.info_events).toHaveLength(20);
      expect(bounded.info_events.map(({ id }) => id)).toEqual(
        Array.from({ length: 20 }, (_, index) => `info-${String(index + 2).padStart(2, "0")}`),
      );
      // The bound is 2000 UTF-16 units, so an all-astral message retains half as
      // many code points. Bounding code points instead would let a hostile hook
      // retain 8KB per event where the original .slice(0, 2000) retained 4KB.
      expect(bounded.info_events.at(-1)!.message).toHaveLength(2_000);
      expect(Array.from(bounded.info_events.at(-1)!.message)).toHaveLength(1_000);
      expect(bounded.info_events.at(-1)!.message.endsWith("\ud83d")).toBe(false);
      expect(
        bounded.info_events.every(({ receivedAt }) => Number.isFinite(Date.parse(receivedAt))),
      ).toBe(true);

      await fs.writeFile(
        path.join(pendingDir, "Notification-info-21.json"),
        JSON.stringify({ message: "updated duplicate" }),
      );
      await waitFor(async () => {
        const snapshot = (await invoke(
          handlers,
          "claude_tmux_status",
          {
            tabId,
            environmentId: environment.id,
          },
          context,
        )) as { info_events: Array<{ id: string; message: string }> };
        return snapshot.info_events.at(-1)?.message === "updated duplicate";
      }, 5_000);
      const deduplicated = (await invoke(
        handlers,
        "claude_tmux_status",
        {
          tabId,
          environmentId: environment.id,
        },
        context,
      )) as { info_events: Array<{ id: string; message: string }> };
      expect(deduplicated.info_events.filter(({ id }) => id === "info-21")).toEqual([
        expect.objectContaining({
          id: "info-21",
          message: "updated duplicate",
        }),
      ]);
      expect(deduplicated.info_events).toHaveLength(20);

      await fs.writeFile(path.join(pendingDir, "Notification-default-message.json"), "{}");
      await waitFor(
        () =>
          emitted.some(
            (entry) =>
              entry.event === "claude-tmux:event" &&
              (entry.payload as { event_id?: string }).event_id === "default-message",
          ),
        5_000,
      );
      const rehydrated = (await invoke(
        handlers,
        "claude_tmux_status",
        {
          tabId,
          environmentId: environment.id,
        },
        context,
      )) as { info_events: Array<{ id: string; message: string }> };
      expect(rehydrated.info_events).toHaveLength(20);
      expect(rehydrated.info_events.at(-1)).toEqual(
        expect.objectContaining({
          id: "default-message",
          message: "Claude sent a notification",
        }),
      );

      await invoke(handlers, "claude_tmux_stop", { tabId, environmentId: environment.id }, context);
    });
  }, 20_000);

  test("keeps same-id hooks of different kinds and re-admits an evicted id", async () => {
    const handlers = createHandlers();

    await withFakeTmuxRuntime(async ({ environment, runtimeRoot }) => {
      const emitted: Array<{ event: string; payload: unknown }> = [];
      const context = {
        storage: { getEnvironment: async () => environment },
        emit: (event: string, payload: unknown) => emitted.push({ event, payload }),
        appRoot: "",
        resourceRoot: "",
      };
      const tabId = "tab-info-dedup";
      const status = (await invoke(
        handlers,
        "claude_tmux_start",
        { tabId, environmentId: environment.id },
        context,
      )) as { session_id: string };
      const pendingDir = path.join(runtimeRoot, "sessions", status.session_id, "pending");
      const snapshot = async () =>
        (await invoke(
          handlers,
          "claude_tmux_status",
          {
            tabId,
            environmentId: environment.id,
          },
          context,
        )) as { info_events: Array<{ id: string; kind: string; message: string }> };
      const deliver = async (kind: string, id: string, body: string) => {
        const seen = emitted.length;
        await fs.writeFile(path.join(pendingDir, `${kind}-${id}.json`), body);
        await waitFor(
          () =>
            emitted
              .slice(seen)
              .some(
                (entry) =>
                  entry.event === "claude-tmux:event" &&
                  (entry.payload as { event_id?: string }).event_id === id &&
                  (entry.payload as { event_kind?: string }).event_kind === kind,
              ),
          5_000,
        );
      };

      // Deduplication keys on id *and* kind. A Notification and a Stop that
      // share an id are two different things the user needs to see.
      await deliver("Notification", "shared", JSON.stringify({ message: "note" }));
      await deliver("Stop", "shared", "{}");
      expect((await snapshot()).info_events).toEqual([
        expect.objectContaining({ id: "shared", kind: "Notification", message: "note" }),
        // Stop carries no message of its own in a real hook payload.
        expect.objectContaining({
          id: "shared",
          kind: "Stop",
          message: "Claude finished responding",
        }),
      ]);

      // Fill past the 20-entry cap so the first entry is evicted, then deliver
      // it again: there is nothing left to replace, so it is admitted afresh.
      for (let index = 0; index < 20; index += 1) {
        await deliver(
          "Notification",
          `filler-${String(index).padStart(2, "0")}`,
          JSON.stringify({ message: `filler-${index}` }),
        );
      }
      const filled = await snapshot();
      expect(filled.info_events).toHaveLength(20);
      expect(filled.info_events.some(({ id }) => id === "shared")).toBe(false);

      await deliver("Notification", "shared", JSON.stringify({ message: "re-delivered" }));
      const readmitted = await snapshot();
      expect(readmitted.info_events).toHaveLength(20);
      expect(readmitted.info_events.filter(({ id }) => id === "shared")).toEqual([
        expect.objectContaining({ kind: "Notification", message: "re-delivered" }),
      ]);

      await invoke(handlers, "claude_tmux_stop", { tabId, environmentId: environment.id }, context);
    });
  }, 30_000);

  test("bounds both the hook file read and the message it broadcasts", async () => {
    const handlers = createHandlers();

    await withFakeTmuxRuntime(async ({ environment, runtimeRoot }) => {
      const emitted: Array<{ event: string; payload: unknown }> = [];
      const context = {
        storage: { getEnvironment: async () => environment },
        emit: (event: string, payload: unknown) => emitted.push({ event, payload }),
        appRoot: "",
        resourceRoot: "",
      };
      const tabId = "tab-info-bounds";
      const status = (await invoke(
        handlers,
        "claude_tmux_start",
        { tabId, environmentId: environment.id },
        context,
      )) as { session_id: string };
      const pendingDir = path.join(runtimeRoot, "sessions", status.session_id, "pending");
      const payloadFor = (eventId: string) =>
        emitted.find(
          (entry) =>
            entry.event === "claude-tmux:event" &&
            (entry.payload as { event_id?: string }).event_id === eventId,
        )?.payload as { payload?: unknown } | undefined;

      // Retaining a trimmed copy while broadcasting the original would move the
      // cost to every SSE subscriber rather than remove it.
      await fs.writeFile(
        path.join(pendingDir, "Notification-broadcast.json"),
        JSON.stringify({ message: "x".repeat(100_000), session_id: "s" }),
      );
      await waitFor(() => payloadFor("broadcast") !== undefined, 5_000);
      expect(payloadFor("broadcast")?.payload).toEqual({
        message: "x".repeat(2_000),
        session_id: "s",
      });

      // An oversized hook file is read up to the cap and no further.
      await fs.writeFile(
        path.join(pendingDir, "Notification-oversized.json"),
        "y".repeat(TMUX_HOOK_PAYLOAD_MAX_BYTES + 1_024),
      );
      await waitFor(() => payloadFor("oversized") !== undefined, 10_000);
      const oversized = payloadFor("oversized")?.payload;
      expect(typeof oversized).toBe("string");
      expect((oversized as string).length).toBe(TMUX_HOOK_PAYLOAD_MAX_BYTES);

      await invoke(handlers, "claude_tmux_stop", { tabId, environmentId: environment.id }, context);
    });
  }, 30_000);

  test("denies an oversized blocking hook without broadcasting truncated approval data", async () => {
    const handlers = createHandlers();
    await withFakeTmuxRuntime(async ({ environment, runtimeRoot }) => {
      const emitted: Array<{ event: string; payload: unknown }> = [];
      const context = {
        storage: { getEnvironment: async () => environment },
        emit: (event: string, payload: unknown) => emitted.push({ event, payload }),
        appRoot: "",
        resourceRoot: "",
      };
      const tabId = "tab-oversized-blocking";
      const status = (await invoke(
        handlers,
        "claude_tmux_start",
        { tabId, environmentId: environment.id },
        context,
      )) as { session_id: string };
      const sessionRoot = path.join(runtimeRoot, "sessions", status.session_id);
      const pending = path.join(sessionRoot, "pending", "PreToolUse-too-large.json");
      const response = path.join(sessionRoot, "response", "PreToolUse-too-large.json");
      await fs.writeFile(pending, "x".repeat(TMUX_HOOK_PAYLOAD_MAX_BYTES + 1));

      await waitFor(() => existsSync(response), 10_000);
      await expect(fs.readFile(response, "utf8")).resolves.toBe(
        JSON.stringify({
          hookSpecificOutput: {
            hookEventName: "PreToolUse",
            permissionDecision: "deny",
            permissionDecisionReason: "Approval payload exceeded the safe size limit.",
          },
        }),
      );
      expect(existsSync(pending)).toBe(false);
      expect(
        emitted.some(
          (entry) =>
            entry.event === "claude-tmux:event" &&
            (entry.payload as { event_id?: string }).event_id === "too-large",
        ),
      ).toBe(false);

      await invoke(handlers, "claude_tmux_stop", { tabId, environmentId: environment.id }, context);
    });
  }, 30_000);

  test("notifies once for each armed UserPromptSubmit-to-Stop turn", async () => {
    const handlers = createHandlers();

    await withFakeTmuxRuntime(async ({ environment, runtimeRoot }) => {
      environment.prRecheckAfterAgentCompletionArmedAt = "2026-08-01T12:00:00.000Z";
      const notifyAgentTurnCompleted = mock(async () => undefined);
      const emitted: Array<{ event: string; payload: unknown }> = [];
      const context = {
        storage: { getEnvironment: async () => environment },
        notifyAgentTurnCompleted,
        emit: (event: string, payload: unknown) => emitted.push({ event, payload }),
        appRoot: "",
        resourceRoot: "",
      };
      const args = { tabId: "tab-completion", environmentId: environment.id };
      const status = (await invoke(handlers, "claude_tmux_start", args, context)) as {
        session_id: string;
      };
      const pendingDir = path.join(runtimeRoot, "sessions", status.session_id, "pending");
      const writeHook = async (kind: "UserPromptSubmit" | "Stop", id: string) => {
        await fs.writeFile(path.join(pendingDir, `${kind}-${id}.json`), "{}");
        await waitFor(() =>
          emitted.some(
            (entry) =>
              entry.event === "claude-tmux:event" &&
              (entry.payload as { event_id?: string }).event_id === id,
          ),
        );
      };

      await writeHook("UserPromptSubmit", "turn-1-start");
      await writeHook("Stop", "turn-1-stop");
      await waitFor(() => notifyAgentTurnCompleted.mock.calls.length === 1);
      await writeHook("Stop", "turn-1-duplicate-stop");
      await delay(25);
      expect(notifyAgentTurnCompleted).toHaveBeenCalledTimes(1);

      await writeHook("UserPromptSubmit", "turn-2-start");
      await writeHook("Stop", "turn-2-stop");
      await waitFor(() => notifyAgentTurnCompleted.mock.calls.length === 2);
      expect(notifyAgentTurnCompleted.mock.calls).toEqual([[environment.id], [environment.id]]);

      await invoke(handlers, "claude_tmux_stop", args, context);
    });
  }, 20_000);

  test("uses the durable arm to recover a Stop after backend reattach", async () => {
    const handlers = createHandlers();

    await withFakeTmuxRuntime(async ({ environment, runtimeRoot }) => {
      environment.prRecheckAfterAgentCompletionArmedAt = "2026-08-01T12:00:00.000Z";
      const notifyAgentTurnCompleted = mock(async () => undefined);
      const emitted: Array<{ event: string; payload: unknown }> = [];
      const context = {
        storage: { getEnvironment: async () => environment },
        notifyAgentTurnCompleted,
        emit: (event: string, payload: unknown) => emitted.push({ event, payload }),
        appRoot: "",
        resourceRoot: "",
      };
      const args = { tabId: "tab-reattached", environmentId: environment.id };
      const status = (await invoke(handlers, "claude_tmux_start", args, context)) as {
        session_id: string;
      };
      const pendingDir = path.join(runtimeRoot, "sessions", status.session_id, "pending");

      // No UserPromptSubmit reaches this TmuxSession instance. This is the
      // observable state after the backend restarts while Claude is working.
      await fs.writeFile(path.join(pendingDir, "Stop-after-reattach.json"), "{}");
      await waitFor(() => notifyAgentTurnCompleted.mock.calls.length === 1);
      expect(notifyAgentTurnCompleted).toHaveBeenCalledWith(environment.id);

      await invoke(handlers, "claude_tmux_stop", args, context);
    });
  }, 20_000);

  test("does not drop a back-to-back turn while the prior notification is pending", async () => {
    const handlers = createHandlers();

    await withFakeTmuxRuntime(async ({ environment, runtimeRoot }) => {
      environment.prRecheckAfterAgentCompletionArmedAt = "2026-08-01T12:00:00.000Z";
      const gate = deferred<void>();
      const notifyAgentTurnCompleted = mock(() => gate.promise);
      const emitted: Array<{ event: string; payload: unknown }> = [];
      const context = {
        storage: { getEnvironment: async () => environment },
        notifyAgentTurnCompleted,
        emit: (event: string, payload: unknown) => emitted.push({ event, payload }),
        appRoot: "",
        resourceRoot: "",
      };
      const args = { tabId: "tab-overlap", environmentId: environment.id };
      const status = (await invoke(handlers, "claude_tmux_start", args, context)) as {
        session_id: string;
      };
      const pendingDir = path.join(runtimeRoot, "sessions", status.session_id, "pending");
      const writeAndObserve = async (kind: "UserPromptSubmit" | "Stop", id: string) => {
        await fs.writeFile(path.join(pendingDir, `${kind}-${id}.json`), "{}");
        await waitFor(() =>
          emitted.some((entry) => (entry.payload as { event_id?: string }).event_id === id),
        );
      };

      await writeAndObserve("UserPromptSubmit", "overlap-start-1");
      await writeAndObserve("Stop", "overlap-stop-1");
      await waitFor(() => notifyAgentTurnCompleted.mock.calls.length === 1);
      await writeAndObserve("UserPromptSubmit", "overlap-start-2");
      await writeAndObserve("Stop", "overlap-stop-2");
      await waitFor(() => notifyAgentTurnCompleted.mock.calls.length === 2);

      gate.resolve();
      await invoke(handlers, "claude_tmux_stop", args, context);
    });
  }, 20_000);

  test("does not reopen a newer turn when an older completion notification rejects", async () => {
    const handlers = createHandlers();

    await withFakeTmuxRuntime(async ({ environment, runtimeRoot }) => {
      environment.prRecheckAfterAgentCompletionArmedAt = "2026-08-01T12:00:00.000Z";
      let rejectFirst!: (error: Error) => void;
      const first = new Promise<void>((_resolve, reject) => {
        rejectFirst = reject;
      });
      let resolveSecond!: () => void;
      const second = new Promise<void>((resolve) => {
        resolveSecond = resolve;
      });
      const notifyAgentTurnCompleted = mock(() =>
        notifyAgentTurnCompleted.mock.calls.length === 1 ? first : second,
      );
      const emitted: Array<{ event: string; payload: unknown }> = [];
      const context = {
        storage: { getEnvironment: async () => environment },
        notifyAgentTurnCompleted,
        emit: (event: string, payload: unknown) => emitted.push({ event, payload }),
        appRoot: "",
        resourceRoot: "",
      };
      const args = { tabId: "tab-generation-rejection", environmentId: environment.id };
      const status = (await invoke(handlers, "claude_tmux_start", args, context)) as {
        session_id: string;
      };
      const pendingDir = path.join(runtimeRoot, "sessions", status.session_id, "pending");
      const writeAndObserve = async (kind: "UserPromptSubmit" | "Stop", id: string) => {
        await fs.writeFile(path.join(pendingDir, `${kind}-${id}.json`), "{}");
        await waitFor(() =>
          emitted.some((entry) => (entry.payload as { event_id?: string }).event_id === id),
        );
      };

      await writeAndObserve("UserPromptSubmit", "generation-1-start");
      await writeAndObserve("Stop", "generation-1-stop");
      await waitFor(() => notifyAgentTurnCompleted.mock.calls.length === 1);
      await writeAndObserve("UserPromptSubmit", "generation-2-start");
      await writeAndObserve("Stop", "generation-2-stop");
      await waitFor(() => notifyAgentTurnCompleted.mock.calls.length === 2);
      rejectFirst(new Error("late failure from generation one"));
      await delay(25);
      await writeAndObserve("Stop", "generation-2-duplicate");
      await delay(25);

      expect(notifyAgentTurnCompleted).toHaveBeenCalledTimes(2);
      resolveSecond();
      await invoke(handlers, "claude_tmux_stop", args, context);
    });
  }, 20_000);

  test("retries a failed durable-arm read and treats a missing environment as terminal", async () => {
    const handlers = createHandlers();

    await withFakeTmuxRuntime(async ({ environment, runtimeRoot }) => {
      environment.prRecheckAfterAgentCompletionArmedAt = "2026-08-01T12:00:00.000Z";
      let observeCompletionReads = false;
      let completionReads = 0;
      const getEnvironment = mock(async () => {
        if (!observeCompletionReads) return environment;
        completionReads += 1;
        if (completionReads === 1) throw new Error("storage unavailable");
        if (completionReads === 2) return undefined;
        return environment;
      });
      const notifyAgentTurnCompleted = mock(async () => undefined);
      const emitted: Array<{ event: string; payload: unknown }> = [];
      const context = {
        storage: { getEnvironment },
        notifyAgentTurnCompleted,
        emit: (event: string, payload: unknown) => emitted.push({ event, payload }),
        appRoot: "",
        resourceRoot: "",
      };
      const args = { tabId: "tab-arm-read-retry", environmentId: environment.id };
      const status = (await invoke(handlers, "claude_tmux_start", args, context)) as {
        session_id: string;
      };
      observeCompletionReads = true;
      const pendingDir = path.join(runtimeRoot, "sessions", status.session_id, "pending");
      for (const id of ["failed-read", "missing-read", "successful-read"]) {
        await fs.writeFile(path.join(pendingDir, `Stop-${id}.json`), "{}");
        await waitFor(() =>
          emitted.some((entry) => (entry.payload as { event_id?: string }).event_id === id),
        );
        await delay(25);
      }

      expect(completionReads).toBe(2);
      expect(notifyAgentTurnCompleted).not.toHaveBeenCalled();
      await invoke(handlers, "claude_tmux_stop", args, context);
    });
  }, 20_000);

  test("ignores an unarmed Stop and retries a rejected armed notification", async () => {
    const handlers = createHandlers();

    await withFakeTmuxRuntime(async ({ environment, runtimeRoot }) => {
      const notifyAgentTurnCompleted = mock(async () => undefined);
      const emitted: Array<{ event: string; payload: unknown }> = [];
      const context = {
        storage: { getEnvironment: async () => environment },
        notifyAgentTurnCompleted,
        emit: (event: string, payload: unknown) => emitted.push({ event, payload }),
        appRoot: "",
        resourceRoot: "",
      };
      const unarmedArgs = { tabId: "tab-unarmed", environmentId: environment.id };
      const unarmed = (await invoke(handlers, "claude_tmux_start", unarmedArgs, context)) as {
        session_id: string;
      };
      const unarmedPending = path.join(runtimeRoot, "sessions", unarmed.session_id, "pending");
      await fs.writeFile(path.join(unarmedPending, "Stop-unarmed.json"), "{}");
      await waitFor(() =>
        emitted.some((entry) => (entry.payload as { event_id?: string }).event_id === "unarmed"),
      );
      await delay(25);
      expect(notifyAgentTurnCompleted).not.toHaveBeenCalled();
      await invoke(handlers, "claude_tmux_stop", unarmedArgs, context);

      environment.prRecheckAfterAgentCompletionArmedAt = "2026-08-01T12:00:00.000Z";
      let attempts = 0;
      notifyAgentTurnCompleted.mockImplementation(async () => {
        attempts += 1;
        if (attempts === 1) throw new Error("temporary reconciliation failure");
      });
      const retryArgs = { tabId: "tab-retry", environmentId: environment.id };
      const retry = (await invoke(handlers, "claude_tmux_start", retryArgs, context)) as {
        session_id: string;
      };
      const retryPending = path.join(runtimeRoot, "sessions", retry.session_id, "pending");
      await fs.writeFile(path.join(retryPending, "Stop-rejected.json"), "{}");
      await waitFor(() => notifyAgentTurnCompleted.mock.calls.length === 1);
      await delay(25);
      await fs.writeFile(path.join(retryPending, "Stop-retry.json"), "{}");
      await waitFor(() => notifyAgentTurnCompleted.mock.calls.length === 2);
      expect(attempts).toBe(2);

      await invoke(handlers, "claude_tmux_stop", retryArgs, context);
    });
  }, 20_000);

  test("spawns far fewer liveness checks than poll ticks for a live session", async () => {
    const handlers = createHandlers();

    await withFakeTmuxRuntime(async ({ environment, log }) => {
      const context = {
        storage: { getEnvironment: async () => environment },
        emit: () => undefined,
        appRoot: "",
        resourceRoot: "",
      };
      const tabId = "tab-liveness-cadence";
      await invoke(
        handlers,
        "claude_tmux_start",
        { tabId, environmentId: environment.id },
        context,
      );
      const session = tmuxSessionName(environment.id, tabId);

      const livenessChecks = async () =>
        (await fs.readFile(log, "utf8"))
          .split("\n")
          .filter((line) => line.startsWith(`has-session -t ${session}`)).length;
      const before = await livenessChecks();

      // The loop ticks every POLL_INTERVAL_MS (250ms), so this window covers
      // roughly a dozen ticks. Each liveness check is its own process spawn — a
      // `docker exec` in container mode — and can only report a session that
      // has already ended, which is why it must not run per tick.
      await delay(3_000);
      const spawned = (await livenessChecks()) - before;

      expect(spawned).toBeGreaterThanOrEqual(1);
      expect(spawned).toBeLessThanOrEqual(3);

      await invoke(handlers, "claude_tmux_stop", { tabId, environmentId: environment.id }, context);
    });
  }, 20_000);

  test("still reports a tmux session that ended, on the slower liveness cadence", async () => {
    const handlers = createHandlers();

    await withFakeTmuxRuntime(async ({ environment, alive, runtimeRoot }) => {
      const emitted: Array<{ event: string; payload: unknown }> = [];
      const persistedStates: string[] = [];
      const context = {
        storage: {
          getEnvironment: async () => environment,
          setEnvironmentAgentActivity: async (
            _environmentId: string,
            state: "idle" | "working" | "waiting",
            occurredAt: string,
          ) => {
            persistedStates.push(state);
            environment.agentActivitySources = {
              ...environment.agentActivitySources,
              "claude-tmux": { state, updatedAt: occurredAt },
            };
            return environment;
          },
        },
        emit: (event: string, payload: unknown) => emitted.push({ event, payload }),
        appRoot: "",
        resourceRoot: "",
      };
      const tabId = "tab-liveness";
      const status = (await invoke(
        handlers,
        "claude_tmux_start",
        { tabId, environmentId: environment.id },
        context,
      )) as { session_id: string };

      // Make the dead session busy first. The liveness path must not leave
      // that process-local state contributing "working" forever.
      const pendingDir = path.join(runtimeRoot, "sessions", status.session_id, "pending");
      await fs.writeFile(path.join(pendingDir, "UserPromptSubmit-before-death.json"), "{}");
      await waitFor(() => persistedStates.includes("working"));

      // Claude exits and tmux tears the session down; nothing else tells the
      // poll loop, so the periodic has-session check is the only signal.
      await fs.rm(path.join(alive, tmuxSessionName(environment.id, tabId)), { force: true });

      await waitFor(
        () =>
          emitted.some(
            (item) =>
              item.event === "claude-tmux:event" &&
              (item.payload as { kind?: string }).kind === "stopped",
          ),
        8_000,
      );

      await waitFor(() => persistedStates.at(-1) === "idle");
      await expect(
        invoke(handlers, "claude_tmux_status", { tabId, environmentId: environment.id }, context),
      ).resolves.toBeNull();

      await invoke(handlers, "claude_tmux_stop", { tabId, environmentId: environment.id }, context);
    });
  }, 15_000);

  test("lists previous sessions without reading whole transcripts", async () => {
    const handlers = createHandlers();

    await withFakeTmuxRuntime(async ({ worktree, home, environment }) => {
      const context = {
        storage: { getEnvironment: async () => environment },
        emit: () => undefined,
        appRoot: "",
        resourceRoot: "",
      };
      const transcriptDir = path.join(home, ".claude", "projects", encodeCwd(worktree));
      await fs.mkdir(transcriptDir, { recursive: true });
      const jsonl = (value: unknown) => `${JSON.stringify(value)}\n`;

      // The title lives in the first line; the bulk of the file is well past
      // the head the listing is allowed to read.
      await fs.writeFile(
        path.join(transcriptDir, "session-a.jsonl"),
        jsonl({ type: "user", message: { role: "user", content: "First prompt" } }) +
          jsonl({
            type: "assistant",
            message: { role: "assistant", content: "x".repeat(200_000) },
          }),
      );
      await fs.writeFile(
        path.join(transcriptDir, "session-b.jsonl"),
        jsonl({ type: "summary", summary: "no user message" }),
      );

      const sessions = (await invoke(
        handlers,
        "claude_tmux_list_previous_sessions",
        { environmentId: environment.id },
        context,
      )) as Array<{
        session_id: string;
        title: string | null;
        message_count: number;
        transcript_path: string;
      }>;

      const byId = new Map(sessions.map((session) => [session.session_id, session]));
      expect(byId.get("session-a")).toMatchObject({
        title: "First prompt",
        message_count: 2,
        transcript_path: path.join(transcriptDir, "session-a.jsonl"),
      });
      expect(byId.get("session-b")).toMatchObject({ title: null, message_count: 1 });
    });
  });
});
