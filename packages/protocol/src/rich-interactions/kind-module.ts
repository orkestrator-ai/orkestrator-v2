/**
 * The contract every registered rich interaction component implements.
 *
 * A kind is a bounded, trusted component: the backend reads its spec when an
 * agent (or the user) creates a request, reads a result when the user submits
 * one, and projects the decision into readable text for the agent. Actions
 * are registered per kind: an agent may choose which registered actions to
 * offer and relabel them, but the route and effect of an action id come from
 * this registry, never from the request or the client. Kinds that accept
 * agent-declared follow-up intents (`customFollowups`) only ever map them to
 * the ordinary `agent-followup` route.
 *
 * Browser-safe.
 */

export const RICH_INTERACTION_ROUTES = [
  "provider-resolution",
  "agent-followup",
  "product-command",
  "record-only",
] as const;
export type RichInteractionRoute = (typeof RICH_INTERACTION_ROUTES)[number];

/**
 * - `followup`: commit the decision and deliver a follow-up to the session.
 * - `record`: commit the decision only (save a note, accept a result).
 * - `revise`: apply the user's edit to the spec, publishing a new request revision.
 * - `command`: invoke a registered product command (retry, stop, ...).
 * - `provider`: resolve the decorated provider-native request.
 * - `close`: dismiss/close the request without a decision.
 */
export const RICH_ACTION_EFFECTS = [
  "followup",
  "record",
  "revise",
  "command",
  "provider",
  "close",
] as const;
export type RichActionEffect = (typeof RICH_ACTION_EFFECTS)[number];

export interface RichActionDef {
  id: string;
  label: string;
  route: RichInteractionRoute;
  effect: RichActionEffect;
  /** For `command` actions: the registered backend operation. */
  commandId?: string;
  description?: string;
  style?: "primary" | "secondary" | "destructive";
  /** Whether a single submission closes a single-use request. Default: effect is followup/record/provider. */
  closesRequest?: boolean;
}

export interface RichRevisionContext {
  now: string;
  /** Unique per committed action; use it to derive ids for appended items. */
  actionRecordId: string;
}

export interface RichKindModule<Spec, Result> {
  kind: string;
  /** Feature number(s) from the interactive sessions plan. */
  features: readonly number[];
  title: string;
  readSpec(value: unknown, path: string): Spec;
  readResult(spec: Spec, action: RichActionDef, value: unknown, path: string): Result;
  /** Agent-facing readable lines describing the decision (no host instructions). */
  summarize(spec: Spec, action: RichActionDef, result: Result): string[];
  /** Registered actions. The first `primary` one is the default submit. */
  actions: readonly RichActionDef[];
  /** Whether agents may declare extra follow-up intents (route: agent-followup). */
  customFollowups: boolean;
  /** Whether repeated submissions are expected (the request stays open). */
  repeatable: boolean;
  /**
   * The new spec a submission produces (a user edit, a thread entry), or null
   * when the submission leaves the spec unchanged. Called for every submitted
   * action; a non-null spec is published as a new request revision in the
   * same transaction as the action receipt.
   */
  applyRevision?(
    spec: Spec,
    result: Result,
    action: RichActionDef,
    context: RichRevisionContext,
  ): Spec | null;
  /**
   * For agent updates of an existing request: merge the agent's new spec with
   * user-owned state (thread history, assessments) and refuse changes the
   * agent may not make (overwriting a preserved document section). Defaults to
   * taking the agent's spec as is.
   */
  mergeAgentUpdate?(previous: Spec, next: Spec, path: string): Spec;
  /** Plain-text fallback describing the request for text-only consumers. */
  fallback(spec: Spec): string;
}

export const followup = (
  id: string,
  label: string,
  extra: Partial<RichActionDef> = {},
): RichActionDef => ({
  id,
  label,
  route: "agent-followup",
  effect: "followup",
  style: "primary",
  ...extra,
});

export const record = (
  id: string,
  label: string,
  extra: Partial<RichActionDef> = {},
): RichActionDef => ({
  id,
  label,
  route: "record-only",
  effect: "record",
  style: "secondary",
  ...extra,
});

export const revise = (
  id: string,
  label: string,
  extra: Partial<RichActionDef> = {},
): RichActionDef => ({
  id,
  label,
  route: "record-only",
  effect: "revise",
  style: "secondary",
  closesRequest: false,
  ...extra,
});
