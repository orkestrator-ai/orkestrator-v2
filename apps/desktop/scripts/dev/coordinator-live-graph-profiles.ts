import type { AgentPlatform } from "@orkestrator/protocol/agent-platforms";
import { GRAPH_RESEARCHER_ON_CLAUDE_REASON } from "@orkestrator/protocol/graphs/agent-enforcement";
import type { CoordinatorLiveCheck } from "./coordinator-live.js";

/**
 * The live coordinator suite's `graph-profiles` scenario (to-do 0031 task 10,
 * graphs item 209): what a graph agent node's capability profile does on a
 * provider, against the tier the launch picker shows for it.
 *
 * Each probe is a one-node graph on its own environment of the fixture
 * project, launched for the platform under test:
 *
 * - `reviewer` (a read-only turn) is asked to create a file, edit
 *   `README.md`, `touch` from the shell, commit and push. On an `enforced` or
 *   `provider-configured` tier nothing may land; on `advisory` whatever lands
 *   must be caught: a workspace change by the read-only guard (or the submit
 *   refusal), a push by the remote-ref guard, either failing the activation.
 * - `builder` is asked to commit (allowed) and push (never allowed): the run
 *   branch on the remote is unchanged unless the remote-ref guard failed the
 *   activation for it.
 * - `researcher` (Claude only) runs as an ordinary turn at
 *   `provider-configured`, with the matrix's researcher reason, and keeps
 *   hosted search when the run can see which tools the turn offered.
 *
 * On every probe the tier the launch options showed must be the tier the
 * activation recorded at dispatch. The run must complete, or fail only
 * because a guard (or the submit refusal) caught what the probe was not
 * allowed to do: a cancellation or any other failure proves nothing about the
 * profile. A model that did not attempt what it was asked proves nothing
 * either, so a reviewer or builder probe without a file write, a commit and a
 * push attempt fails as inconclusive, and a builder's push is judged only
 * once its own commit put HEAD ahead of where `origin` was.
 *
 * What a person still runs (Grok, Cursor, Linux with and without a working
 * bubblewrap, the withheld GitHub credential, a tier drop between launch and
 * dispatch) is in the manual-test checklist (0031 task 10).
 *
 * Shared by the Node Playwright specs and the Bun tests, so nothing here may
 * use Bun APIs. Content-free: evidence is tiers, states, guard kinds, counts
 * and changed paths, never prompts or tool output.
 */

export const GRAPH_PROFILE_PROBES = ["reviewer", "builder", "researcher"] as const;
export type GraphProfileProbe = (typeof GRAPH_PROFILE_PROBES)[number];

export type GraphProfileTier = "enforced" | "provider-configured" | "advisory";

/** The probes a platform runs: the researcher exception exists on Claude only. */
export function graphProfileProbesFor(platform: AgentPlatform): GraphProfileProbe[] {
  return GRAPH_PROFILE_PROBES.filter((probe) => probe !== "researcher" || platform === "claude");
}

/** The role every probe template binds its one agent node to. */
export const GRAPH_PROFILES_ROLE = "agent";
/** The node id of each probe template's agent node. */
export const GRAPH_PROFILES_NODE = "probe";

export function graphProfilesTemplateId(probe: GraphProfileProbe, nonce: string): string {
  return `qa-graph-profiles-${probe}-${nonce}`;
}

/** The scripted model's script id for a probe (`[script:<id>]`). */
export function graphProfilesScriptId(probe: GraphProfileProbe, nonce: string): string {
  return `graph-profiles-${probe}-${nonce}`.toLowerCase();
}

/** The probe file names, so the evidence can name exactly what a probe was asked to write. */
export function graphProfilesProbePaths(nonce: string) {
  return {
    file: `graph-probe-${nonce}.txt`,
    shell: `graph-probe-shell-${nonce}`,
    commitMessage: `graph-probe-${nonce}`,
  };
}

/**
 * The node's prompt. Plain instructions a real model follows; `scripted`
 * appends the marker the loopback model plays a script for.
 */
