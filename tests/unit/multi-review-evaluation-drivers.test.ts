import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { evaluationCorpus } from "../../apps/backend/src/core/multi-review-evaluation-corpus";
import { referenceConsolidation } from "../../apps/backend/src/core/multi-review-evaluation";
import {
  claudeConsolidationArgs,
  codexConsolidationArgs,
  parseClaudeResult,
  parseCodexResult,
  runConsolidation,
} from "../../scripts/multi-review-evaluation-drivers";

const repoRoot = path.join(import.meta.dir, "../..");
const temporaryDirectories: string[] = [];

function temporaryDirectory(): string {
  const directory = mkdtempSync(path.join(tmpdir(), "mre-drivers-test-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

const lateUnique = evaluationCorpus().find((entry) => entry.id === "late-unique")!;
const reference = referenceConsolidation(lateUnique);

/**
 * A fake `codex` that answers `--version`, records its argv and working
 * directory, reads the prompt from stdin, writes `$FAKE_ANSWER` to the
 * `--output-last-message` file and prints `codex exec --json` events.
 */
function fakeCodex(directory: string, events: string): string {
  const file = path.join(directory, "codex");
  writeFileSync(
    file,
    `#!/bin/sh
set -eu
if [ "$1" = "--version" ]; then echo "codex-cli 0.0.0-fake"; exit 0; fi
out=""
previous=""
for argument in "$@"; do
  if [ "$previous" = "--output-last-message" ]; then out="$argument"; fi
  previous="$argument"
done
printf '%s\\n' "$@" > "$FAKE_RECORD/argv"
pwd > "$FAKE_RECORD/cwd"
wc -c > "$FAKE_RECORD/stdin-bytes"
cp "$FAKE_ANSWER" "$out"
cat <<'EVENTS'
${events}
EVENTS
`,
  );
  chmodSync(file, 0o755);
  return file;
}

function fakeClaude(directory: string): string {
  const file = path.join(directory, "claude");
  writeFileSync(
    file,
    `#!/bin/sh
set -eu
if [ "$1" = "--version" ]; then echo "9.9.9 (Claude Code fake)"; exit 0; fi
pwd > "$FAKE_RECORD/cwd"
cat > /dev/null
printf '{"type":"result","subtype":"success","is_error":false,"total_cost_usd":0.01,"usage":{"input_tokens":10,"output_tokens":20,"cache_read_input_tokens":30,"cache_creation_input_tokens":40},"structured_output":%s}' "$(cat "$FAKE_ANSWER")"
`,
  );
  chmodSync(file, 0o755);
  return file;
}

const COMPLETED_EVENTS = [
  '{"type":"thread.started","thread_id":"t"}',
  '{"type":"turn.started"}',
  '{"type":"item.completed","item":{"id":"i","type":"agent_message","text":"{}"}}',
  '{"type":"turn.completed","usage":{"input_tokens":1200,"cached_input_tokens":1024,"output_tokens":300}}',
].join("\n");

describe("Codex consolidation driver", () => {
  test("runs exec ephemeral, read-only, tool-free, with the schema and JSON events", () => {
    const args = codexConsolidationArgs({
      cwd: "/tmp/work",
      model: "gpt-x",
      schemaPath: "/tmp/files/schema.json",
      outputPath: "/tmp/files/answer.json",
    });
    const execIndex = args.indexOf("exec");
    const global = args.slice(0, execIndex);
    expect(global).toEqual(expect.arrayContaining(["--model", "gpt-x", "--cd", "/tmp/work"]));
    expect(global.join(" ")).toContain("--sandbox read-only");
    expect(global.join(" ")).toContain("--ask-for-approval never");
    expect(global.join(" ")).toContain("--disable shell_tool");
    expect(global.join(" ")).toContain("--config include_environment_context=false");
    expect(args.slice(execIndex)).toEqual(
      expect.arrayContaining([
        "--ephemeral",
        "--ignore-user-config",
        "--ignore-rules",
        "--skip-git-repo-check",
        "--json",
      ]),
    );
    expect(args[args.indexOf("--output-schema") + 1]).toBe("/tmp/files/schema.json");
    expect(args[args.indexOf("--output-last-message") + 1]).toBe("/tmp/files/answer.json");
    expect(args.at(-1)).toBe("-");
    expect(
      codexConsolidationArgs({ cwd: "/w", model: undefined, schemaPath: "/s", outputPath: "/o" }),
    ).not.toContain("--model");
  });

  test("reads usage from the last turn.completed and the answer from the message file", () => {
    const turn = parseCodexResult(
      `not json\n${COMPLETED_EVENTS}\n`,
      0,
      JSON.stringify({ verdict: "yes" }),
    );
    expect(turn).toEqual({
      ok: true,
      answer: { verdict: "yes" },
      inputTokens: 1200,
      outputTokens: 300,
      cacheReadTokens: 1024,
      cacheWriteTokens: undefined,
    });
  });

  test("fails a turn that failed, exited non-zero, gave no usage or an unparseable answer", () => {
    expect(
      parseCodexResult('{"type":"turn.failed","error":{"message":"x"}}', 0, undefined),
    ).toEqual(expect.objectContaining({ ok: false, failure: "turn.failed" }));
    expect(parseCodexResult(COMPLETED_EVENTS, 1, "{}")).toEqual(
      expect.objectContaining({ ok: false, failure: "exit 1" }),
    );
    expect(parseCodexResult("", 0, "{}")).toEqual(
      expect.objectContaining({ ok: false, failure: "no turn.completed event" }),
    );
    const unparseable = parseCodexResult(COMPLETED_EVENTS, 0, "not json");
    expect(unparseable).toEqual(
      expect.objectContaining({ ok: false, failure: "unparseable answer" }),
    );
    expect(unparseable.answer).toBeUndefined();
  });

  test("runs the CLI with the prompt on stdin and leaves a shared working directory empty", async () => {
    const bin = temporaryDirectory();
    const record = temporaryDirectory();
    const shared = temporaryDirectory();
    const answerPath = path.join(temporaryDirectory(), "answer.json");
    writeFileSync(answerPath, JSON.stringify(reference));
    const turn = await runConsolidation({
      provider: "codex",
      executable: fakeCodex(bin, COMPLETED_EVENTS),
      prompt: "consolidate this",
      model: "gpt-x",
      fixedCwd: shared,
      env: { ...process.env, FAKE_RECORD: record, FAKE_ANSWER: answerPath },
    });
    expect(turn).toEqual(
      expect.objectContaining({ ok: true, answer: reference, cacheReadTokens: 1024 }),
    );
    expect(readFileSync(path.join(record, "stdin-bytes"), "utf8").trim()).toBe("16");
    expect(readFileSync(path.join(record, "argv"), "utf8").split("\n")).toEqual(
      expect.arrayContaining(["--cd", shared, "exec", "--json"]),
    );
    expect(path.resolve(readFileSync(path.join(record, "cwd"), "utf8").trim())).toBe(
      path.resolve(shared),
    );
    // The schema and the answer file live outside the shared directory.
    expect(readdirSync(shared)).toEqual([]);
  });
});

describe("Claude consolidation driver", () => {
  test("keeps the existing tool-free, schema-enforced flags", () => {
    const args = claudeConsolidationArgs("sonnet");
    expect(args.slice(0, 3)).toEqual(["-p", "--model", "sonnet"]);
    expect(args).toEqual(
      expect.arrayContaining(["--no-session-persistence", "--strict-mcp-config", "--json-schema"]),
    );
    expect(args[args.indexOf("--tools") + 1]).toBe("");
  });

  test("maps the result's usage and structured output, and fails a non-zero exit", () => {
    expect(
      parseClaudeResult(
        JSON.stringify({
          subtype: "success",
          is_error: false,
          total_cost_usd: 0.5,
          usage: { input_tokens: 1, output_tokens: 2, cache_read_input_tokens: 3 },
          structured_output: { verdict: "no" },
        }),
        0,
      ),
    ).toEqual({
      ok: true,
      answer: { verdict: "no" },
      inputTokens: 1,
      outputTokens: 2,
      cacheReadTokens: 3,
      cacheWriteTokens: undefined,
      costUsd: 0.5,
    });
    expect(parseClaudeResult("", 2)).toEqual({ ok: false, failure: "exit 2" });
    expect(parseClaudeResult("{", 0)).toEqual({ ok: false, failure: "unparseable result" });
    expect(parseClaudeResult(JSON.stringify({ subtype: "error_max_turns" }), 0)).toEqual(
      expect.objectContaining({ ok: false, failure: "error_max_turns" }),
    );
  });
});

describe("live subcommand", () => {
  for (const provider of ["codex", "claude"] as const) {
    test(`scores a ${provider} run end to end against a fake CLI`, () => {
      const bin = temporaryDirectory();
      const record = temporaryDirectory();
      const out = temporaryDirectory();
      const answerPath = path.join(temporaryDirectory(), "answer.json");
      writeFileSync(answerPath, JSON.stringify(reference));
      const executable = provider === "codex" ? fakeCodex(bin, COMPLETED_EVENTS) : fakeClaude(bin);
      const result = Bun.spawnSync(
        [
          process.execPath,
          "scripts/multi-review-evaluation.ts",
          "live",
          "--provider",
          provider,
          "--bin",
          executable,
          "--cases",
          "late-unique",
          "--variants",
          "compact",
          "--out",
          out,
        ],
        {
          cwd: repoRoot,
          env: { ...process.env, FAKE_RECORD: record, FAKE_ANSWER: answerPath },
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      expect(result.exitCode).toBe(0);
      const directory = path.join(out, "live", provider);
      const run = JSON.parse(readFileSync(path.join(directory, "run.json"), "utf8"));
      expect(run).toMatchObject({
        provider,
        cliVersion: provider === "codex" ? "codex-cli 0.0.0-fake" : "9.9.9 (Claude Code fake)",
        model: provider === "codex" ? "(CLI default)" : "sonnet",
      });
      const [row] = JSON.parse(readFileSync(path.join(directory, "scores.json"), "utf8"));
      expect(row).toMatchObject({
        provider,
        case: "late-unique",
        variant: "compact",
        ok: true,
        schemaValid: true,
        falseMerges: 0,
        splits: 0,
        provenance: true,
        verdict: true,
      });
      expect(row.recalled).toBe(row.expected);
    }, 30_000);
  }

  test("rejects an unknown provider or case before calling any CLI", () => {
    const record = temporaryDirectory();
    const bin = fakeCodex(temporaryDirectory(), COMPLETED_EVENTS);
    for (const extra of [
      ["--provider", "gemini"],
      ["--provider", "codex", "--cases", "late-unique,no-such-case"],
    ]) {
      const result = Bun.spawnSync(
        [process.execPath, "scripts/multi-review-evaluation.ts", "live", "--bin", bin, ...extra],
        {
          cwd: repoRoot,
          env: { ...process.env, FAKE_RECORD: record, FAKE_ANSWER: "/nonexistent" },
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      expect(result.exitCode).toBe(2);
    }
    expect(readdirSync(record)).toEqual([]);
  }, 30_000);
});
