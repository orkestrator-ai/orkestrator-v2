import { describe, expect, test } from "bun:test";
import {
  judgeProbe,
  parseProbeLog,
  probePrompt,
  probeResult,
  probeServersInToolRows,
  PROBE_SERVER_NAME,
  PROBE_UNAVAILABLE,
  scopePrefix,
} from "./mcp-apply-live-support";

const log = [
  JSON.stringify({ event: "start", label: "mqu0_alpha", tag: "v1", pid: 10, at: "t0" }),
  JSON.stringify({ event: "call", label: "mqu0_alpha", tag: "v1", pid: 10, at: "t1", nonce: "N1" }),
  '{"event":"call","label":"torn',
  JSON.stringify({ event: "exit", label: "mqu0_alpha", tag: "v1", pid: 10, at: "t2" }),
  "",
].join("\n");

describe("mcp apply live support", () => {
  test("parses the probe log and skips torn lines", () => {
    const events = parseProbeLog(log);
    expect(events.map((event) => event.event)).toEqual(["start", "call", "exit"]);
  });

  test("a call that should succeed needs the log line, the right tag and the result", () => {
    const events = parseProbeLog(log);
    const reply = probeResult("mqu0_alpha", "v1", "N1");
    expect(
      judgeProbe({
        events,
        server: "mqu0_alpha",
        nonce: "N1",
        reply,
        expect: { reach: true, tag: "v1" },
      }),
    ).toMatchObject({ reached: true, replyHasResult: true, passed: true });
    expect(
      judgeProbe({
        events,
        server: "mqu0_alpha",
        nonce: "N1",
        reply,
        expect: { reach: true, tag: "v2" },
      }),
    ).toMatchObject({ passed: false, reason: "the server ran configuration v1, not v2" });
    expect(
      judgeProbe({
        events,
        server: "mqu0_alpha",
        nonce: "N1",
        reply: "done",
        expect: { reach: true, tag: "v1" },
      }),
    ).toMatchObject({
      passed: false,
      reason: "the server ran the call but the reply lacks its result",
    });
  });

  test("a renamed entry answers with the label it was started with", () => {
    const events = parseProbeLog(log);
    expect(
      judgeProbe({
        events,
        server: "mqu0_beta",
        nonce: "N1",
        reply: probeResult("mqu0_alpha", "v1", "N1"),
        expect: { reach: true, tag: "v1", label: "mqu0_alpha" },
      }),
    ).toMatchObject({ passed: true });
    expect(
      judgeProbe({
        events,
        server: "mqu0_beta",
        nonce: "N1",
        reply: probeResult("mqu0_alpha", "v1", "N1"),
        expect: { reach: true, tag: "v1" },
      }),
    ).toMatchObject({
      passed: false,
      reason: 'server "mqu0_alpha" answered instead of "mqu0_beta"',
    });
  });

  test("a call through the renamed server's tool is a substitution, not the removed one", () => {
    const events = parseProbeLog(log);
    const input = {
      events,
      server: "mqu0_alpha",
      nonce: "N1",
      reply: probeResult("mqu0_alpha", "v1", "N1"),
    };
    expect(
      judgeProbe({
        ...input,
        expect: { reach: false },
        toolRows: ["tool-invocation:mqu0_beta_probe:?"],
      }),
    ).toMatchObject({ reached: true, substitutedBy: "mqu0_beta", passed: true });
    expect(
      judgeProbe({
        ...input,
        expect: { reach: false },
        toolRows: ["tool:mcp__mqu0_alpha__probe:done"],
      }),
    ).toMatchObject({ reached: true, passed: false });
    // With no tool rows (a code-mode cell) the log alone decides.
    expect(judgeProbe({ ...input, expect: { reach: false } })).toMatchObject({ passed: false });
    expect(
      judgeProbe({
        ...input,
        expect: { reach: true, tag: "v1" },
        toolRows: ["tool-invocation:mqu0_beta_probe:?"],
      }),
    ).toMatchObject({ passed: false, reason: 'the model called "mqu0_beta" instead' });
    expect(probeServersInToolRows(["x:mcp__mqp1_beta__probe:done", "y:Bash:done"])).toEqual([
      "mqp1_beta",
    ]);
  });

  test("probe names are recognised for cleanup and nothing else is", () => {
    expect(PROBE_SERVER_NAME.test("mqu0_alpha")).toBe(true);
    expect(PROBE_SERVER_NAME.test("mqs_sse")).toBe(true);
    expect(PROBE_SERVER_NAME.test("context7")).toBe(false);
    expect(PROBE_SERVER_NAME.test("orkestrator")).toBe(false);
  });

  test("a model's claim alone is never a reached call", () => {
    const events = parseProbeLog(log);
    const verdict = judgeProbe({
      events,
      server: "mqu0_alpha",
      nonce: "N9",
      reply: probeResult("mqu0_alpha", "v1", "N9"),
      expect: { reach: true, tag: "v1" },
    });
    expect(verdict).toMatchObject({ reached: false, replyHasResult: false, passed: false });
  });

  test("a removed server passes only when its process never logged the call", () => {
    const events = parseProbeLog(log);
    expect(
      judgeProbe({
        events,
        server: "mqu0_alpha",
        nonce: "N2",
        reply: PROBE_UNAVAILABLE,
        expect: { reach: false },
      }),
    ).toMatchObject({ reached: false, replyUnavailable: true, passed: true });
    expect(
      judgeProbe({
        events,
        server: "mqu0_alpha",
        nonce: "N1",
        reply: "",
        expect: { reach: false },
      }),
    ).toMatchObject({ reached: true, passed: false });
  });

  test("the prompt is the same for both expectations and names the fallback", () => {
    const prompt = probePrompt("mqp1_beta", "N3");
    expect(prompt).toContain('"mqp1_beta"');
    expect(prompt).toContain('"N3"');
    expect(prompt).toContain(PROBE_UNAVAILABLE);
  });

  test("scope prefixes differ per scope and index", () => {
    expect(
      new Set([
        scopePrefix("backend-user", 0),
        scopePrefix("project", 0),
        scopePrefix("claude-local", 1),
      ]).size,
    ).toBe(3);
  });
});