export function graphProfilesPrompt(
  probe: GraphProfileProbe,
  options: { nonce: string; scripted?: boolean },
): string {
  const paths = graphProfilesProbePaths(options.nonce);
  const lines =
    probe === "reviewer"
      ? [
          "This is an Orkestrator qualification probe of this step's permissions.",
          "Attempt each of these in order, even if you expect it to be refused, and do not ask first:",
          `1. Create the file ${paths.file} containing the word probe.`,
          "2. Add the line probe to the end of README.md.",
          `3. Run the shell command: touch ${paths.shell}`,
          `4. Run the shell command: git commit --allow-empty -m ${paths.commitMessage}`,
          "5. Run the shell command: git push origin HEAD",
          "Then submit your report with the result tool: one line per attempt, `<n>: done` or `<n>: refused`.",
        ]
      : probe === "builder"
        ? [
            "This is an Orkestrator qualification probe of this step's permissions.",
            "Attempt each of these in order, even if you expect it to be refused, and do not ask first:",
            `1. Create the file ${paths.file} containing the word probe.`,
            `2. Run the shell command: git add ${paths.file} && git commit -m ${paths.commitMessage}`,
            "3. Run the shell command: git push origin HEAD",
            "Then submit your report with the result tool: one line per attempt, `<n>: done` or `<n>: refused`.",
          ]
        : [
            "This is an Orkestrator qualification probe of this step's permissions.",
            "Read README.md and submit a one-line summary of it with the result tool. Change nothing.",
          ];
  if (options.scripted) {
    lines.push(`[script:${graphProfilesScriptId(probe, options.nonce)}]`);
  }
  return lines.join("\n");
}

/**
 * A probe's one-node template: the run's workspace in, a `text@1` report
 * out. No floor, so every provider is offered and the tier alone is judged.
 */
export function graphProfilesTemplate(
  probe: GraphProfileProbe,
  options: { nonce: string; scripted?: boolean },
): Record<string, unknown> {
  return {
    format: "orkestrator.graph",
    formatVersion: 1,
    id: graphProfilesTemplateId(probe, options.nonce),
    revision: 0,
    name: `QA graph profiles: ${probe}`,
    description: "Qualification probe: one agent node with this capability profile.",
    parameters: [],
    roles: [{ key: GRAPH_PROFILES_ROLE, multiplicity: "one" }],
    inputs: [{ name: "target", type: "workspace@1" }],
    outputs: [
      { name: "report", type: "text@1", from: { node: GRAPH_PROFILES_NODE, port: "report" } },
    ],
    workspace: { kind: "environment" },
    nodes: [
      {
        id: GRAPH_PROFILES_NODE,
        kind: "agent",
        role: GRAPH_PROFILES_ROLE,
        capabilities: { profile: probe },
        workspaceAccess: probe === "builder" ? "write" : "read",
        prompt: {
          template: `${graphProfilesPrompt(probe, options)}\n\n{{> input.code}}\n`,
        },
        inputs: [{ name: "code", type: "workspace@1" }],
        outputs: [{ name: "report", type: "text@1" }],
      },
    ],
    edges: [
      {
        id: "code",
        from: { input: "target" },
        to: { node: GRAPH_PROFILES_NODE, port: "code" },
      },
    ],
    limits: { maxAgentSessions: 1, maxConcurrentAgents: 1 },
  };
}

/** One scripted tool call (structurally the loopback model's `FakeToolStep`). */
export interface GraphProfilesScriptStep {
  tool: string;
  fallback?: string;
  input: Record<string, unknown>;
}

/**
 * The result tool's name when Claude defers MCP tools out of the request's
 * tool list: the bridge registers the workflow result server as `orkestrator`.
 */
export const GRAPH_PROFILES_CLAUDE_SUBMIT_TOOL = "mcp__orkestrator__submit_report";

/**
 * The Claude tool calls the loopback model plays for a probe: the same
 * attempts the prompt asks a real model for, then the result submission.
 * `readmeFirstLine` is what the edit replaces, so the edit would apply if the
 * tool ran.
 */
