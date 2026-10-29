/**
 * The remote-ref guard's attribution of a byte-identical commit against real
 * Git (item 209; slow tier by name). Two environments of one project make
 * the same commit in the same second and one of them pushes it, as two
 * builders did in the 2026-10-29 live run. With separate clones (container
 * environments) the push is attributed to the pusher alone; with two
 * worktrees of one repository (local environments) Git shares the record of
 * the push, so both fail closed and say why.
 */
import { afterEach, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { GraphActivationBaseline } from "@orkestrator/protocol/graphs/run";
import { GraphAgentGuardError, GraphAgentGuards } from "./graph-agent-guards.js";
import type { GraphGuardPeer } from "./graph-agent-remote-attribution.js";
import { graphEnvironmentFixture } from "./graph-run-test-support.js";
import type { Environment } from "./models.js";
import { runCommand } from "./shell.js";

const roots: string[] = [];
const builder = { id: "build", label: "Build", workspaceAccess: "write" as const };

afterEach(async () => {
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

/** Git with no user or system configuration (no hooks, signing or helpers). */
async function git(cwd: string, args: string[], env: Record<string, string> = {}): Promise<string> {
  return (
    await runCommand("git", args, {
      cwd,
      timeoutMs: 30_000,
      env: {
        ...process.env,
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_TERMINAL_PROMPT: "0",
        ...env,
      },
    })
  ).stdout.trim();
}

/** A bare `origin` with one commit on `main`, and two checkouts of it. */
async function project(layout: "clones" | "worktrees"): Promise<{ a: string; b: string }> {
  const root = await fs.mkdtemp(path.join(tmpdir(), "orkestrator-graph-attribution-"));
  roots.push(root);
  const origin = path.join(root, "origin.git");
  const a = path.join(root, "a");
  const b = path.join(root, "b");
  await git(root, ["init", "-q", "--bare", "-b", "main", origin]);
  await git(root, ["clone", "-q", origin, a]);
  await git(a, ["config", "user.email", "agent@example.invalid"]);
  await git(a, ["config", "user.name", "Agent"]);
  await fs.writeFile(path.join(a, "README.md"), "base\n");
  await git(a, ["add", "README.md"]);
  // Made well before any step started, as a project's history is.
  const anHourAgo = `@${Math.floor(Date.now() / 1000) - 3_600} +0000`;
  await git(a, ["commit", "-q", "-m", "base"], {
    GIT_AUTHOR_DATE: anHourAgo,
    GIT_COMMITTER_DATE: anHourAgo,
  });
  await git(a, ["push", "-q", "origin", "main"]);
  await git(a, ["switch", "-q", "-c", "env-a"]);
  if (layout === "clones") {
    await git(root, ["clone", "-q", origin, b]);
    await git(b, ["config", "user.email", "agent@example.invalid"]);
    await git(b, ["config", "user.name", "Agent"]);
    await git(b, ["switch", "-q", "-c", "env-b"]);
  } else {
    await git(a, ["worktree", "add", "-q", "-b", "env-b", b, "main"]);
  }
  return { a, b };
}

/** The same change on the same parent, by the same identity, in the same second. */
async function commitIdentically(checkout: string, seconds: number): Promise<string> {
  await fs.writeFile(path.join(checkout, "builder-probe.txt"), "probe\n");
  await git(checkout, ["add", "builder-probe.txt"]);
  const date = `@${seconds} +0000`;
  await git(checkout, ["commit", "-q", "-m", "Add builder probe"], {
    GIT_AUTHOR_DATE: date,
    GIT_COMMITTER_DATE: date,
  });
  return git(checkout, ["rev-parse", "HEAD"]);
}

async function scenario(layout: "clones" | "worktrees") {
  const { a, b } = await project(layout);
  const checkouts = new Map([
    ["e1", a],
    ["e2", b],
  ]);
  const environments = {
    a: graphEnvironmentFixture({ id: "e1", branch: "env-a", worktreePath: a }) as Environment,
    b: graphEnvironmentFixture({ id: "e2", branch: "env-b", worktreePath: b }) as Environment,
  };
  const peers = new Map<string, GraphGuardPeer[]>();
  const guards = new GraphAgentGuards({
    probe: async (id) => ({
      status: "clean",
      head: await git(checkouts.get(id)!, ["rev-parse", "HEAD"]),
    }),
    git: (id, args) => git(checkouts.get(id)!, args),
    lsRemote: (environment, args) => git(checkouts.get(environment.id)!, ["ls-remote", ...args]),
    systemPushes: async () => new Set(),
    peers: async ({ runId }) => peers.get(runId) ?? [],
  });
  const baselineA = await guards.capture(environments.a, builder);
  const baselineB = await guards.capture(environments.b, builder);
  const asPeer = (label: string, environmentId: string, baseline: GraphActivationBaseline) => ({
    label,
    environmentId,
    baseline: { ...baseline, capturedAt: baseline.capturedAt! },
  });
  peers.set("run-a", [asPeer("step build of run run-b", "e2", baselineB)]);
  peers.set("run-b", [asPeer("step build of run run-a", "e1", baselineA)]);

  const seconds = Math.floor(Date.now() / 1000);
  const commitA = await commitIdentically(a, seconds);
  const commitB = await commitIdentically(b, seconds);
  expect(commitA).toBe(commitB);
  // Only `b` pushes, to a new branch (its own run branch is untouched).
  await git(b, ["push", "-q", "origin", "HEAD:refs/heads/qa-builder-probe"]);

  const certify = async (
    environment: Environment,
    runId: string,
    baseline: GraphActivationBaseline,
  ) => {
    try {
      return {
        results: await guards.certify({ environment, node: builder, baseline, runId }),
        error: undefined,
      };
    } catch (error) {
      if (!(error instanceof GraphAgentGuardError)) throw error;
      return { results: error.results, error };
    }
  };
  return {
    a: await certify(environments.a, "run-a", baselineA),
    b: await certify(environments.b, "run-b", baselineB),
  };
}

test("separate clones: only the activation that pushed the identical commit is failed", async () => {
  const { a, b } = await scenario("clones");
  expect(a.error).toBeUndefined();
  expect(a.results[0]).toMatchObject({ guard: "remote-ref", outcome: "passed" });
  expect(a.results[0]?.detail).toContain("identical commit that step build of run run-b pushed");
  expect(b.results[0]).toMatchObject({ guard: "remote-ref", outcome: "violated" });
  expect(b.error?.message).toContain("origin refs/heads/qa-builder-probe");
});

test("worktrees of one repository: both fail closed as ambiguous, naming why", async () => {
  const { a, b } = await scenario("worktrees");
  for (const side of [a, b]) {
    expect(side.results[0]).toMatchObject({ guard: "remote-ref", outcome: "unavailable" });
    expect(side.error?.message).toContain("cannot be attributed (ambiguous)");
    expect(side.error?.message).toContain("worktrees of one repository");
  }
});
