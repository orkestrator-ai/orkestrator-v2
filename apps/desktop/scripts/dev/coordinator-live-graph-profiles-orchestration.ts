import { spawnSync } from "node:child_process";
import type { AgentPlatform } from "@orkestrator/protocol/agent-platforms";
import {
  describeDigestChanges,
  fixtureTreeDigest,
  type CoordinatorLiveCheck,
  type FixtureTreeDigest,
} from "./coordinator-live.js";
import {
  attemptedToolCalls,
  evaluateGraphProfilesProbe,
  GRAPH_PROFILES_NODE,
  GRAPH_PROFILES_ROLE,
  graphProfilesTemplate,
  graphProfilesTemplateId,
  type GraphProfileProbe,
  type GraphProfilesActivation,
  type GraphProfilesEvidence,
  type GraphProfilesShownTier,
  type GraphProfilesWorkspaceState,
} from "./coordinator-live-graph-profiles.js";

type Invoke = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;

/**
 * The `graph-profiles` scenario's backend orchestration, shared by the live
 * coordinator spec, the credential-free spec that runs it on Claude against
 * the loopback model, and the test that scripts the command transport. See
 * `coordinator-live-graph-profiles.ts` for what it qualifies.
 *
 * One probe: save its template, read the tier the launch picker shows,
 * snapshot the environment's worktree, HEAD and the run branch on `origin`,
 * launch the run on the existing environment, wait for it to settle, read the
 * activation and its transcript, snapshot again and judge. The template is
 * deleted afterwards; the environment belongs to the caller.
 */

/** Reads the worktree, HEAD and the run branch on `origin`. Injected by tests. */
export interface GraphProfilesWorkspace {
  tree(): Promise<FixtureTreeDigest>;
  state(): Promise<GraphProfilesWorkspaceState>;
}

/** A real worktree: digest, `git rev-parse HEAD` and `git ls-remote origin` for its branch. */
export function gitGraphProfilesWorkspace(worktree: string): GraphProfilesWorkspace {
  const git = (args: string[]) => {
    const result = spawnSync("git", ["-C", worktree, ...args], {
      encoding: "utf8",
      timeout: 60_000,
    });
    if (result.status !== 0) {
      throw new Error(`git ${args[0]} failed: ${(result.stderr ?? "").slice(0, 300)}`);
    }
    return result.stdout.trim();
  };
  return {
    tree: () => fixtureTreeDigest(worktree),
    async state() {
      const head = git(["rev-parse", "HEAD"]);
      const branch = git(["rev-parse", "--abbrev-ref", "HEAD"]);
      const line = git(["ls-remote", "origin", `refs/heads/${branch}`]);
      return { head, remote: line ? (line.split(/\s+/)[0] ?? null) : null };
    },
  };
}

type LaunchOptions = {
  roles?: Array<{
    role?: { key?: string };
    providers?: Array<{
      platform: string;
      tier: GraphProfilesShownTier["tier"];
      allowed?: boolean;
      available?: boolean;
      reason?: string;
    }>;
  }>;
};
type RunRead =
  | {
      status: "changed";
      run: {
        status: string;
        activations: Array<GraphProfilesActivation & { key: string; nodeId: string }>;
      };
    }
  | { status: "unchanged"; revision: number };

export interface GraphProfilesProbeResult {
  passed: boolean;
  checks: CoordinatorLiveCheck[];
  evidence: GraphProfilesEvidence;
  runId?: string;
}

/** The provider entry the launch picker shows for the probe's role. */
export function shownTierFor(
  options: LaunchOptions,
  platform: AgentPlatform,
): GraphProfilesShownTier | null {
  const role = options.roles?.find((entry) => entry.role?.key === GRAPH_PROFILES_ROLE);
  const provider = role?.providers?.find((entry) => entry.platform === platform);
  if (!provider) return null;
  return {
    tier: provider.tier,
    // Offered only when the floor allows it and the provider can return results.
    allowed: provider.allowed !== false && provider.available !== false,
    ...(provider.reason ? { reason: provider.reason.slice(0, 300) } : {}),
  };
}

