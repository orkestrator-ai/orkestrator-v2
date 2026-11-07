/**
 * Shared setup for the Phase 2 exit proof (plan item 2013): two running
 * `dev:test` profiles, the leaf attached to the command node, and a local
 * environment on the leaf for the harness's terminal.
 *
 * Gateway tokens are read from each profile's owner-only auth file into
 * memory and used only as bearers from this process (`add_node` needs the
 * leaf's); they are never printed, written or handed to a page.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

export const repositoryRoot = path.resolve(import.meta.dirname, "../..");

export const commandProfile = process.env.ORKESTRATOR_AGENT_TEST_PROFILE ?? "";
export const leafProfile = process.env.ORKESTRATOR_AGENT_TEST_LEAF_PROFILE ?? "";
/** Optional: a third running profile, attached as a second leaf for the two-leaf case. */
export const secondLeafProfile = process.env.ORKESTRATOR_AGENT_TEST_SECOND_LEAF_PROFILE ?? "";
export const runId = process.env.ORKESTRATOR_AGENT_TEST_RUN_ID ?? (commandProfile || "scope-proof");
export const evidenceDir = path.join(
  repositoryRoot,
  "output",
  "agent-testing",
  runId,
  "scope-proof",
);

export const SKIP_REASON =
  "Set ORKESTRATOR_AGENT_TEST_PROFILE and ORKESTRATOR_AGENT_TEST_LEAF_PROFILE to two running dev:test profiles.";

export interface ProfileStatus {
  status: string;
  browserUrl: string;
  authFile: string;
  testProject?: string;
}

export function profileStatus(profile: string): ProfileStatus {
  const command = spawnSync("mise", ["run", "dev:status", "--profile", profile, "--json"], {
    cwd: repositoryRoot,
    encoding: "utf8",
  });
  if (!command.stdout.trim()) throw new Error(command.stderr || "dev:status returned no manifest");
  const status = JSON.parse(command.stdout) as ProfileStatus;
  if (status.status !== "ready") throw new Error(`Profile ${profile} is ${status.status}.`);
  return status;
}

export function loginUrl(profile: string): string {
  const command = spawnSync("mise", ["run", "dev:login", "--profile", profile, "--json"], {
    cwd: repositoryRoot,
    encoding: "utf8",
  });
  if (command.status !== 0) throw new Error(command.stderr || "dev:login failed");
  const login = JSON.parse(command.stdout) as { loginUrl?: unknown };
  if (typeof login.loginUrl !== "string") throw new Error("dev:login returned no login URL");
  return login.loginUrl;
}

/** A profile's gateway, called from this process with its own token. */
export interface Gateway {
  readonly profile: string;
  readonly origin: string;
  invoke<T = unknown>(command: string, args?: Record<string, unknown>): Promise<T>;
  /** The gateway token, for `add_node` and an Electron connection. Never log it. */
  secret(): string;
}

