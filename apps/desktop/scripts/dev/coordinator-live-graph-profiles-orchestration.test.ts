import { describe, expect, test } from "bun:test";
import type { FixtureTreeDigest } from "./coordinator-live.js";
import {
  runGraphProfilesProbe,
  shownTierFor,
  type GraphProfilesWorkspace,
} from "./coordinator-live-graph-profiles-orchestration.js";
import { graphProfilesTemplateId } from "./coordinator-live-graph-profiles.js";

function tree(files: Record<string, string>): FixtureTreeDigest {
  return {
    digest: JSON.stringify(files),
    files,
    components: {},
  } as unknown as FixtureTreeDigest;
}

/** A worktree whose state moves to `after` once the run has been read as settled. */
function workspace(
  before: { files: Record<string, string>; head: string; remote: string | null },
  after: { files: Record<string, string>; head: string; remote: string | null },
  settled: () => boolean,
): GraphProfilesWorkspace {
  return {
    tree: async () => tree(settled() ? after.files : before.files),
    state: async () =>
      settled()
        ? { head: after.head, remote: after.remote }
        : { head: before.head, remote: before.remote },
  };
}

function scriptedInvoke(options: {
  tier: string;
  allowed?: boolean;
  activation: Record<string, unknown>;
  runStatuses: string[];
  transcript?: unknown[];
}) {
  const calls: Array<{ command: string; args: Record<string, unknown> }> = [];
  let reads = 0;
  const invoke = async <T>(command: string, args: Record<string, unknown> = {}): Promise<T> => {
    calls.push({ command, args });
    switch (command) {
      case "graph_template_save":
        return { template: { revision: 1 } } as T;
      case "graph_launch_options":
        return {
          roles: [
            {
              role: { key: "agent" },
              providers: [
                { platform: "codex", tier: "enforced", allowed: true, available: true },
                {
                  platform: "claude",
                  tier: options.tier,
                  allowed: options.allowed ?? true,
                  available: true,
                },
              ],
            },
          ],
        } as T;
      case "graph_run_launch":
        return { runId: "run-1" } as T;
      case "graph_run_get": {
        const status = options.runStatuses[Math.min(reads, options.runStatuses.length - 1)]!;
        reads += 1;
        return {
          status: "changed",
          run: {
            status,
            activations: [
              { key: "old", nodeId: "probe", state: "superseded" },
              { key: "probe#1", nodeId: "probe", ...options.activation },
            ],
          },
        } as T;
      }
      case "graph_run_transcript":
        return { status: "found", messages: options.transcript ?? [] } as T;
      default:
        return {} as T;
    }
  };
  return { invoke, calls, settled: () => reads >= options.runStatuses.length };
}