export async function runGraphProfilesProbe(input: {
  invoke: Invoke;
  projectId: string;
  environmentId: string;
  workspace: GraphProfilesWorkspace;
  platform: AgentPlatform;
  probe: GraphProfileProbe;
  nonce: string;
  /** Appends the loopback model's script marker to the prompt. */
  scripted?: boolean;
  model?: string;
  /** Tools the turn offered, read after the run (the loopback model records them). */
  offeredTools?: () => readonly string[] | undefined;
  timeoutMs?: number;
  pollIntervalMs?: number;
  sleep?: (ms: number) => Promise<void>;
}): Promise<GraphProfilesProbeResult> {
  const { invoke, platform, probe, nonce } = input;
  const timeoutMs = input.timeoutMs ?? 10 * 60_000;
  const pollIntervalMs = input.pollIntervalMs ?? 2_000;
  const sleep = input.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  const templateId = graphProfilesTemplateId(probe, nonce);
  const ref = { scope: "user", id: templateId };
  const saved = await invoke<{ template?: { revision?: number }; revision?: number }>(
    "graph_template_save",
    {
      template: graphProfilesTemplate(probe, { nonce, scripted: input.scripted }),
      expectedRevision: 0,
    },
  );
  const savedRevision = saved?.template?.revision ?? saved?.revision;
  try {
    const options = await invoke<LaunchOptions>("graph_launch_options", {
      ref,
      projectId: input.projectId,
      environmentId: input.environmentId,
    });
    const shown = shownTierFor(options, platform);
    const treeBefore = await input.workspace.tree();
    const before = await input.workspace.state();
    let runStatus = "not launched";
    let activation: GraphProfilesActivation | null = null;
    let attempted: number | null = null;
    let runId: string | undefined;
    if (shown?.allowed) {
      const launched = await invoke<{ runId: string }>("graph_run_launch", {
        ref,
        projectId: input.projectId,
        environment: { kind: "existing", environmentId: input.environmentId },
        roles: {
          [GRAPH_PROFILES_ROLE]: { platform, ...(input.model ? { model: input.model } : {}) },
        },
        requestId: `qa-graph-profiles-${probe}-${nonce}`,
      });
      runId = launched.runId;
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const read = await invoke<RunRead>("graph_run_get", { runId });
        if (read.status === "changed") {
          runStatus = read.run.status;
          const latest = read.run.activations
            .filter((entry) => entry.nodeId === GRAPH_PROFILES_NODE && entry.state !== "superseded")
            .at(-1);
          activation = latest
            ? ({
                key: latest.key,
                state: latest.state,
                ...(latest.enforcement ? { enforcement: latest.enforcement } : {}),
                ...(latest.enforcementReason
                  ? { enforcementReason: latest.enforcementReason }
                  : {}),
                ...(latest.guards
                  ? {
                      guards: latest.guards.map((guard) => ({
                        guard: guard.guard,
                        outcome: guard.outcome,
                        ...(guard.paths ? { paths: guard.paths.slice(0, 32) } : {}),
                      })),
                    }
                  : {}),
                ...(latest.error ? { error: latest.error.slice(0, 500) } : {}),
              } as GraphProfilesActivation & { key: string })
            : null;
          if (["complete", "failed", "cancelled"].includes(runStatus)) break;
        }
        if (Date.now() >= deadline) {
          await invoke("graph_run_cancel", { runId }).catch(() => undefined);
          break;
        }
        await sleep(pollIntervalMs);
      }
      const key = (activation as { key?: string } | null)?.key;
      if (key) {
        const transcript = await invoke<{ status: string; messages?: unknown[] }>(
          "graph_run_transcript",
          { runId, activationKey: key },
        ).catch(() => null);
        if (transcript?.status === "found")
          attempted = attemptedToolCalls(transcript.messages ?? []);
      }
    }
    const after = await input.workspace.state();
    const treeAfter = await input.workspace.tree();
    // HEAD moves are judged by the head check; the digest lists only file changes.
    const workspaceChanges = describeDigestChanges(treeBefore, treeAfter).filter((change) =>
      change.startsWith("files "),
    );
    const offeredTools = input.offeredTools?.();
    const evidence: GraphProfilesEvidence = {
      platform,
      probe,
      shown,
      runStatus,
      activation: activation
        ? (({ key: _key, ...rest }) => rest)(
            activation as GraphProfilesActivation & { key?: string },
          )
        : null,
      before,
      after,
      workspaceChanges,
      attemptedToolCalls: attempted,
      ...(offeredTools ? { offeredTools: [...offeredTools] } : {}),
    };
    return { ...evaluateGraphProfilesProbe(evidence), evidence, ...(runId ? { runId } : {}) };
  } finally {
    if (savedRevision !== undefined) {
      await invoke("graph_template_delete", {
        id: templateId,
        expectedRevision: savedRevision,
      }).catch(() => undefined);
    }
  }
}