export function gateway(profile: string): Gateway {
  const status = profileStatus(profile);
  const origin = new URL(status.browserUrl).origin;
  const secret = () =>
    (JSON.parse(readFileSync(status.authFile, "utf8")) as { token: string }).token;
  return {
    profile,
    origin,
    secret,
    async invoke<T>(command: string, args: Record<string, unknown> = {}): Promise<T> {
      const response = await fetch(`${origin}/__orkestrator/invoke`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${secret()}`,
          "content-type": "application/json",
          origin,
        },
        body: JSON.stringify({ command, args }),
      });
      const body = (await response.json().catch(() => ({}))) as { result?: T; error?: string };
      if (!response.ok)
        throw new Error(`${profile} ${command}: ${response.status} ${body.error ?? ""}`);
      return body.result as T;
    },
  };
}

type NodeView = { nodeId: string; displayName?: string; environments?: unknown[] };

/** Attaches the leaf to the command node (idempotent) and waits for its environments. */
export async function attachLeaf(command: Gateway, leaf: Gateway): Promise<{ nodeId: string }> {
  const { nodeId } = await leaf.invoke<{ nodeId: string }>("get_node_status");
  const listed = await command.invoke<{ nodes?: NodeView[] } | NodeView[]>("list_nodes");
  const nodes = Array.isArray(listed) ? listed : (listed.nodes ?? []);
  const routes = [{ id: "loopback", kind: "https", enabled: true, origin: leaf.origin }];
  if (nodes.some((node) => node.nodeId === nodeId)) {
    await command.invoke("update_node", { nodeId, routes, token: leaf.secret() });
  } else {
    await command.invoke("add_node", { routes, token: leaf.secret() });
  }
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    const summaries = await command.invoke<{ nodes: NodeView[] }>("get_node_summaries");
    if (summaries.nodes.some((node) => node.nodeId === nodeId)) return { nodeId };
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error("The command node never listed the attached leaf.");
}

type Environment = { id: string; status?: string; worktreePath?: string | null };

/** A local environment in the leaf's fixture project, ready for a terminal. */
export async function createLeafEnvironment(leaf: Gateway, name: string): Promise<Environment> {
  const projects = await leaf.invoke<Array<{ id: string }>>("get_projects");
  const project = projects[0];
  if (!project)
    throw new Error("The leaf profile has no fixture project (start it with --fixture).");
  const environment = await leaf.invoke<Environment>("create_environment", {
    projectId: project.id,
    name,
    environmentType: "local",
  });
  // A local environment gets its worktree when it starts.
  await leaf.invoke("start_environment", { environmentId: environment.id });
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    const current = await leaf.invoke<Environment>("get_environment", {
      environmentId: environment.id,
    });
    if (current.worktreePath && current.status === "running") return current;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error("The leaf environment never became ready.");
}

export async function deleteLeafEnvironment(leaf: Gateway, environmentId: string): Promise<void> {
  await leaf.invoke("delete_environment", { environmentId }).catch(() => undefined);
}

/** Writes one evidence file (ids, timings, counts; never a credential). */
export function writeEvidence(name: string, value: unknown): string {
  mkdirSync(evidenceDir, { recursive: true });
  const file = path.join(evidenceDir, `${name}.json`);
  writeFileSync(file, `${JSON.stringify(value, null, 1)}\n`);
  return file;
}

/** The harness's report, as `window.orkestratorScopeProof.run` returns it. */
export interface ScopeProofReport {
  host: "browser" | "desktop";
  commandNodeId: string;
  leafNodeId: string;
  openMs: number;
  route: { path: string | null; baseUrl: string | null; relayed: boolean } | null;
  openScopes: Array<{ nodeId: string; role: string }>;
  command: ScopeReport;
  leaf: ScopeReport;
  terminal: { opened: boolean; outputSeen: boolean; outputMs: number | null; error?: string };
  leafScopeOpenAfterRun: boolean;
}

interface ScopeReport {
  role: string;
  scopeNodeId: string;
  answeredBy: string | null;
  projects: number;
  resourceChanged: { received: boolean; seenByOtherScope: number; ms: number };
  connection: string;
}

/** The checks every run must pass, whatever the host and route. */
export function scopeProofFailures(
  report: ScopeProofReport,
  expected: { commandNodeId?: string; leafNodeId: string; relayed: boolean },
): string[] {
  const failures: string[] = [];
  const check = (ok: boolean, what: string) => {
    if (!ok) failures.push(what);
  };
  check(report.leafNodeId === expected.leafNodeId, "the leaf scope is for the leaf node");
  if (expected.commandNodeId) {
    check(
      report.command.answeredBy === expected.commandNodeId,
      "the command node answered the command scope",
    );
  }
  check(report.leaf.answeredBy === expected.leafNodeId, "the leaf answered the leaf scope");
  check(report.command.answeredBy !== report.leaf.answeredBy, "two different nodes answered");
  check(
    report.openScopes.some((scope) => scope.role === "command") &&
      report.openScopes.some(
        (scope) => scope.role === "leaf" && scope.nodeId === expected.leafNodeId,
      ),
    "both scopes were open at once",
  );
  check(report.command.projects > 0 && report.leaf.projects > 0, "both reads returned projects");
  check(report.command.resourceChanged.received, "resource-changed arrived on the command scope");
  check(report.leaf.resourceChanged.received, "resource-changed arrived on the leaf scope");
  check(
    report.command.resourceChanged.seenByOtherScope === 0,
    "no command change reached the leaf scope",
  );
  check(
    report.leaf.resourceChanged.seenByOtherScope === 0,
    "no leaf change reached the command scope",
  );
  check(
    report.terminal.opened && report.terminal.outputSeen,
    `the leaf terminal ran (${report.terminal.error ?? ""})`,
  );
  check(
    report.route?.relayed === expected.relayed,
    `the leaf route is ${expected.relayed ? "relayed" : "direct"}`,
  );
  return failures;
}
