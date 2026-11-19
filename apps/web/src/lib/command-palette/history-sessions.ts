/**
 * The palette's past-session History source: the conversations the frozen
 * environment's agents can resume, read through the same backend list the
 * agent tab's "Resume session" picker reads (`list_native_agent_resumable_sessions`).
 * Opening one resumes it in a new agent tab through that tab's own resume
 * path (`sessionResumeRequestStore`).
 *
 * The list is read once per palette session and platform, then filtered
 * locally as the user types, so typing never issues a request. Only
 * platforms the environment already has an agent tab for are read: listing
 * resolves the platform's bridge, and a search must not start one the user
 * never asked for. Titles are the provider's own; no message content is read.
 */
import type { AgentPlatform } from "@orkestrator/protocol/agent-platforms";
import { parseProjectSearchQuery, scoreHaystacks } from "@/lib/project-search";
import type { SessionHistoryResult } from "./history";
import type { PaletteMachine } from "./model";
import type { PaletteProvider } from "./providers";

export const SESSION_RESULT_LIMIT = 20;

/** The fields of a resume-list entry the palette uses. */
export interface PastSessionEntry {
  sessionId?: string;
  title?: string;
  createdAt?: string;
  updatedAt?: string;
  archived?: boolean;
}

export interface PastSessionEnvironment {
  id: string;
  name: string;
  projectId: string;
  projectName: string;
}

export interface PastSessionListing {
  entries: Array<{ platform: AgentPlatform; entry: PastSessionEntry }>;
  /** Platforms whose list could not be read. */
  failed: number;
  platforms: number;
}

/**
 * Reads each platform's list once and shares the answer between searches.
 * `load` rejects only when every platform failed.
 */
export function createPastSessionLoader({
  platforms,
  list,
}: {
  platforms: readonly AgentPlatform[];
  list: (platform: AgentPlatform) => Promise<readonly PastSessionEntry[]>;
}): { load: () => Promise<PastSessionListing> } {
  let answer: Promise<PastSessionListing> | null = null;
  return {
    load: () => {
      answer ??= Promise.allSettled(platforms.map((platform) => list(platform))).then((settled) => {
        const listing: PastSessionListing = {
          entries: [],
          failed: 0,
          platforms: platforms.length,
        };
        settled.forEach((result, index) => {
          if (result.status === "rejected") {
            listing.failed += 1;
            return;
          }
          for (const entry of result.value) {
            listing.entries.push({ platform: platforms[index]!, entry });
          }
        });
        if (listing.platforms > 0 && listing.failed === listing.platforms) {
          throw new Error("No past-session list could be read");
        }
        return listing;
      });
      return answer;
    },
  };
}

function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new DOMException("aborted", "AbortError"));
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

function activityTime(entry: PastSessionEntry): number {
  const parsed = Date.parse(entry.updatedAt ?? entry.createdAt ?? "");
  return Number.isNaN(parsed) ? 0 : parsed;
}

export function sessionHistoryRowId(
  machine: PaletteMachine | null,
  environmentId: string,
  platform: AgentPlatform,
  sessionId: string,
): string {
  return `history-session:${machine?.connectionId ?? "this"}:${environmentId}:${platform}:${sessionId}`;
}

/**
 * Filters the loaded lists by the query. Archived conversations and ones
 * already open in a tab (listed under Open tabs) are left out. An empty query
 * lists the most recently active first.
 */
export function createSessionHistoryProvider({
  loader,
  environment,
  machine,
  platformLabel,
  openSessionIds,
  resultLimit = SESSION_RESULT_LIMIT,
}: {
  loader: { load: () => Promise<PastSessionListing> };
  environment: PastSessionEnvironment;
  machine: () => PaletteMachine | null;
  platformLabel: (platform: AgentPlatform) => string;
  openSessionIds: ReadonlySet<string>;
  resultLimit?: number;
}): PaletteProvider<SessionHistoryResult> {
  return {
    search: async (query, signal) => {
      const listing = await abortable(loader.load(), signal);
      const tokens = parseProjectSearchQuery(query);
      const owner = machine();
      const rows: Array<{ row: SessionHistoryResult; activity: number }> = [];
      for (const { platform, entry } of listing.entries) {
        const sessionId = entry.sessionId;
        if (!sessionId || entry.archived || openSessionIds.has(sessionId)) continue;
        const title = entry.title?.trim() || "Untitled conversation";
        const label = platformLabel(platform);
        const score = scoreHaystacks([title, label, "session"], tokens);
        if (score === null) continue;
        rows.push({
          activity: activityTime(entry),
          row: {
            source: "session",
            rowId: sessionHistoryRowId(owner, environment.id, platform, sessionId),
            title,
            kind: `${label} session`,
            machine: owner,
            projectId: environment.projectId,
            projectName: environment.projectName,
            environmentId: environment.id,
            environmentName: environment.name,
            platform,
            sessionId,
            activityAt: entry.updatedAt ?? entry.createdAt ?? null,
            score,
          },
        });
      }
      const ranked = rows
        .sort((left, right) => right.row.score - left.row.score || right.activity - left.activity)
        .map(({ row }) => row);
      return {
        rows: ranked.slice(0, resultLimit),
        partial: listing.failed > 0 || ranked.length > resultLimit,
      };
    },
  };
}
