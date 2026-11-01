import type { ProjectGitStatus } from "@orkestrator/protocol/coordinator";
import {
  decideUpstreamMergeOffer,
  isDeclinedUpstreamMerge,
  type CoordinatorUpstreamMergeCheck,
  type DeclinedUpstreamMerge,
} from "@orkestrator/protocol/coordinator-upstream-merge";
import * as backend from "@/lib/backend";
import { clientStateCapabilities } from "@/lib/client-state-capabilities";
import {
  clearLegacyPersistedState,
  readLegacyPersistedState,
  writeLegacyPersistedState,
} from "@/lib/legacy-local-state";

/** The key earlier releases kept declines under (per machine). */
export const LEGACY_UPSTREAM_DECLINE_KEY = "coordinator-upstream-declines";
const MAX_LEGACY_DECLINES = 50;

type LegacyDecline = DeclinedUpstreamMerge & { projectId: string };

function legacyDeclines(): LegacyDecline[] {
  const raw = readLegacyPersistedState(LEGACY_UPSTREAM_DECLINE_KEY)?.declines;
  if (!Array.isArray(raw)) return [];
  return raw
    .slice(-MAX_LEGACY_DECLINES)
    .filter(
      (entry): entry is LegacyDecline =>
        isDeclinedUpstreamMerge(entry) &&
        typeof (entry as { projectId?: unknown }).projectId === "string",
    );
}

let migration: Promise<void> | null = null;

/** One-time import of this browser's declines; never replaces a newer answer. */
function migrateLegacyDeclines(): Promise<void> {
  migration ??= (async () => {
    const declines = legacyDeclines();
    if (declines.length === 0) return;
    let complete = true;
    for (const decline of declines) {
      try {
        await backend.declineCoordinatorUpstreamMerge(decline.projectId, decline, {
          onlyIfAbsent: true,
        });
      } catch (error) {
        if (!(error instanceof Error && error.message.includes("Project not found"))) {
          complete = false;
        }
      }
    }
    if (complete) clearLegacyPersistedState(LEGACY_UPSTREAM_DECLINE_KEY);
  })();
  return migration;
}

export interface UpstreamCheckOptions {
  /** Older backends: whether a coordinator or project-home turn is running, judged here. */
  turnRunning: () => boolean;
  /** Receives the refreshed checkout status as soon as it is known. */
  onStatus?: (status: ProjectGitStatus) => void;
}

/**
 * Whether to ask "merge upstream first?" before a message to the main
 * coordinator. The backend decides (running turns, a cooldown-bound fetch,
 * fast-forward blockers, the stored decline); an older backend gets the same
 * protocol rule applied here against this browser's copy of the declines.
 */
export async function checkUpstreamMergeOffer(
  projectId: string,
  options: UpstreamCheckOptions,
): Promise<CoordinatorUpstreamMergeCheck | null> {
  const capabilities = await clientStateCapabilities();
  if (capabilities.coordinatorUpstreamMerge) {
    await migrateLegacyDeclines();
    const check = await backend.checkCoordinatorUpstreamMerge(projectId);
    if (check?.status) options.onStatus?.(check.status);
    return check;
  }
  if (options.turnRunning()) return { offer: false, reason: "turn-running", status: null };
  const status = await backend.fetchProjectGit(projectId);
  options.onStatus?.(status);
  return decideUpstreamMergeOffer(
    status,
    legacyDeclines().find((decline) => decline.projectId === projectId),
  );
}

/** Remembers a "skip" for the upstream tip it was given for. */
export async function declineUpstreamMerge(
  projectId: string,
  status: ProjectGitStatus,
): Promise<void> {
  if (!status.upstream || !status.upstreamCommit) return;
  const decline = { upstream: status.upstream, upstreamCommit: status.upstreamCommit };
  const capabilities = await clientStateCapabilities();
  if (capabilities.coordinatorUpstreamMerge) {
    await backend.declineCoordinatorUpstreamMerge(projectId, decline);
    return;
  }
  writeLegacyPersistedState(LEGACY_UPSTREAM_DECLINE_KEY, {
    declines: [
      ...legacyDeclines()
        .filter((entry) => entry.projectId !== projectId)
        .slice(-(MAX_LEGACY_DECLINES - 1)),
      { projectId, ...decline },
    ],
  });
}

export function resetUpstreamCheckForTests(): void {
  migration = null;
}