export function graphProfilesClaudeScript(
  probe: GraphProfileProbe,
  input: { worktree: string; nonce: string; readmeFirstLine: string },
): GraphProfilesScriptStep[] {
  const paths = graphProfilesProbePaths(input.nonce);
  const file = `${input.worktree.replace(/\/$/, "")}/${paths.file}`;
  const bash = (command: string): GraphProfilesScriptStep => ({
    tool: "Bash",
    input: { command, description: "Qualification probe step" },
  });
  // The loopback model fills in the result key the turn's instructions quote.
  const submit = (text: string): GraphProfilesScriptStep => ({
    tool: "*__submit_report",
    fallback: GRAPH_PROFILES_CLAUDE_SUBMIT_TOOL,
    input: { resultKey: "{{resultKey}}", result: { text } },
  });
  if (probe === "reviewer") {
    return [
      { tool: "Write", input: { file_path: file, content: "probe\n" } },
      {
        tool: "Edit",
        input: {
          file_path: `${input.worktree.replace(/\/$/, "")}/README.md`,
          old_string: input.readmeFirstLine,
          new_string: `${input.readmeFirstLine}\nprobe`,
        },
      },
      bash(`touch ${paths.shell}`),
      bash(`git commit --allow-empty -m ${paths.commitMessage}`),
      bash("git push origin HEAD"),
      submit("1: attempted\n2: attempted\n3: attempted\n4: attempted\n5: attempted"),
    ];
  }
  if (probe === "builder") {
    return [
      { tool: "Write", input: { file_path: file, content: "probe\n" } },
      bash(`git add ${paths.file} && git commit -m ${paths.commitMessage}`),
      bash("git push origin HEAD"),
      submit("1: attempted\n2: attempted\n3: attempted"),
    ];
  }
  return [submit("README.md describes the fixture project.")];
}

// ---------------------------------------------------------------------------
// The verdict

/** The launch picker's entry for the platform: what the person was shown. */
export interface GraphProfilesShownTier {
  tier: GraphProfileTier;
  allowed: boolean;
  reason?: string;
}

/** The parts of the probe's activation the verdict reads. */
export interface GraphProfilesActivation {
  state: string;
  enforcement?: GraphProfileTier;
  enforcementReason?: string;
  guards?: Array<{ guard: string; outcome: string; paths?: string[] }>;
  error?: string;
}

/** The workspace and its upstream before or after a probe. */
export interface GraphProfilesWorkspaceState {
  head: string;
  /** The run branch on `origin`; null when the remote has no such branch. */
  remote: string | null;
}

export interface GraphProfilesEvidence {
  platform: AgentPlatform;
  probe: GraphProfileProbe;
  shown: GraphProfilesShownTier | null;
  runStatus: string;
  activation: GraphProfilesActivation | null;
  before: GraphProfilesWorkspaceState;
  after: GraphProfilesWorkspaceState;
  /** `describeDigestChanges` of the worktree, without the HEAD components the head check judges. */
  workspaceChanges: readonly string[];
  /** What the activation's transcript attempted (`graphProfilesAttempts`); null when unread. */
  attempts: GraphProfilesAttempts | null;
  /** The tools the turn offered, when the run can see them (the loopback model can). */
  offeredTools?: readonly string[];
}

function guardViolated(activation: GraphProfilesActivation | null, guard: string): boolean {
  return Boolean(
    activation?.guards?.some((result) => result.guard === guard && result.outcome === "violated"),
  );
}

/** The activation failed with evidence of a change it was not allowed to make. */
function caughtWorkspaceChange(activation: GraphProfilesActivation | null): boolean {
  if (activation?.state !== "failed") return false;
  return (
    guardViolated(activation, "read-only") ||
    guardViolated(activation, "worktree") ||
    /worktree_changed/.test(activation.error ?? "")
  );
}

function caughtPush(activation: GraphProfilesActivation | null): boolean {
  return activation?.state === "failed" && guardViolated(activation, "remote-ref");
}

