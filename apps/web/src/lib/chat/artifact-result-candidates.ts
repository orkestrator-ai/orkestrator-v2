/**
 * Result candidates proposed by live interactive artifacts (feature 12).
 *
 * The live host publishes each validated `result-candidate` here, keyed by
 * the exact artifact revision and tagged with the viewer generation that sent
 * it. A widget-result card bound to that revision reads the latest candidate
 * and shows it in host-owned controls. Nothing here submits anything: a
 * candidate is display state until the person clicks the card's own button.
 * A new viewer generation replaces older candidates; closing the viewer
 * clears them.
 */

export interface ArtifactResultCandidate {
  artifactId: string;
  revision: number;
  generation: string;
  candidateId: string;
  value: Record<string, unknown>;
  receivedAt: number;
}

type Listener = (candidate: ArtifactResultCandidate | null) => void;

const latest = new Map<string, ArtifactResultCandidate>();
const listeners = new Map<string, Set<Listener>>();
const MAX_TRACKED = 50;

const keyOf = (artifactId: string, revision: number) => `${artifactId}@${revision}`;

function notify(key: string, candidate: ArtifactResultCandidate | null): void {
  for (const listener of listeners.get(key) ?? []) listener(candidate);
}

export function publishArtifactResultCandidate(
  candidate: Omit<ArtifactResultCandidate, "receivedAt">,
): void {
  const key = keyOf(candidate.artifactId, candidate.revision);
  const next = { ...candidate, receivedAt: Date.now() };
  latest.delete(key);
  latest.set(key, next);
  while (latest.size > MAX_TRACKED) {
    const oldest = latest.keys().next().value;
    if (oldest === undefined) break;
    latest.delete(oldest);
  }
  notify(key, next);
}

/** The viewer for this revision closed or was replaced: its candidates no longer apply. */
export function clearArtifactResultCandidates(
  artifactId: string,
  revision: number,
  generation?: string,
): void {
  const key = keyOf(artifactId, revision);
  const current = latest.get(key);
  if (!current || (generation !== undefined && current.generation !== generation)) return;
  latest.delete(key);
  notify(key, null);
}

export function latestArtifactResultCandidate(
  artifactId: string,
  revision: number,
): ArtifactResultCandidate | null {
  return latest.get(keyOf(artifactId, revision)) ?? null;
}

export function subscribeArtifactResultCandidates(
  artifactId: string,
  revision: number,
  listener: Listener,
): () => void {
  const key = keyOf(artifactId, revision);
  let set = listeners.get(key);
  if (!set) listeners.set(key, (set = new Set()));
  set.add(listener);
  return () => {
    set.delete(listener);
    if (set.size === 0) listeners.delete(key);
  };
}

/** Test hook. */
export function resetArtifactResultCandidates(): void {
  latest.clear();
  listeners.clear();
}
