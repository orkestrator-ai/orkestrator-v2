/**
 * The scenario module interface of the mixed-version qualification runner
 * (`scripts/qualify-contract-mixed-versions.ts`, plan item 1012;
 * docs/architecture/version-compatibility.md, "Mixed-version qualification").
 *
 * The runner starts two backends, one of this checkout and one published
 * release (by default the support floor), links them as a command node and a
 * leaf, and runs every scenario module in both topologies:
 *
 * - `current-command`: this checkout's command node, the release as its leaf
 *   (the current sender's domain clients pick their adapters for an older
 *   peer);
 * - `old-command`: the release as command node, this checkout as its leaf
 *   (the current receiver takes an older sender's requests).
 *
 * ## Adding a module (Phase 7 domain items)
 *
 * 1. Write `scripts/mixed-version/scenarios/<domain>.ts` exporting a
 *    `ScenarioModule` (use {@link defineScenario} for the types). `domain` is
 *    the contract domain it qualifies (a key of the manifest's `domains`).
 * 2. List it in `scripts/mixed-version/scenarios/index.ts` (`SCENARIOS`).
 * 3. Run it against a release that has the domain's commands, and against this
 *    checkout on both sides:
 *    `mise run qualify:mixed-versions -- --old-version current --scenarios <domain>`
 *    then `--old-version latest-stable` and the default floor.
 *
 * ## Rules for a module
 *
 * - **Declare what the release must have** in `requires` (command names per
 *   role). When the release lacks one, the runner records the scenario as
 *   `not-applicable` with the missing names and does not run it; a missing
 *   command on this checkout's side is a failure (a renamed command must
 *   update its module). Anything finer (a capability, a domain version) is
 *   the module's own decision: read `ctx.leaf.hello` / `ctx.command.hello`
 *   and either assert the adapter's degraded behaviour or call
 *   `ctx.notApplicable(reason)`.
 * - **Assert what the receiver itself reports**, not only the sender's answer:
 *   read the other node's state (its mailbox, board, files) with
 *   `ctx.leaf.invoke` / `ctx.command.invoke`.
 * - **Name the adapter path.** When this checkout is the command node, assert
 *   the domain client took the adapter `ctx.expectedAdapter(domain)` names:
 *   `ctx.adapterCallsSince(domain, 0)` counts the version-0 calls this
 *   scenario made (`domain-adapter.backend.<domain>.v0`).
 * - **Use the shared fixtures** (`ctx.fixtures`): one project per node with
 *   the same repository identity, coordinators and worker environments,
 *   created once per topology. Create anything else under `ctx.scratch`.
 * - **Use only commands both sides know** in the shape the older side takes,
 *   and never start an agent turn: the backends run as `agent-test` with no
 *   toolchain and no credentials, and a module must not depend on an agent.
 * - Check ids are `<PREFIX>-<nn>` and stable, so reports compare across runs.
 * - No file contents, tokens or paths outside `ctx.scratch` in `note` details.
 */
import type { PairFixtures } from "./fixtures.ts";
import type { PeerNode } from "./harness.ts";

export type Topology = "current-command" | "old-command";
export const TOPOLOGIES: readonly Topology[] = ["current-command", "old-command"];

export interface ScenarioRequirements {
  /** Commands the command node must register. */
  readonly command?: readonly string[];
  /** Commands the leaf must register. */
  readonly leaf?: readonly string[];
}

export interface ScenarioCheck {
  readonly id: string;
  readonly description: string;
  readonly ok: boolean;
  readonly detail?: string;
}

export interface ScenarioContext {
  readonly topology: Topology;
  readonly command: PeerNode;
  readonly leaf: PeerNode;
  /** The release's side of the pair (`null` for a current/current control run). */
  readonly old: PeerNode | null;
  readonly fixtures: PairFixtures;
  /** A private directory for this scenario's own files. */
  readonly scratch: string;
  /** Record an assertion; returns `ok`. A failed check fails the scenario. */
  check(id: string, description: string, ok: boolean, detail?: string): boolean;
  /** Record a step's evidence for the report. */
  note(step: string, detail?: Record<string, unknown>): void;
  /** Stop here: the pair cannot run this scenario (recorded, not a failure). */
  notApplicable(reason: string): never;
  /**
   * The adapter this checkout's command node should pick for `domain` with
   * this leaf: 1 when the leaf's hello advertises the domain at version 1,
   * else 0. `null` when the command node is the release (pre-contract senders
   * have no domain clients to count).
   */
  expectedAdapter(domain: string): 0 | 1 | null;
  /**
   * Calls this checkout's command node made through `domain`'s adapter
   * `version` since the scenario started (its compatibility-path counter);
   * `null` when the command node is the release.
   */
  adapterCallsSince(domain: string, version: number): Promise<number | null>;
}

export interface ScenarioModule {
  /** The contract domain this module qualifies. */
  readonly domain: string;
  /** One line for the report. */
  readonly title: string;
  /** Topologies it runs in; both by default. */
  readonly topologies?: readonly Topology[];
  readonly requires?: ScenarioRequirements;
  run(ctx: ScenarioContext): Promise<void>;
}

/** Identity, for the types. */
export function defineScenario(module: ScenarioModule): ScenarioModule {
  return module;
}

export class NotApplicable extends Error {}

export type ScenarioStatus = "passed" | "failed" | "not-applicable";

export interface ScenarioResult {
  readonly domain: string;
  readonly title: string;
  readonly status: ScenarioStatus;
  readonly reason?: string;
  readonly error?: string;
  readonly checks: readonly ScenarioCheck[];
  readonly evidence: readonly Record<string, unknown>[];
  /** `domain-adapter.backend.*` counters this scenario moved, when the command node is current. */
  readonly adapterCalls?: Readonly<Record<string, number>>;
  readonly ms: number;
}

/**
 * Whether a scenario can run on this pair: the names each side lacks. A
 * current side lacking a command is a module bug, not a skip.
 */
export function requirementGaps(
  module: ScenarioModule,
  command: Pick<PeerNode, "missing" | "build">,
  leaf: Pick<PeerNode, "missing" | "build">,
): { readonly old: string[]; readonly current: string[] } {
  const old: string[] = [];
  const current: string[] = [];
  for (const [node, required, role] of [
    [command, module.requires?.command ?? [], "command node"],
    [leaf, module.requires?.leaf ?? [], "leaf"],
  ] as const) {
    const missing = node.missing(required).map((name) => `${name} (${role})`);
    (node.build.kind === "current" ? current : old).push(...missing);
  }
  return { old, current };
}

/** The scenario's status from its checks and outcome. */
export function scenarioStatus(
  checks: readonly ScenarioCheck[],
  outcome: { readonly error?: unknown },
): ScenarioStatus {
  // A failed check fails the scenario even when it then stopped as not applicable.
  if (checks.some((entry) => !entry.ok)) return "failed";
  if (outcome.error instanceof NotApplicable) return "not-applicable";
  if (outcome.error !== undefined) return "failed";
  return checks.length > 0 ? "passed" : "failed";
}