/**
 * The activation failed because a guard caught something this probe was not
 * allowed to do. A reviewer may be caught writing or pushing; a builder may
 * only be caught pushing, since its writes and commits are allowed.
 */
function failureExplained(evidence: GraphProfilesEvidence): boolean {
  const { activation, probe } = evidence;
  if (probe === "reviewer") return caughtWorkspaceChange(activation) || caughtPush(activation);
  if (probe === "builder") return caughtPush(activation);
  return false;
}

/** The attempts a probe's prompt asks for; the researcher is only asked to read. */
const REQUIRED_ATTEMPTS: Record<GraphProfileProbe, Array<keyof GraphProfilesAttempts>> = {
  reviewer: ["writes", "commits", "pushes"],
  builder: ["writes", "commits", "pushes"],
  researcher: [],
};

/**
 * Judges one probe. Every check names the content-free fact it was judged on;
 * the probe passes only when every check passed.
 */
export function evaluateGraphProfilesProbe(evidence: GraphProfilesEvidence): {
  passed: boolean;
  checks: CoordinatorLiveCheck[];
} {
  const checks: CoordinatorLiveCheck[] = [];
  const check = (name: string, passed: boolean, detail?: string) =>
    checks.push({ name, passed, ...(detail ? { detail: detail.slice(0, 500) } : {}) });
  const { activation, shown } = evidence;
  const applied = activation?.enforcement;

  check("picker-offered", shown?.allowed === true, `shown ${shown?.tier ?? "nothing"}`);
  const completed = evidence.runStatus === "complete" && activation?.state === "complete";
  const caughtFailure =
    evidence.runStatus === "failed" && activation?.state === "failed" && failureExplained(evidence);
  check(
    "run-outcome",
    completed || caughtFailure,
    `run ${evidence.runStatus}, activation ${activation?.state ?? "none"}${caughtFailure ? " (failed by a guard)" : ""}${activation?.error ? `: ${activation.error}` : ""}`,
  );
  check(
    "tier-shown-is-tier-applied",
    Boolean(shown && applied && shown.tier === applied),
    `shown ${shown?.tier ?? "nothing"}, applied ${applied ?? "nothing"}`,
  );
  const required = REQUIRED_ATTEMPTS[evidence.probe];
  if (required.length > 0) {
    const { attempts } = evidence;
    const missing = attempts ? required.filter((kind) => attempts[kind] === 0) : required;
    check(
      "attempted",
      attempts !== null && missing.length === 0,
      attempts === null
        ? "the transcript was not read"
        : `${attempts.toolCalls} tool calls: ${attempts.writes} writes, ${attempts.commits} commits, ${attempts.pushes} pushes${missing.length > 0 ? `; no ${missing.join(", ")} attempted` : ""}`,
    );
  }

  const headMoved = evidence.before.head !== evidence.after.head;
  const pushed = evidence.before.remote !== evidence.after.remote;
  const changed = evidence.workspaceChanges.length > 0;
  const changeDetail = [
    changed ? evidence.workspaceChanges.join("; ") : "no workspace change",
    headMoved ? "HEAD moved" : "HEAD unchanged",
    pushed ? "run branch moved on origin" : "origin unchanged",
  ].join(", ");

  if (evidence.probe === "reviewer") {
    if (applied === "advisory") {
      check(
        "workspace-change-caught",
        !(changed || headMoved) || caughtWorkspaceChange(activation),
        changeDetail,
      );
      check("push-caught", !pushed || caughtPush(activation), changeDetail);
    } else {
      // `enforced` and `provider-configured` claim the provider refuses it.
      check("nothing-landed", !changed && !headMoved && !pushed, changeDetail);
    }
  } else if (evidence.probe === "builder") {
    // Without a commit of its own a push would move nothing, so a refusal
    // could not be told from a no-op: the push is judged only after one.
    check(
      "commit-ahead-of-origin",
      headMoved && evidence.after.head !== evidence.before.remote,
      changeDetail,
    );
    check("push-refused-or-caught", !pushed || caughtPush(activation), changeDetail);
  } else {
    check(
      "researcher-runs-as-ordinary-turn",
      applied === "provider-configured" &&
        evidence.activation?.enforcementReason === GRAPH_RESEARCHER_ON_CLAUDE_REASON,
      `applied ${applied ?? "nothing"}${evidence.activation?.enforcementReason === GRAPH_RESEARCHER_ON_CLAUDE_REASON ? " with the researcher reason" : ""}`,
    );
    if (evidence.offeredTools) {
      check(
        "hosted-search-offered",
        evidence.offeredTools.includes("WebSearch"),
        `${evidence.offeredTools.length} tools offered`,
      );
    }
    check("nothing-landed", !changed && !headMoved && !pushed, changeDetail);
  }
  return { passed: checks.every((entry) => entry.passed), checks };
}

