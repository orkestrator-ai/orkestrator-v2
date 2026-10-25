import { describe, expect, test } from "bun:test";
import {
  dispatchProbeTurn,
  hasRunningSleep,
  invokeCommand,
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
    ).toMatchObject({ reached: true, substitutedBy: "mqu0_beta", passed: false });
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

  test("a removed server needs an unavailable reply and no logged call", () => {
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

  test.each(["dispatch rejected", "provider error", "no reply within 240s"])(
    "negative probes cannot pass when the turn fails: %s",
    (turnError) => {
      for (const reply of ["", PROBE_UNAVAILABLE]) {
        expect(
          judgeProbe({
            events: [],
            server: "mqu0_alpha",
            nonce: "N2",
            reply,
            expect: { reach: false },
            turnError,
          }),
        ).toMatchObject({ passed: false, reason: `probe turn failed: ${turnError}` });
      }
    },
  );

  test.each(["", "done", `I could not call it: ${PROBE_UNAVAILABLE}`])(
    "silence or an invalid negative reply cannot qualify removal: %s",
    (reply) =>
      expect(
        judgeProbe({
          events: [],
          server: "mqu0_alpha",
          nonce: "N2",
          reply,
          expect: { reach: false },
        }).passed,
      ).toBe(false),
  );

  test("a substituted call on a must-fail probe passes only when the inventory proves the name gone", () => {
    const events = parseProbeLog(log);
    const input = {
      events,
      server: "mqu0_alpha",
      nonce: "N1",
      reply: probeResult("mqu0_alpha", "v1", "N1"),
      expect: { reach: false } as const,
      toolRows: ["tool-invocation:mqu0_beta_probe:completed"],
    };
    // The renamed server loaded and the old name did not: removal is proven by
    // the runtime, whatever tool the model picked.
    expect(judgeProbe({ ...input, inventory: ["orkestrator", "mqu0_beta"] })).toMatchObject({
      passed: true,
      substitutedBy: "mqu0_beta",
      absenceProvenBy: "inventory",
    });
    // Still listed: nothing is proven.
    expect(judgeProbe({ ...input, inventory: ["mqu0_alpha", "mqu0_beta"] })).toMatchObject({
      passed: false,
      reason: 'the model called "mqu0_beta" instead and the session still lists "mqu0_alpha"',
    });
    // No inventory: the old rule stands.
    expect(judgeProbe(input)).toMatchObject({ passed: false, substitutedBy: "mqu0_beta" });
    expect(judgeProbe(input).reason).toContain("reported no MCP inventory");
    // The substitute itself must be in the inventory, or the reading is stale.
    expect(judgeProbe({ ...input, inventory: ["orkestrator"] }).passed).toBe(false);
    // A failed turn never proves anything.
    expect(
      judgeProbe({ ...input, inventory: ["mqu0_beta"], turnError: "provider error" }).passed,
    ).toBe(false);
    // A probe that must succeed is never rescued by the inventory.
    expect(
      judgeProbe({
        ...input,
        server: "mqu0_gamma",
        expect: { reach: true, tag: "v1" },
        inventory: ["mqu0_beta"],
      }).passed,
    ).toBe(false);
  });

  test("a beta substitution cannot qualify removal even if both names remain exposed", () => {
    const events = parseProbeLog(log);
    events.push({ event: "call", label: "mqu0_beta", tag: "v1", nonce: "N2", pid: 11, at: "t2" });
    expect(
      judgeProbe({
        events,
        server: "mqu0_alpha",
        nonce: "N2",
        reply: probeResult("mqu0_beta", "v1", "N2"),
        toolRows: ["tool:mcp__mqu0_beta__probe:success"],
        expect: { reach: false },
      }),
    ).toMatchObject({ passed: false, substitutedBy: "mqu0_beta" });
    expect(
      judgeProbe({
        events: [],
        server: "mqu0_alpha",
        nonce: "N2",
        reply: PROBE_UNAVAILABLE,
        toolRows: ["tool:mcp__mqu0_beta__probe:failure"],
        expect: { reach: false },
      }).passed,
    ).toBe(false);
  });

  test("busy setup requires this run's pending foreground shell command", () => {
    const part = {
      toolName: "bash",
      toolState: "pending",
      toolArgs: { command: "printf started > '/tmp/busy-unique'; sleep 45" },
    };
    expect(hasRunningSleep([{ parts: [part] }], "/tmp/busy-unique")).toBe(true);
    for (const changed of [
      { ...part, toolState: "success" },
      { ...part, toolName: "read" },
      { ...part, toolArgs: { command: "sleep 45" } },
      { ...part, toolArgs: { ...part.toolArgs, run_in_background: true } },
    ])
      expect(hasRunningSleep([{ parts: [changed] }], "/tmp/busy-unique")).toBe(false);
    expect(hasRunningSleep([{ parts: [part] }], "/tmp/another-run")).toBe(false);
    expect(hasRunningSleep([], "/tmp/busy-unique")).toBe(false);
  });

  test.each(["Timeout 240000ms exceeded", "cursor bridge is unavailable"])(
    "transport retries preserve the request key: %s",
    async (message) => {
      const keys: string[] = [];
      let issued = 0;
      const result = await dispatchProbeTurn(
        async (key) => {
          keys.push(key);
          if (keys.length === 1) throw new Error(message);
          return { outcome: "accepted" };
        },
        () => `key-${++issued}`,
        async () => {},
      );
      expect(result.outcome).toBe("accepted");
      expect(keys).toEqual(["key-1", "key-1"]);
      expect(issued).toBe(1);
    },
  );

  test("explicit rejections may retry under a new key and remain failures after exhaustion", async () => {
    let calls = 0;
    const keys: string[] = [];
    const result = await dispatchProbeTurn(
      async (key) => {
        keys.push(key);
        return { outcome: "rejected", error: "busy" };
      },
      () => `key-${++calls}`,
      async () => {},
    );
    expect(result.outcome).toBe("rejected");
    expect(new Set(keys).size).toBe(12);
  });

  test("transport retries are bounded and authentication errors propagate immediately", async () => {
    for (const [message, expectedCalls] of [
      ["timeout", 3],
      ["not authenticated", 1],
    ] as const) {
      let calls = 0;
      await expect(
        dispatchProbeTurn(
          async () => {
            calls++;
            throw new Error(message);
          },
          () => "key",
          async () => {},
        ),
      ).rejects.toThrow(message);
      expect(calls).toBe(expectedCalls);
    }
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

  describe("invokeCommand", () => {
    const reset = new Error(
      "apiRequestContext.post: read ECONNRESET\nCall log:\n  - cookie: orkestrator_gateway_auth=SECRET",
    );

    test("retries a read whose connection reset", async () => {
      let calls = 0;
      const result = await invokeCommand(
        "get_mcp_operation",
        async () => {
          calls += 1;
          if (calls < 3) throw reset;
          return "ok";
        },
        async () => {},
      );
      expect(result).toBe("ok");
      expect(calls).toBe(3);
    });

    test("never retries a mutation, and drops the call log with its cookie", async () => {
      let calls = 0;
      const error = await invokeCommand(
        "mutate_mcp_definition",
        async () => {
          calls += 1;
          throw reset;
        },
        async () => {},
      ).catch((caught: Error) => caught);
      expect(calls).toBe(1);
      expect((error as Error).message).toBe(
        "mutate_mcp_definition: apiRequestContext.post: read ECONNRESET",
      );
    });

    test("does not retry a read that failed for another reason", async () => {
      let calls = 0;
      await expect(
        invokeCommand(
          "get_mcp_operation",
          async () => {
            calls += 1;
            throw new Error("Timeout 240000ms exceeded");
          },
          async () => {},
        ),
      ).rejects.toThrow("get_mcp_operation: Timeout 240000ms exceeded");
      expect(calls).toBe(1);
    });

    test("gives up after the last attempt", async () => {
      let calls = 0;
      await expect(
        invokeCommand(
          "list_mcp_management_targets",
          async () => {
            calls += 1;
            throw reset;
          },
          async () => {},
        ),
      ).rejects.toThrow("list_mcp_management_targets: apiRequestContext.post: read ECONNRESET");
      expect(calls).toBe(3);
    });
  });
});
