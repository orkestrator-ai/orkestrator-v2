/**
 * The scrubber is the only thing standing between a raw recording — which holds
 * real prompts, file contents and possibly credentials — and a committed fixture.
 * These tests pin the patterns that matter, and pin the property that a redaction
 * must never break JSON framing.
 */
import { describe, expect, test } from "bun:test";
import { homedir } from "node:os";
import { basename } from "node:path";
import { scrub } from "../../scripts/scrub-codex-recording.ts";

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

  test("the committed synthetic fixture is already clean", async () => {
    const path = "bridges/codex-bridge/src/testing/fixtures/synthetic-full-turn.jsonl";
    const contents = await Bun.file(path).text();
    // Guards the fixture against someone pasting real data into it later.
    expect(scrub(contents).totalHits).toBe(0);
  });
});