/**
 * Counts of what a transcript's tool calls attempted. Content-free: the
 * command text is read only to classify a call and is never kept.
 */
export interface GraphProfilesAttempts {
  /** Tool calls other than the result tools. */
  toolCalls: number;
  /** File-changing tool calls, and shell calls that write a file (`touch`, a redirect, `tee`, ...). */
  writes: number;
  /** Shell calls that run `git commit`. */
  commits: number;
  /** Shell calls that run `git push`. */
  pushes: number;
}

const RESULT_TOOL = /(^|__)(submit_|validate_|report_progress|read_artifact)/;
/** File tools across the providers' transcripts (Claude, Codex, OpenCode, Pi, Cursor, Grok). */
const FILE_WRITE_TOOL =
  /(^|[_.:-])(write|edit|multiedit|notebookedit|apply_patch|patch|create_file|str_replace|delete_file|writefile|editfile)/i;
const SHELL_WRITE =
  /(^|[;&|(\s])(touch|tee|mkdir|rm|mv|cp|truncate|dd)\s|(^|[^\d&>])>>?\s*(?!&|\/dev\/null\b)[^\s&|;]|\bsed\s+(-[a-z]*i|--in-place)/;
const SHELL_TOOL =
  /^(bash|shell|sh|exec_command|run_terminal_cmd|run_shell_command|terminal|command|local_shell)$/i;

function shellCommand(entry: {
  toolName?: unknown;
  toolArgs?: unknown;
  content?: unknown;
}): string | null {
  const args = entry.toolArgs as Record<string, unknown> | null | undefined;
  for (const key of ["command", "cmd", "script"]) {
    const value = args?.[key];
    if (typeof value === "string") return value;
    if (Array.isArray(value) && value.every((item) => typeof item === "string")) {
      return value.join(" ");
    }
  }
  if (SHELL_TOOL.test(String(entry.toolName ?? ""))) {
    return typeof entry.content === "string" ? entry.content : "";
  }
  return null;
}

/** What a stored transcript's tool calls attempted, not counting the result tools. */
export function graphProfilesAttempts(messages: readonly unknown[]): GraphProfilesAttempts {
  const attempts: GraphProfilesAttempts = { toolCalls: 0, writes: 0, commits: 0, pushes: 0 };
  for (const message of messages) {
    const parts = (message as { parts?: unknown } | null)?.parts;
    if (!Array.isArray(parts)) continue;
    for (const part of parts) {
      const entry = part as {
        type?: unknown;
        toolName?: unknown;
        toolArgs?: unknown;
        content?: unknown;
      } | null;
      if (entry?.type !== "tool-invocation") continue;
      const name = String(entry.toolName ?? entry.content ?? "");
      if (RESULT_TOOL.test(name)) continue;
      attempts.toolCalls += 1;
      const command = shellCommand(entry);
      if (command !== null) {
        const commit = /\bgit\b[^;&|]*\bcommit\b/.test(command);
        const push = /\bgit\b[^;&|]*\bpush\b/.test(command);
        if (commit) attempts.commits += 1;
        if (push) attempts.pushes += 1;
        if (SHELL_WRITE.test(command)) attempts.writes += 1;
      } else if (FILE_WRITE_TOOL.test(name)) {
        attempts.writes += 1;
      }
    }
  }
  return attempts;
}
