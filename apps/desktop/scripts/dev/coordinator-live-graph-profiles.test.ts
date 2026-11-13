import { describe, expect, test } from "bun:test";
import { compile } from "@orkestrator/protocol/graphs/compile";
import { GRAPH_RESEARCHER_ON_CLAUDE_REASON } from "@orkestrator/protocol/graphs/agent-enforcement";
import {
  attemptedToolCalls,
  evaluateGraphProfilesProbe,
  GRAPH_PROFILE_PROBES,
  GRAPH_PROFILES_CLAUDE_SUBMIT_TOOL,
  graphProfileProbesFor,
  graphProfilesClaudeScript,
  graphProfilesPrompt,
  graphProfilesScriptId,
  graphProfilesTemplate,
  type GraphProfilesEvidence,
} from "./coordinator-live-graph-profiles.js";

const UNCHANGED = { head: "a".repeat(40), remote: "b".repeat(40) };

function evidence(overrides: Partial<GraphProfilesEvidence> = {}): GraphProfilesEvidence {
  return {
    platform: "claude",
    probe: "reviewer",
    shown: { tier: "enforced", allowed: true },
    runStatus: "complete",
    activation: { state: "complete", enforcement: "enforced", guards: [] },
    before: UNCHANGED,
    after: UNCHANGED,
    workspaceChanges: [],
    attemptedToolCalls: 5,
    ...overrides,
  };
}

function failedChecks(input: GraphProfilesEvidence): string[] {
  return evaluateGraphProfilesProbe(input)
    .checks.filter((check) => !check.passed)
    .map((check) => check.name);
}

describe("probe templates", () => {
  test("every probe's template compiles and may launch", () => {
    for (const probe of GRAPH_PROFILE_PROBES) {
      for (const scripted of [false, true]) {
        const result = compile(graphProfilesTemplate(probe, { nonce: "n1", scripted }));
        expect(
          result.diagnostics.filter((entry) => entry.severity === "error"),
          `${probe} (scripted ${scripted})`,
        ).toEqual([]);
        expect(result.ok).toBe(true);
        expect(result.launchable).toBe(true);
      }
    }
  });

  test("the researcher exception is probed on Claude only", () => {
    expect(graphProfileProbesFor("claude")).toEqual(["reviewer", "builder", "researcher"]);
    for (const platform of ["codex", "opencode", "pi", "cursor", "grok"] as const) {
      expect(graphProfileProbesFor(platform)).toEqual(["reviewer", "builder"]);
    }
  });

  test("only a scripted prompt carries the loopback model's marker", () => {
    const plain = graphProfilesPrompt("reviewer", { nonce: "Ab12" });
    expect(plain).not.toContain("[script:");
    expect(plain).toContain("git push origin HEAD");
    const scripted = graphProfilesPrompt("builder", { nonce: "Ab12", scripted: true });
    expect(scripted).toContain(`[script:${graphProfilesScriptId("builder", "Ab12")}]`);
    expect(graphProfilesScriptId("builder", "Ab12")).toBe("graph-profiles-builder-ab12");
  });

  test("Claude scripts attempt what the prompt asks, then submit with the quoted result key", () => {
    const input = { worktree: "/work/tree/", nonce: "n1", readmeFirstLine: "# Fixture" };
    const reviewer = graphProfilesClaudeScript("reviewer", input);
    expect(reviewer.map((step) => step.tool)).toEqual([
      "Write",
      "Edit",
      "Bash",
      "Bash",
      "Bash",
      "*__submit_report",
    ]);
    expect(reviewer[0]!.input.file_path).toBe("/work/tree/graph-probe-n1.txt");
    expect(reviewer[1]!.input).toMatchObject({ old_string: "# Fixture" });
    expect(reviewer.at(-1)).toMatchObject({
      fallback: GRAPH_PROFILES_CLAUDE_SUBMIT_TOOL,
      input: { resultKey: "{{resultKey}}", result: { text: expect.any(String) } },
    });
    expect(graphProfilesClaudeScript("builder", input).map((step) => step.tool)).toEqual([
      "Write",
      "Bash",
      "Bash",
      "*__submit_report",
    ]);
    expect(graphProfilesClaudeScript("researcher", input)).toHaveLength(1);
  });
});

