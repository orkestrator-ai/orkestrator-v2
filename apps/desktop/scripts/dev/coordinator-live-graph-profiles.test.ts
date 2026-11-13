import { describe, expect, test } from "bun:test";
import { compile } from "@orkestrator/protocol/graphs/compile";
import { GRAPH_RESEARCHER_ON_CLAUDE_REASON } from "@orkestrator/protocol/graphs/agent-enforcement";
import {
  evaluateGraphProfilesProbe,
  GRAPH_PROFILE_PROBES,
  GRAPH_PROFILES_CLAUDE_SUBMIT_TOOL,
  graphProfileProbesFor,
  graphProfilesAttempts,
  graphProfilesClaudeScript,
  graphProfilesPrompt,
  graphProfilesScriptId,
  graphProfilesTemplate,
  type GraphProfilesEvidence,
} from "./coordinator-live-graph-profiles.js";

const UNCHANGED = { head: "a".repeat(40), remote: "a".repeat(40) };
/** Everything a reviewer or builder probe is asked to attempt. */
const ALL_ATTEMPTS = { toolCalls: 5, writes: 3, commits: 1, pushes: 1 };

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
    attempts: ALL_ATTEMPTS,
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
        evidence({
          ...advisory,
          runStatus: "complete",
          activation: { state: "complete", enforcement: "advisory" },
        }),
      ),
    ).toEqual(["workspace-change-caught", "push-caught"]);
  });

  test("a failed or cancelled run passes only when a guard caught what the probe may not do", () => {
    const researcher = {
      probe: "researcher" as const,
      shown: { tier: "provider-configured" as const, allowed: true },
      attempts: { toolCalls: 0, writes: 0, commits: 0, pushes: 0 },
    };
    for (const state of ["failed", "cancelled"]) {
      // A researcher that never submitted, whatever its enforcement metadata says.
      expect(
        failedChecks(
          evidence({
            ...researcher,
            runStatus: state,
            activation: {
              state,
              enforcement: "provider-configured",
              enforcementReason: GRAPH_RESEARCHER_ON_CLAUDE_REASON,
              error: "the agent exited",
            },
          }),
        ),
      ).toEqual(["run-outcome"]);
      // A reviewer or builder that made its attempts and then failed for another reason.
      for (const probe of ["reviewer", "builder"] as const) {
        const failed = failedChecks(
          evidence({
            probe,
            shown: { tier: "advisory", allowed: true },
            runStatus: state,
            activation: { state, enforcement: "advisory", error: "provider error" },
            ...(probe === "builder" ? { after: { ...UNCHANGED, head: "c".repeat(40) } } : {}),
          }),
        );
        expect(failed, `${probe} ${state}`).toEqual(["run-outcome"]);
      }
    }
    // A guard that caught a builder's allowed write does not explain its failure.
    expect(
      failedChecks(
        evidence({
          probe: "builder",
          shown: { tier: "advisory", allowed: true },
          runStatus: "failed",
          activation: {
            state: "failed",
            enforcement: "advisory",
            guards: [{ guard: "read-only", outcome: "violated" }],
          },
          after: { ...UNCHANGED, head: "c".repeat(40) },
        }),
      ),
    ).toEqual(["run-outcome"]);
    // A cancelled run is never explained, even with a guard result on record.
    expect(
      failedChecks(
        evidence({
          shown: { tier: "advisory", allowed: true },
          runStatus: "cancelled",
          activation: {
            state: "cancelled",
            enforcement: "advisory",
            guards: [{ guard: "remote-ref", outcome: "violated" }],
          },
        }),
      ),
    ).toEqual(["run-outcome"]);
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

  test("a builder push is judged only after its own commit put HEAD ahead of origin", () => {
    const builder = {
      probe: "builder" as const,
      shown: { tier: "advisory" as const, allowed: true },
      activation: { state: "complete", enforcement: "advisory" as const },
    };
    // It never committed: a refused push and a no-op push look the same.
    expect(failedChecks(evidence(builder))).toEqual(["commit-ahead-of-origin"]);
    // Origin was behind an older local HEAD that did not move.
    expect(
      failedChecks(
        evidence({
          ...builder,
          before: { head: "c".repeat(40), remote: "a".repeat(40) },
          after: { head: "c".repeat(40), remote: "a".repeat(40) },
        }),
      ),
    ).toEqual(["commit-ahead-of-origin"]);
  });

  test("a reviewer or builder that did not attempt every requested operation is inconclusive", () => {
    const readOnly = graphProfilesAttempts([
      {
        parts: [
          { type: "tool-invocation", toolName: "Read", toolArgs: { file_path: "README.md" } },
        ],
      },
    ]);
    expect(readOnly).toEqual({ toolCalls: 1, writes: 0, commits: 0, pushes: 0 });
    expect(failedChecks(evidence({ attempts: readOnly }))).toEqual(["attempted"]);
    // Wrote a file but never tried the shell, the commit or the push.
    expect(
      failedChecks(evidence({ attempts: { toolCalls: 2, writes: 2, commits: 0, pushes: 0 } })),
    ).toEqual(["attempted"]);
    const builder = {
      probe: "builder" as const,
      shown: { tier: "advisory" as const, allowed: true },
      activation: { state: "complete", enforcement: "advisory" as const },
      after: { ...UNCHANGED, head: "c".repeat(40) },
    };
    // A builder that committed but never tried to push proves nothing about the push.
    expect(
      failedChecks(
        evidence({ ...builder, attempts: { toolCalls: 2, writes: 1, commits: 1, pushes: 0 } }),
      ),
    ).toEqual(["attempted"]);
    const detail = evaluateGraphProfilesProbe(evidence({ attempts: readOnly })).checks.find(
      (check) => check.name === "attempted",
    )?.detail;
    expect(detail).toContain("no writes, commits, pushes attempted");
  });

  test("a Claude researcher runs as an ordinary turn with hosted search", () => {
    const researcher = {
      probe: "researcher" as const,
      shown: { tier: "provider-configured" as const, allowed: true },
      attempts: { toolCalls: 0, writes: 0, commits: 0, pushes: 0 },
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
    expect(
      failedChecks(evidence({ attempts: { toolCalls: 0, writes: 0, commits: 0, pushes: 0 } })),
    ).toEqual(["attempted"]);
    expect(failedChecks(evidence({ attempts: null }))).toEqual(["attempted"]);
    expect(failedChecks(evidence({ runStatus: "running" }))).toEqual(["run-outcome"]);
    expect(
      failedChecks(
        evidence({
          shown: { tier: "advisory", allowed: false },
          runStatus: "not launched",
          activation: null,
          attempts: null,
        }),
      ),
    ).toEqual(["picker-offered", "run-outcome", "tier-shown-is-tier-applied", "attempted"]);
  });

  test("check details are bounded", () => {
    const { checks } = evaluateGraphProfilesProbe(
      evidence({ workspaceChanges: ["files " + "x".repeat(2_000)] }),
    );
    expect(checks.every((check) => (check.detail ?? "").length <= 500)).toBe(true);
  });
});

describe("attempted operations", () => {
  test("classifies tool calls by what they attempt, never counting the result tools", () => {
    const messages = [
      {
        parts: [
          { type: "text", content: "x" },
          { type: "tool-invocation", toolName: "Write", toolArgs: { file_path: "a.txt" } },
          { type: "tool-invocation", toolName: "Edit", toolArgs: { file_path: "README.md" } },
          { type: "tool-invocation", toolName: "Bash", toolArgs: { command: "touch probe" } },
          {
            type: "tool-invocation",
            toolName: "Bash",
            toolArgs: { command: "git add a.txt && git commit -m probe" },
          },
          {
            type: "tool-invocation",
            toolName: "Bash",
            toolArgs: { command: "git push origin HEAD" },
          },
          { type: "tool-invocation", toolName: "mcp__orkestrator__submit_report" },
          { type: "tool-invocation", toolName: "validate_report" },
        ],
      },
      { parts: [{ type: "tool-invocation", content: "Edit" }] },
      null,
      { parts: "not a list" },
    ];
    expect(graphProfilesAttempts(messages)).toEqual({
      toolCalls: 6,
      writes: 4,
      commits: 1,
      pushes: 1,
    });
  });

  test("reads other providers' shell and patch calls, and shell reads are not writes", () => {
    const messages = [
      {
        parts: [
          { type: "tool-invocation", toolName: "bash", toolArgs: { command: "cat README.md" } },
          {
            type: "tool-invocation",
            toolName: "bash",
            toolArgs: { command: "git status 2>/dev/null; ls >&2" },
          },
          { type: "tool-invocation", toolName: "apply_patch", toolArgs: { path: "a.txt" } },
          { type: "tool-invocation", toolName: "shell", content: "echo probe >> README.md" },
          {
            type: "tool-invocation",
            toolName: "exec_command",
            toolArgs: { cmd: ["git", "push", "origin", "HEAD"] },
          },
          { type: "tool-invocation", toolName: "Read", toolArgs: { file_path: "README.md" } },
          { type: "tool-invocation", toolName: "TodoWrite", toolArgs: {} },
        ],
      },
    ];
    expect(graphProfilesAttempts(messages)).toEqual({
      toolCalls: 7,
      writes: 2,
      commits: 0,
      pushes: 1,
    });
  });
});