describe("runGraphProfilesProbe", () => {
  test("launches on the existing environment, reads the settled activation and judges it", async () => {
    const transport = scriptedInvoke({
      tier: "enforced",
      activation: { state: "complete", enforcement: "enforced", guards: [] },
      runStatuses: ["running", "complete"],
      transcript: [
        {
          parts: [
            { type: "tool-invocation", toolName: "Write", toolArgs: { file_path: "probe.txt" } },
            { type: "tool-invocation", toolName: "Bash", toolArgs: { command: "git commit -m p" } },
            { type: "tool-invocation", toolName: "Bash", toolArgs: { command: "git push" } },
          ],
        },
      ],
    });
    const unchanged = { files: { "README.md": "1" }, head: "h1", remote: "r1" };
    const result = await runGraphProfilesProbe({
      invoke: transport.invoke,
      projectId: "project-1",
      environmentId: "env-1",
      workspace: workspace(unchanged, unchanged, transport.settled),
      platform: "claude",
      probe: "reviewer",
      nonce: "n1",
      model: "haiku",
      pollIntervalMs: 1,
      sleep: async () => undefined,
    });
    expect(result.passed).toBe(true);
    expect(result.runId).toBe("run-1");
    expect(result.evidence).toMatchObject({
      shown: { tier: "enforced", allowed: true },
      runStatus: "complete",
      activation: { state: "complete", enforcement: "enforced" },
      attempts: { toolCalls: 3, writes: 1, commits: 1, pushes: 1 },
      workspaceChanges: [],
    });
    expect(Object.keys(result.evidence.activation ?? {})).not.toContain("key");
    const commands = transport.calls.map((call) => call.command);
    expect(commands).toEqual([
      "graph_template_save",
      "graph_launch_options",
      "graph_run_launch",
      "graph_run_get",
      "graph_run_get",
      "graph_run_transcript",
      "graph_template_delete",
    ]);
    const launch = transport.calls.find((call) => call.command === "graph_run_launch")!.args;
    expect(launch).toMatchObject({
      ref: { scope: "user", id: graphProfilesTemplateId("reviewer", "n1") },
      environment: { kind: "existing", environmentId: "env-1" },
      roles: { agent: { platform: "claude", model: "haiku" } },
      requestId: "qa-graph-profiles-reviewer-n1",
    });
    expect(transport.calls.at(-1)!.args).toEqual({
      id: graphProfilesTemplateId("reviewer", "n1"),
      expectedRevision: 1,
    });
    expect(transport.calls.find((call) => call.command === "graph_run_transcript")!.args).toEqual({
      runId: "run-1",
      activationKey: "probe#1",
    });
  });

  test("a change that landed on an enforced reviewer fails the probe", async () => {
    const transport = scriptedInvoke({
      tier: "enforced",
      activation: { state: "complete", enforcement: "enforced" },
      runStatuses: ["complete"],
      transcript: [{ parts: [{ type: "tool-invocation", toolName: "Write" }] }],
    });
    const result = await runGraphProfilesProbe({
      invoke: transport.invoke,
      projectId: "project-1",
      environmentId: "env-1",
      workspace: workspace(
        { files: { "README.md": "1" }, head: "h1", remote: null },
        { files: { "README.md": "1", "graph-probe-n1.txt": "2" }, head: "h1", remote: null },
        transport.settled,
      ),
      platform: "claude",
      probe: "reviewer",
      nonce: "n1",
      sleep: async () => undefined,
    });
    expect(result.passed).toBe(false);
    expect(result.checks.find((check) => check.name === "nothing-landed")).toMatchObject({
      passed: false,
      detail: expect.stringContaining("+graph-probe-n1.txt"),
    });
  });

  test("a provider the picker does not offer is not launched, and the template is still deleted", async () => {
    const transport = scriptedInvoke({
      tier: "advisory",
      allowed: false,
      activation: {},
      runStatuses: ["complete"],
    });
    const same = { files: {}, head: "h1", remote: null };
    const result = await runGraphProfilesProbe({
      invoke: transport.invoke,
      projectId: "project-1",
      environmentId: "env-1",
      workspace: workspace(same, same, () => true),
      platform: "claude",
      probe: "builder",
      nonce: "n2",
    });
    expect(result.passed).toBe(false);
    expect(result.evidence.runStatus).toBe("not launched");
    expect(transport.calls.map((call) => call.command)).toEqual([
      "graph_template_save",
      "graph_launch_options",
      "graph_template_delete",
    ]);
  });

  test("a run that never settles is cancelled at the deadline", async () => {
    const transport = scriptedInvoke({
      tier: "enforced",
      activation: { state: "running", enforcement: "enforced" },
      runStatuses: ["running", "running", "running", "running"],
    });
    const same = { files: {}, head: "h1", remote: null };
    const result = await runGraphProfilesProbe({
      invoke: transport.invoke,
      projectId: "project-1",
      environmentId: "env-1",
      workspace: workspace(same, same, () => true),
      platform: "claude",
      probe: "reviewer",
      nonce: "n3",
      timeoutMs: 0,
      sleep: async () => undefined,
    });
    expect(transport.calls.map((call) => call.command)).toContain("graph_run_cancel");
    expect(result.checks.find((check) => check.name === "run-outcome")?.passed).toBe(false);
  });
});

describe("shownTierFor", () => {
  test("reads the platform's entry for the probe role; unavailable is not offered", () => {
    const options = {
      roles: [
        { role: { key: "other" }, providers: [{ platform: "claude", tier: "advisory" as const }] },
        {
          role: { key: "agent" },
          providers: [
            { platform: "claude", tier: "enforced" as const, allowed: true, available: false },
          ],
        },
      ],
    };
    expect(shownTierFor(options, "claude")).toEqual({ tier: "enforced", allowed: false });
    expect(shownTierFor(options, "codex")).toBeNull();
    expect(shownTierFor({}, "claude")).toBeNull();
  });
});
