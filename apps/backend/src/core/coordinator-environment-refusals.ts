/**
 * Content-free counts of the coordinator origin refusal
 * (`COORDINATOR_ENVIRONMENT_ORIGIN_REFUSAL`): how often a coordinator was
 * stopped from acting on an environment it did not create (to-do 6080 task 6).
 *
 * The question these answer is whether the default is too strict, and in
 * particular whether replies to an environment's own mail dominate the
 * refusals, which is the exception the to-do would consider. So a refusal is
 * counted by what was refused (`surface`), by whether the environment is on
 * this node or another (`node`), and, for a Control MCP tool, by the tool's
 * name. Every label is from a fixed set: no project, coordinator, environment,
 * workflow or message id, and no tool input, is ever kept. Tool names outside
 * the set count as `other`, so the table cannot grow.
 *
 * The counts are in memory and start from zero with each backend. They are
 * read from `/__orkestrator/metrics` (`coordinatorEnvironmentRefusals`) and the
 * diagnostics bundle, through `backendMetricsSnapshot`.
 */

/** What was refused. */
export const COORDINATOR_REFUSAL_SURFACES = [
  /** A coordinator tool's origin check (`assert_coordinator_environment_scope`). */
  "tool",
  /** New agent mail to a worker on this node. */
  "mail",
  /** A reply (`replyToMessageId`) to mail from a worker on this node. */
  "mail-reply",
  /** New agent mail to an environment on another node. */
  "node-mail",
  /** A reply to mail from an environment on another node. */
  "node-mail-reply",
  /** Addressing or custom-fixing a Multi Review, which starts a turn. */
  "review-address",
  /** A build or graph control on a workflow with no environment yet. */
  "workflow-control",
] as const;
export type CoordinatorRefusalSurface = (typeof COORDINATOR_REFUSAL_SURFACES)[number];

export type CoordinatorRefusalNode = "local" | "remote";

export interface CoordinatorEnvironmentRefusalSnapshot {
  total: number;
  /** `<surface>:<node>` → refusals. */
  bySurface: Record<string, number>;
  /** Control MCP tool name → refusals, `other` for a name not in the set. */
  byTool: Record<string, number>;
}

const SURFACES: ReadonlySet<string> = new Set(COORDINATOR_REFUSAL_SURFACES);
/** Tool names are fixed by the registered tools; this caps a bug's growth anyway. */
const MAX_TOOL_SERIES = 64;
const TOOL_NAME = /^[a-z][a-z0-9_]{0,63}$/;

export class CoordinatorEnvironmentRefusals {
  private total = 0;
  private readonly bySurface = new Map<string, number>();
  private readonly byTool = new Map<string, number>();

  /** One refusal, where it was decided. */
  record(surface: CoordinatorRefusalSurface, node: CoordinatorRefusalNode): void {
    const label = SURFACES.has(surface) ? surface : "tool";
    const key = `${label}:${node === "remote" ? "remote" : "local"}`;
    this.total += 1;
    this.bySurface.set(key, (this.bySurface.get(key) ?? 0) + 1);
  }

  /**
   * Which Control MCP tool a `tool` refusal came from. Counted separately
   * because the origin check is a registry command that does not know the
   * tool; `known` is the set of checked tool names.
   */
  recordTool(tool: string, known: ReadonlySet<string> | ReadonlyMap<string, unknown>): void {
    const name = TOOL_NAME.test(tool) && known.has(tool) ? tool : "other";
    if (!this.byTool.has(name) && this.byTool.size >= MAX_TOOL_SERIES) return;
    this.byTool.set(name, (this.byTool.get(name) ?? 0) + 1);
  }

  snapshot(): CoordinatorEnvironmentRefusalSnapshot {
    return {
      total: this.total,
      bySurface: Object.fromEntries(this.bySurface),
      byTool: Object.fromEntries(this.byTool),
    };
  }

  /** Tests only: start from zero. */
  reset(): void {
    this.total = 0;
    this.bySurface.clear();
    this.byTool.clear();
  }
}

/** This backend's counts. */
export const coordinatorEnvironmentRefusals = new CoordinatorEnvironmentRefusals();
