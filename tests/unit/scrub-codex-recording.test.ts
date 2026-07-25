/**
 * The scrubber is the only thing standing between a raw recording — which holds
 * real prompts, file contents and possibly credentials — and a committed fixture.
 * These tests pin the patterns that matter, and pin the property that a redaction
 * must never break JSON framing.
 */
import { describe, expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import {
  buildRedactions,
  censusByMethod,
  parseArguments,
  scrub,
  stripContent,
} from "../../scripts/scrub-codex-recording.ts";

const scriptPath = join(import.meta.dir, "..", "..", "scripts", "scrub-codex-recording.ts");

async function runCli(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const child = Bun.spawn([process.execPath, scriptPath, ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { code, stdout, stderr };
}

describe("scrub-codex-recording", () => {
  test("redacts provider keys by prefix", () => {
    const input = [
      "sk-abcdefghijklmnopqrstuvwx",
      "sk-ant-api03-abcdefghijklmnopqrst",
      "ghp_abcdefghijklmnopqrstuvwxyz1234",
      "AKIAIOSFODNN7EXAMPLE",
      "xoxb-1234567890-abcdefghij",
      `AIzaSy${"B".repeat(33)}`,
    ].join("\n");

    const { output, hits, totalHits } = scrub(input);

    expect(totalHits).toBeGreaterThanOrEqual(6);
    expect(output).not.toContain("abcdefghijklmnopqrstuvwx");
    expect(output).not.toContain("AKIAIOSFODNN7EXAMPLE");
    expect(output).not.toContain("BBBBBBBBBB");
    // The Anthropic rule must actually fire rather than being swallowed by the
    // broader `sk-` rule, so the report names the right provider.
    expect(hits["anthropic-key"]).toBe(1);
    expect(hits["openai-key"]).toBe(1);
  });

  test("redacts bearer tokens and JWTs", () => {
    const { output } = scrub(
      'Authorization: Bearer abcdefghijklmnopqrstuvwxyz123456\ntoken eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk',
    );
    expect(output).not.toContain("abcdefghijklmnopqrstuvwxyz123456");
    expect(output).not.toContain("eyJhbGciOiJIUzI1NiJ9");
    expect(output).toContain("Bearer «redacted»");
  });

  test("redacts secret-shaped env assignments while keeping the variable name", () => {
    const { output } = scrub("GITHUB_TOKEN=ghs_realvaluehere123\nMY_API_KEY=supersecretvalue");
    expect(output).toContain("GITHUB_TOKEN=");
    expect(output).toContain("MY_API_KEY=«redacted»");
    expect(output).not.toContain("supersecretvalue");
  });

  test("redacts secret-shaped JSON fields", () => {
    const { output } = scrub('{"apiKey":"abcdef123456","harmless":"keep-me"}');
    expect(output).toContain('"apiKey":"«redacted»"');
    // Non-secret fields must survive, or the fixture loses its value.
    expect(output).toContain('"harmless":"keep-me"');
  });

  test("redacts PEM private key blocks", () => {
    const { output } = scrub(
      "-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAA\n-----END OPENSSH PRIVATE KEY-----",
    );
    expect(output).not.toContain("b3BlbnNzaC1rZXktdjEAAAAA");
  });

  test("replaces the home path and username", () => {
    const home = homedir();
    const user = basename(home);
    const { output } = scrub(`cwd is ${home}/projects and the user is ${user}`);
    expect(output).not.toContain(home);
    expect(output).toContain("/home/user/projects");
    expect(output).not.toMatch(new RegExp(`\\b${user}\\b`));
  });

  test("replaces emails and private IPs", () => {
    const { output } = scrub("dev@company.internal reached 192.168.1.44 and 10.2.3.4");
    expect(output).toContain("user@example.com");
    expect(output).not.toContain("192.168.1.44");
    expect(output).not.toContain("10.2.3.4");
  });

  test("leaves public IPs alone", () => {
    // Only private ranges identify an internal network; redacting 8.8.8.8 would
    // just make the fixture less faithful for no gain.
    const { output } = scrub("resolver at 8.8.8.8");
    expect(output).toContain("8.8.8.8");
  });

  test("scrubbed JSONL is still valid JSON on every line", () => {
    const lines = [
      JSON.stringify({
        jsonrpc: "2.0",
        method: "item/completed",
        params: {
          item: {
            type: "commandExecution",
            command: `cat ${homedir()}/.env`,
            aggregatedOutput: "OPENAI_API_KEY=sk-abcdefghijklmnopqrstuvwx\n",
          },
        },
      }),
      JSON.stringify({ jsonrpc: "2.0", method: "turn/completed", params: { turn: { id: "t" } } }),
    ].join("\n");

    const { output, totalHits } = scrub(lines);

    expect(totalHits).toBeGreaterThan(0);
    for (const line of output.split("\n").filter((entry) => entry.trim().length > 0)) {
      expect(() => JSON.parse(line)).not.toThrow();
    }
    expect(output).not.toContain("sk-abcdefghijklmnopqrstuvwx");
  });

  test("clean input is reported as having no hits", () => {
    const { output, totalHits } = scrub(
      '{"jsonrpc":"2.0","method":"turn/started","params":{"turn":{"id":"turn-1"}}}',
    );
    expect(totalHits).toBe(0);
    expect(output).toBe('{"jsonrpc":"2.0","method":"turn/started","params":{"turn":{"id":"turn-1"}}}');
  });

  test("every committed replay fixture is scrubbed", async () => {
    // The replay harness auto-discovers `*.jsonl` here, so dropping a raw
    // recording in is a one-file change that would otherwise commit real
    // prompts, file contents and absolute paths. This is the enforcement the
    // script's `--check` header promises: nothing else runs it.
    const fixtureDir = join(import.meta.dir, "..", "..", "bridges", "codex-bridge", "src", "testing", "fixtures");
    const fixtures = readdirSync(fixtureDir).filter((name) => name.endsWith(".jsonl"));
    expect(fixtures.length).toBeGreaterThan(0);

    for (const name of fixtures) {
      const contents = await Bun.file(join(fixtureDir, name)).text();
      // The identity is pinned to the placeholder the scrubber itself writes, so
      // this asserts the same thing on every machine and inside the container —
      // real developer paths are still caught by the generic home-shaped rule.
      const { hits, totalHits } = scrub(
        contents,
        buildRedactions({ home: "/home/user", user: "user" }),
      );
      expect({ name, hits }).toEqual({ name, hits: {} });
      expect(totalHits).toBe(0);
    }
  });

  test("redacts home-shaped paths from machines other than this one", () => {
    // Identity redaction keys off the scrubbing machine, so a recording made in
    // the container or by a colleague matched nothing and `--check` called it
    // clean. Verified against the exact container shape: /home/node.
    const { output, hits } = scrub(
      '{"cwd":"/home/node/workspace","also":"/Users/someone-else/code"}',
      buildRedactions({ home: "/home/scrubber", user: "scrubber" }),
    );

    expect(output).toBe('{"cwd":"/home/user/workspace","also":"/home/user/code"}');
    expect(hits["home-like-path"]).toBe(2);
  });

  test("scrubbing is idempotent, so re-checking a cleaned file stays clean", () => {
    // Every replacement the scrubber writes must itself be inert, or `--check`
    // would reject the very files this script produced.
    const identity = { home: "/x", user: "x" };
    const once = scrub(
      "/home/node/w and dev@company.internal at 192.168.1.44",
      buildRedactions(identity),
    );

    expect(once.totalHits).toBe(3);
    expect(scrub(once.output, buildRedactions(identity)).totalHits).toBe(0);
  });

  test("explicit --home/--user overrides replace the local machine's identity", () => {
    const redactions = buildRedactions({ home: "/build/agent-home", user: "agent" });
    const { output } = scrub("/build/agent-home/repo owned by agent", redactions);

    expect(output).toBe("/home/user/repo owned by user");
    // ...and the local identity is no longer special-cased.
    expect(scrub(`nothing about ${basename(homedir())}x here`, redactions).totalHits).toBe(0);
  });

  test("counts records by method for the --check census", () => {
    const input = [
      '{"jsonrpc":"2.0","method":"item/agentMessage/delta","params":{}}',
      '{"jsonrpc":"2.0","method":"item/agentMessage/delta","params":{}}',
      '{"jsonrpc":"2.0","method":"turn/completed","params":{}}',
      '{"jsonrpc":"2.0","id":1,"result":{}}',
      '{"jsonrpc":"2.0","id":2,"error":{}}',
      "{not json",
    ].join("\n");

    expect(censusByMethod(input)).toEqual({
      "item/agentMessage/delta": 2,
      "turn/completed": 1,
      "«result response»": 1,
      "«error response»": 1,
      "«unparseable»": 1,
    });
  });

  test("--strip-content blanks payload fields while keeping the record shape", () => {
    const input = [
      JSON.stringify({
        method: "item/agentMessage/delta",
        params: { itemId: "item-1", delta: "secret reasoning about the user" },
      }),
      JSON.stringify({
        method: "item/completed",
        params: {
          item: {
            type: "commandExecution",
            aggregatedOutput: "contents of a private file",
            text: "and the model's summary of it",
          },
        },
      }),
      JSON.stringify({ method: "turn/diff/updated", params: { diff: { "a.ts": "-secret\n+also secret" } } }),
      "not json at all",
    ].join("\n");

    const { output, stripped } = stripContent(input);
    const lines = output.split("\n");

    expect(stripped).toBe(4);
    expect(output).not.toContain("secret");
    expect(output).not.toContain("private file");
    // Shape survives: replay drives the reducer off these fields existing.
    expect(JSON.parse(lines[0]!)).toEqual({
      method: "item/agentMessage/delta",
      params: { itemId: "item-1", delta: "" },
    });
    expect(JSON.parse(lines[2]!).params.diff).toEqual({ "a.ts": "" });
    expect(lines[3]).toBe("not json at all");
  });

  test("parses flags in any position and rejects unknown ones", () => {
    expect(parseArguments(["in.jsonl"])).toEqual({
      inputPath: "in.jsonl",
      outputPath: "in.jsonl",
      check: false,
      stripContent: false,
      identity: {},
    });
    expect(parseArguments([
      "--home=/h",
      "in.jsonl",
      "--check",
      "out.jsonl",
      "--user=u",
      "--strip-content",
    ])).toEqual({
      inputPath: "in.jsonl",
      outputPath: "out.jsonl",
      check: true,
      stripContent: true,
      identity: { home: "/h", user: "u" },
    });
    expect(() => parseArguments([])).toThrow("usage:");
    expect(() => parseArguments(["a", "b", "c"])).toThrow("usage:");
    expect(() => parseArguments(["in.jsonl", "--nope"])).toThrow("Unknown flag --nope");
  });

  test("CLI check mode accepts clean input and rejects unsanitized input without writing", async () => {
    const root = await mkdtemp(join(tmpdir(), "ork-scrub-test-"));
    try {
      const cleanPath = join(root, "clean.jsonl");
      const dirtyPath = join(root, "dirty.jsonl");
      const clean = '{"jsonrpc":"2.0","method":"turn/started"}\n';
      const dirty = '{"token":"abcdefghijklmnopqrstuvwx"}\n';
      await writeFile(cleanPath, clean);
      await writeFile(dirtyPath, dirty);

      const cleanResult = await runCli([cleanPath, "--check"]);
      expect(cleanResult.code).toBe(0);
      expect(cleanResult.stdout).toContain("--check: no redaction pattern matched");
      // A census, not a bare "clean": no pattern covers prose, so the reviewer
      // has to be told which records they are about to commit.
      expect(cleanResult.stdout).toContain("Records by method:");
      expect(cleanResult.stdout).toMatch(/turn\/started\s+1/);
      expect(await readFile(cleanPath, "utf8")).toBe(clean);

      const dirtyResult = await runCli([dirtyPath, "--check"]);
      expect(dirtyResult.code).toBe(1);
      expect(dirtyResult.stderr).toContain("still contains data that needs scrubbing");
      expect(await readFile(dirtyPath, "utf8")).toBe(dirty);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("CLI writes scrubbed output to an explicit target", async () => {
    const root = await mkdtemp(join(tmpdir(), "ork-scrub-test-"));
    try {
      const inputPath = join(root, "raw.jsonl");
      const outputPath = join(root, "scrubbed.jsonl");
      await writeFile(inputPath, '{"apiKey":"abcdefghijklmnopqrstuvwx"}\n');

      const result = await runCli([inputPath, outputPath]);
      expect(result.code).toBe(0);
      expect(result.stdout).toContain(`Wrote ${outputPath}`);
      expect(await readFile(outputPath, "utf8")).toContain("«redacted»");
      expect(await readFile(inputPath, "utf8")).toContain("abcdefghijklmnopqrstuvwx");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("CLI --check fails on a foreign home path with an explicit identity", async () => {
    const root = await mkdtemp(join(tmpdir(), "ork-scrub-test-"));
    try {
      const path = join(root, "container.jsonl");
      await writeFile(path, '{"method":"turn/started","params":{"cwd":"/home/node/workspace"}}\n');

      const result = await runCli([path, "--check", "--home=/home/ci", "--user=ci"]);
      expect(result.code).toBe(1);
      expect(result.stderr).toContain("still contains data that needs scrubbing");
      expect(result.stdout).toContain("home-like-path");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("CLI --strip-content blanks payloads on the way to the output file", async () => {
    const root = await mkdtemp(join(tmpdir(), "ork-scrub-test-"));
    try {
      const inputPath = join(root, "raw.jsonl");
      const outputPath = join(root, "fixture.jsonl");
      await writeFile(
        inputPath,
        `${JSON.stringify({
          method: "item/agentMessage/delta",
          params: { delta: "the user's private prompt" },
        })}\n`,
      );

      const result = await runCli([inputPath, outputPath, "--strip-content"]);
      expect(result.code).toBe(0);
      expect(result.stdout).toContain("Blanked 1 content field(s)");
      const written = await readFile(outputPath, "utf8");
      expect(written).not.toContain("private prompt");
      expect(JSON.parse(written.trim())).toEqual({
        method: "item/agentMessage/delta",
        params: { delta: "" },
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("CLI rejects unknown flags without touching the file", async () => {
    const root = await mkdtemp(join(tmpdir(), "ork-scrub-test-"));
    try {
      const path = join(root, "raw.jsonl");
      await writeFile(path, '{"method":"turn/started"}\n');
      const result = await runCli([path, "--dry-run"]);
      expect(result.code).toBe(2);
      expect(result.stderr).toContain("Unknown flag --dry-run");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("CLI rejects malformed JSONL and reports file read failures", async () => {
    const root = await mkdtemp(join(tmpdir(), "ork-scrub-test-"));
    try {
      const malformedPath = join(root, "malformed.jsonl");
      await writeFile(malformedPath, '{"jsonrpc":\n');
      const malformed = await runCli([malformedPath, "--check"]);
      expect(malformed.code).toBe(1);
      expect(malformed.stderr).toContain("no longer valid JSON");

      const missing = await runCli([join(root, "missing.jsonl"), "--check"]);
      expect(missing.code).toBe(1);
      expect(missing.stderr).toMatch(/ENOENT|no such file/i);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
