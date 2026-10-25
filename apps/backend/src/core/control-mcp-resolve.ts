/**
 * Spoken names to IDs, for `resolve_target`. It never guesses: one exact
 * match (after normalizing filler words) wins; anything else is
 * `ambiguous-target` with up to five candidates, or `not-found`. A near miss
 * ("auth" for `auth-fix`) is returned as a candidate for the caller to
 * confirm, never as a match.
 */

export type TargetKind = "project" | "environment" | "session";

export interface TargetCandidate {
  kind: TargetKind;
  id: string;
  name: string;
  /** Other names this target answers to (branch, agent, position). */
  aliases: string[];
  environmentId?: string;
  projectId?: string;
  /** The machine it is on, when candidates span machines (`nodeId: all`). */
  nodeId?: string;
  nodeName?: string;
}

export type TargetResolution =
  | { status: "resolved"; target: TargetCandidate }
  | { status: "ambiguous"; candidates: TargetCandidate[] }
  | { status: "not-found" };

const LEADING = /^(?:the|my|our|that|this)\s+/;
const TRAILING = /\s+(?:environment|env|workspace|tab|session|agent|project|repo|repository)$/;
const ORDINALS = ["first", "second", "third", "fourth", "fifth", "sixth", "seventh", "eighth"];

export function normalizeSpokenName(value: string): string {
  let text = value.toLowerCase().trim().replace(/["'`]/g, "").replace(/\s+/g, " ");
  for (let pass = 0; pass < 3; pass += 1) {
    text = text.replace(LEADING, "").replace(TRAILING, "").trim();
  }
  return text;
}

/** Names a session answers to: its title, its agent, and its position. */
export function sessionAliases(agent: string, title: string | null, position: number): string[] {
  const ordinal = ORDINALS[position];
  return [
    agent,
    ...(title ? [title] : []),
    String(position + 1),
    ...(ordinal ? [ordinal, `${ordinal} ${agent}`] : []),
  ];
}

export function resolveTarget(
  query: string,
  candidates: readonly TargetCandidate[],
  maxCandidates = 5,
): TargetResolution {
  const wanted = normalizeSpokenName(query);
  if (!wanted) return { status: "not-found" };
  const names = (candidate: TargetCandidate) =>
    [candidate.id, candidate.name, ...candidate.aliases].map(normalizeSpokenName);
  const exact = candidates.filter((candidate) => names(candidate).includes(wanted));
  if (exact.length === 1) return { status: "resolved", target: exact[0]! };
  if (exact.length > 1) return { status: "ambiguous", candidates: exact.slice(0, maxCandidates) };
  const near = candidates.filter((candidate) =>
    names(candidate).some(
      (name) => name.length >= 3 && (name.includes(wanted) || wanted.includes(name)),
    ),
  );
  return near.length > 0
    ? { status: "ambiguous", candidates: near.slice(0, maxCandidates) }
    : { status: "not-found" };
}