describe("the verdict", () => {
  test("an enforced reviewer that let nothing land passes", () => {
    expect(evaluateGraphProfilesProbe(evidence()).passed).toBe(true);
  });

  test("a tier shown that is not the tier applied fails", () => {
    expect(
      failedChecks(evidence({ shown: { tier: "provider-configured", allowed: true } })),
    ).toEqual(["tier-shown-is-tier-applied"]);
  });

  test("an enforced or provider-configured reviewer fails on any change, caught or not", () => {
    for (const tier of ["enforced", "provider-configured"] as const) {
      const failed = failedChecks(
        evidence({
          shown: { tier, allowed: true },
          activation: {
            state: "failed",
            enforcement: tier,
            guards: [{ guard: "read-only", outcome: "violated" }],
          },
          runStatus: "failed",
          workspaceChanges: ["files +graph-probe-n1.txt"],
        }),
      );
      expect(failed).toEqual(["nothing-landed"]);
    }
  });

  test("an advisory reviewer passes only when what landed was caught", () => {
    const advisory = {
      shown: { tier: "advisory" as const, allowed: true },
      runStatus: "failed",
      workspaceChanges: ["files ~README.md"],
      after: { head: "c".repeat(40), remote: "d".repeat(40) },
    };
    expect(
      failedChecks(
        evidence({
          ...advisory,
          activation: {
            state: "failed",
            enforcement: "advisory",
            guards: [
              { guard: "read-only", outcome: "violated" },
              { guard: "remote-ref", outcome: "violated" },
            ],
          },
        }),
      ),
    ).toEqual([]);
    expect(
      failedChecks(
        evidence({
          ...advisory,
          activation: {
            state: "failed",
            enforcement: "advisory",
            error: "worktree_changed: the workspace changed",
          },
        }),
      ),
    ).toEqual(["push-caught"]);
    expect(
      failedChecks(
        evidence({ ...advisory, activation: { state: "complete", enforcement: "advisory" } }),
      ),
    ).toEqual(["workspace-change-caught", "push-caught"]);
  });

  test("a builder may commit, and a push passes only when refused or caught", () => {
    const builder = {
      probe: "builder" as const,
      shown: { tier: "advisory" as const, allowed: true },
      workspaceChanges: ["files +graph-probe-n1.txt"],
    };
    expect(
      failedChecks(
        evidence({
          ...builder,
          activation: { state: "complete", enforcement: "advisory" },
          after: { ...UNCHANGED, head: "c".repeat(40) },
        }),
      ),
    ).toEqual([]);
    expect(
      failedChecks(
        evidence({
          ...builder,
          activation: { state: "complete", enforcement: "advisory" },
          after: { head: "c".repeat(40), remote: "c".repeat(40) },
        }),
      ),
    ).toEqual(["push-refused-or-caught"]);
    expect(
      failedChecks(
        evidence({
          ...builder,
          runStatus: "failed",
          activation: {
            state: "failed",
            enforcement: "advisory",
            guards: [{ guard: "remote-ref", outcome: "violated" }],
          },
          after: { head: "c".repeat(40), remote: "c".repeat(40) },
        }),
      ),
    ).toEqual([]);
  });

  test("a Claude researcher runs as an ordinary turn with hosted search", () => {
    const researcher = {
      probe: "researcher" as const,
      shown: { tier: "provider-configured" as const, allowed: true },
      attemptedToolCalls: 0,
      activation: {
        state: "complete",
        enforcement: "provider-configured" as const,
        enforcementReason: GRAPH_RESEARCHER_ON_CLAUDE_REASON,
      },
    };
    expect(failedChecks(evidence({ ...researcher, offeredTools: ["Read", "WebSearch"] }))).toEqual(
      [],
    );
    expect(failedChecks(evidence({ ...researcher, offeredTools: ["Read"] }))).toEqual([
      "hosted-search-offered",
    ]);
    expect(
      failedChecks(
        evidence({
          ...researcher,
          activation: { state: "complete", enforcement: "provider-configured" },
        }),
      ),
    ).toEqual(["researcher-runs-as-ordinary-turn"]);
  });

  test("a probe that attempted nothing, never settled or was not offered fails", () => {
    expect(failedChecks(evidence({ attemptedToolCalls: 0 }))).toEqual(["attempted"]);
    expect(failedChecks(evidence({ attemptedToolCalls: null }))).toEqual(["attempted"]);
    expect(failedChecks(evidence({ runStatus: "running" }))).toEqual(["run-settled"]);
    expect(
      failedChecks(
        evidence({
          shown: { tier: "advisory", allowed: false },
          runStatus: "not launched",
          activation: null,
          attemptedToolCalls: null,
        }),
      ),
    ).toEqual(["picker-offered", "run-settled", "tier-shown-is-tier-applied", "attempted"]);
  });

  test("check details are bounded", () => {
    const { checks } = evaluateGraphProfilesProbe(
      evidence({ workspaceChanges: ["files " + "x".repeat(2_000)] }),
    );
    expect(checks.every((check) => (check.detail ?? "").length <= 500)).toBe(true);
  });
});

describe("attempted tool calls", () => {
  test("counts tool calls, not the result tools", () => {
    const messages = [
      {
        parts: [
          { type: "text", content: "x" },
          { type: "tool-invocation", toolName: "Write" },
          { type: "tool-invocation", toolName: "Bash" },
          { type: "tool-invocation", toolName: "mcp__orkestrator__submit_report" },
          { type: "tool-invocation", toolName: "validate_report" },
        ],
      },
      { parts: [{ type: "tool-invocation", content: "Edit" }] },
      null,
      { parts: "not a list" },
    ];
    expect(attemptedToolCalls(messages)).toBe(3);
  });
});
