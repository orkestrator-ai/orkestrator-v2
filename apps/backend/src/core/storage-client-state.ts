import {
  COORDINATOR_PANE_LAYOUT_MAX_BYTES,
  parseCoordinatorPaneLayoutRecord,
  sanitizeCoordinatorPaneLayout,
  type CoordinatorPaneLayout,
  type CoordinatorPaneLayoutRecord,
  type CoordinatorPaneLayoutSaveResult,
} from "@orkestrator/protocol/coordinator-pane-layout";
import {
  isDeclinedUpstreamMerge,
  type DeclinedUpstreamMerge,
} from "@orkestrator/protocol/coordinator-upstream-merge";
import {
  COORDINATOR_ACTION_MARK_LIMITS,
  isCoordinatorActionCardId,
  normalizeCoordinatorActionCardIds,
  type CoordinatorActionMarks,
} from "@orkestrator/protocol/coordinator-action-marks";
import {
  NOTICE_DISMISSAL_LIMITS,
  normalizeNoticeDismissalSessions,
  type NoticeDismissalSession,
  type NoticeDismissalSnapshot,
} from "@orkestrator/protocol/notice-dismissals";
import type { StorageContext } from "./storage-context.js";
import { isRecord, nowIso } from "./storage-shared.js";

/** The single key of the notice dismissal announcement. */
export const NOTICE_DISMISSALS_RESOURCE_ID = "notice-dismissals";

interface StoredUpstreamDecline extends DeclinedUpstreamMerge {
  projectId: string;
  declinedAt: string;
}

interface StoredUpstreamAutoMerge {
  projectId: string;
  enabled: true;
  updatedAt: string;
}

interface StoredNoticeDismissals {
  revision: number;
  sessions: NoticeDismissalSession[];
}

function readNoticeDismissals(value: unknown): StoredNoticeDismissals {
  if (!isRecord(value)) return { revision: 0, sessions: [] };
  const revision = Number.isSafeInteger(value.revision) ? (value.revision as number) : 0;
  return {
    revision: Math.max(0, revision),
    sessions: normalizeNoticeDismissalSessions(value.sessions).slice(
      -NOTICE_DISMISSAL_LIMITS.sessions,
    ),
  };
}

interface StoredActionMarks extends CoordinatorActionMarks {
  updatedAt: string;
}

/** One conversation's row key; JSON keeps the pair unambiguous whatever the ids hold. */
function actionMarksKey(projectId: string, conversationId: string): string {
  return JSON.stringify([projectId, conversationId]);
}

function readActionMarks(
  value: unknown,
  projectId: string,
  conversationId: string,
): CoordinatorActionMarks {
  if (
    !isRecord(value) ||
    value.projectId !== projectId ||
    value.conversationId !== conversationId
  ) {
    return { projectId, conversationId, revision: 0, cardIds: [] };
  }
  const revision = Number.isSafeInteger(value.revision) ? (value.revision as number) : 0;
  return {
    projectId,
    conversationId,
    revision: Math.max(0, revision),
    cardIds: normalizeCoordinatorActionCardIds(value.cardIds),
  };
}

/** Thrown when a conversation already holds as many marks as it may. */
export const COORDINATOR_ACTION_MARKS_FULL_ERROR =
  "This conversation has too many actions marked done; mark one not done first";

function sameIds(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((id, index) => id === right[index]);
}

/**
 * Presentation state every client shares that used to live in one browser's
 * localStorage (docs/architecture/storage.md):
 *
 * - `coordinator-pane-layouts`: one row per project, the coordinator page's tab
 *   groups, saved by revision compare-and-swap; announces
 *   `coordinator-pane-layout` with the project id.
 * - `coordinator-upstream-declines`: one row per project, the upstream tip an
 *   older client's user chose not to merge before messaging the coordinator.
 *   Retired: still written for those clients, but no decision reads it now
 *   that every mergeable checkout is merged. Not announced.
 * - `coordinator-upstream-auto-merge`: one row per project an older client set
 *   to always merge upstream commits. Retired in the same way; not announced.
 * - `notice-dismissals`: one document, notices dismissed per session identity,
 *   bounded in both dimensions; announces `notice-dismissal`.
 * - `coordinator-action-marks`: one row per coordinator conversation, owned by
 *   its project: the action cards the user marked done by hand, at most
 *   `COORDINATOR_ACTION_MARK_LIMITS.marksPerConversation` (a further mark is
 *   refused, never evicted); announces `coordinator-action-marks` with the
 *   conversation id and its project.
 *
 * Every write is one `updateStoreRow`/`updateStore` transaction. A project's
 * rows are deleted with the project.
 */
export class ClientStateRepository {
  constructor(private readonly context: StorageContext) {}

  private layoutsFile(): string {
    return this.context.file("coordinator-pane-layouts.json");
  }

  private declinesFile(): string {
    return this.context.file("coordinator-upstream-declines.json");
  }

  private autoMergeFile(): string {
    return this.context.file("coordinator-upstream-auto-merge.json");
  }

  private dismissalsFile(): string {
    return this.context.file("notice-dismissals.json");
  }

  private actionMarksFile(): string {
    return this.context.file("coordinator-action-marks.json");
  }

  getCoordinatorPaneLayout(projectId: string): CoordinatorPaneLayoutRecord | null {
    return parseCoordinatorPaneLayoutRecord(
      this.context.loadStoreRow(this.layoutsFile(), projectId),
    );
  }

  /**
   * Saves a project's layout when the stored revision is `expectedRevision`
   * (0: none stored). The layout is sanitized and bounded here, at the trust
   * boundary; a conflict answers with the stored record instead.
   */
  saveCoordinatorPaneLayout(
    projectId: string,
    layout: unknown,
    expectedRevision: number,
  ): CoordinatorPaneLayoutSaveResult {
    const sanitized: CoordinatorPaneLayout | null = sanitizeCoordinatorPaneLayout(layout);
    if (!sanitized) throw new Error("layout is not a valid coordinator pane layout");
    if (Buffer.byteLength(JSON.stringify(sanitized)) > COORDINATOR_PANE_LAYOUT_MAX_BYTES) {
      throw new Error("layout exceeds its size bound");
    }
    const result = this.context.updateStoreRow<CoordinatorPaneLayoutSaveResult>(
      this.layoutsFile(),
      projectId,
      (current) => {
        const stored = parseCoordinatorPaneLayoutRecord(current);
        if ((stored?.revision ?? 0) !== expectedRevision) {
          return { result: { status: "conflict", current: stored } };
        }
        const record: CoordinatorPaneLayoutRecord = {
          projectId,
          layout: sanitized,
          revision: expectedRevision + 1,
          updatedAt: nowIso(),
        };
        return { result: { status: "saved", record }, value: record };
      },
    );
    if (result.status === "saved") {
      this.context.changes.announce("coordinator-pane-layout", projectId, projectId);
    }
    return result;
  }

  getCoordinatorUpstreamDecline(projectId: string): DeclinedUpstreamMerge | null {
    const stored = this.context.loadStoreRow(this.declinesFile(), projectId);
    return isDeclinedUpstreamMerge(stored)
      ? { upstream: stored.upstream, upstreamCommit: stored.upstreamCommit }
      : null;
  }

  /**
   * Remembers the upstream tip a project's merge question was declined for.
   * `onlyIfAbsent` (a browser's one-time migration) never replaces a newer
   * answer another client already gave. Returns the decline now in force.
   */
  recordCoordinatorUpstreamDecline(
    projectId: string,
    decline: DeclinedUpstreamMerge,
    options: { onlyIfAbsent?: boolean } = {},
  ): DeclinedUpstreamMerge {
    if (!isDeclinedUpstreamMerge(decline)) throw new Error("decline is not a valid upstream tip");
    return this.context.updateStoreRow<DeclinedUpstreamMerge>(
      this.declinesFile(),
      projectId,
      (current) => {
        if (options.onlyIfAbsent && isDeclinedUpstreamMerge(current)) {
          return {
            result: { upstream: current.upstream, upstreamCommit: current.upstreamCommit },
          };
        }
        const stored: StoredUpstreamDecline = {
          projectId,
          upstream: decline.upstream,
          upstreamCommit: decline.upstreamCommit,
          declinedAt: nowIso(),
        };
        return {
          result: { upstream: decline.upstream, upstreamCommit: decline.upstreamCommit },
          value: stored,
        };
      },
    );
  }

  /** Whether a project merges upstream commits before coordinator messages without asking. */
  getCoordinatorUpstreamAutoMerge(projectId: string): boolean {
    const stored = this.context.loadStoreRow(this.autoMergeFile(), projectId);
    return isRecord(stored) && stored.enabled === true;
  }

  /** Turns "always merge" on or off for a project; off deletes the row. Returns the setting now in force. */
  setCoordinatorUpstreamAutoMerge(projectId: string, enabled: boolean): boolean {
    return this.context.updateStoreRow<boolean>(this.autoMergeFile(), projectId, (current) => {
      if (!enabled)
        return current === undefined ? { result: false } : { result: false, delete: true };
      const stored: StoredUpstreamAutoMerge = { projectId, enabled: true, updatedAt: nowIso() };
      return { result: true, value: stored };
    });
  }

  /** A coordinator conversation's manual action marks; revision 0 when none are stored. */
  getCoordinatorActionMarks(projectId: string, conversationId: string): CoordinatorActionMarks {
    return readActionMarks(
      this.context.loadStoreRow(this.actionMarksFile(), actionMarksKey(projectId, conversationId)),
      projectId,
      conversationId,
    );
  }

  /**
   * Marks a card done by hand (`done`), or clears its mark. A change that
   * leaves the marks as they were writes nothing and keeps the revision.
   * The row stays once written, even empty, so its revision only moves
   * forward; it goes with the project.
   */
  setCoordinatorActionMark(
    projectId: string,
    conversationId: string,
    cardId: string,
    done: boolean,
  ): CoordinatorActionMarks {
    if (!isCoordinatorActionCardId(cardId)) throw new Error("cardId is not a valid action id");
    const { marks, changed } = this.context.updateStoreRow<{
      marks: CoordinatorActionMarks;
      changed: boolean;
    }>(this.actionMarksFile(), actionMarksKey(projectId, conversationId), (current) => {
      const stored = readActionMarks(current, projectId, conversationId);
      const has = stored.cardIds.includes(cardId);
      if (has === done) return { result: { marks: stored, changed: false } };
      if (done && stored.cardIds.length >= COORDINATOR_ACTION_MARK_LIMITS.marksPerConversation) {
        throw new Error(COORDINATOR_ACTION_MARKS_FULL_ERROR);
      }
      const next: StoredActionMarks = {
        projectId,
        conversationId,
        revision: stored.revision + 1,
        cardIds: done ? [...stored.cardIds, cardId] : stored.cardIds.filter((id) => id !== cardId),
        updatedAt: nowIso(),
      };
      const marks: CoordinatorActionMarks = {
        projectId,
        conversationId,
        revision: next.revision,
        cardIds: next.cardIds,
      };
      return { result: { marks, changed: true }, value: next };
    });
    if (changed) {
      this.context.changes.announce("coordinator-action-marks", conversationId, projectId);
    }
    return marks;
  }

  /**
   * Deletes a project's layout, decline and auto-merge setting, and its
   * conversations' action marks (project removal).
   */
  deleteProjectClientState(projectId: string): void {
    const deleted = this.context.updateStoreRow<boolean>(
      this.layoutsFile(),
      projectId,
      (current) => (current === undefined ? { result: false } : { result: true, delete: true }),
    );
    this.context.updateStoreRow<boolean>(this.declinesFile(), projectId, (current) =>
      current === undefined ? { result: false } : { result: true, delete: true },
    );
    this.context.updateStoreRow<boolean>(this.autoMergeFile(), projectId, (current) =>
      current === undefined ? { result: false } : { result: true, delete: true },
    );
    this.deleteProjectActionMarks(projectId);
    if (deleted) {
      this.context.changes.announce(
        "coordinator-pane-layout",
        projectId,
        projectId,
        undefined,
        true,
      );
    }
  }

  /**
   * Every conversation's marks in a removed project, found by the rows' owner.
   * `listStoreRowKeysByOwner` answers nothing only inside an atomic scope that
   * writes this store, which project removal never opens.
   */
  private deleteProjectActionMarks(projectId: string): void {
    const file = this.actionMarksFile();
    const rows = this.context.listStoreRowKeysByOwner(file, projectId);
    const keys = new Set(rows?.owned ?? []);
    for (const row of rows?.unowned ?? []) {
      try {
        const value = JSON.parse(row.value) as unknown;
        if (isRecord(value) && value.projectId === projectId) keys.add(row.key);
      } catch {
        // Unreadable: not this project's to delete.
      }
    }
    for (const key of keys) {
      const conversationId = this.context.updateStoreRow<string | null>(file, key, (current) =>
        current === undefined
          ? { result: null }
          : {
              result:
                isRecord(current) && typeof current.conversationId === "string"
                  ? current.conversationId
                  : null,
              delete: true,
            },
      );
      if (conversationId) {
        this.context.changes.announce(
          "coordinator-action-marks",
          conversationId,
          projectId,
          undefined,
          true,
        );
      }
    }
  }

  listNoticeDismissals(): NoticeDismissalSnapshot {
    const stored = readNoticeDismissals(
      this.context.loadStoreRow(this.dismissalsFile(), "dismissals"),
    );
    return { revision: stored.revision, sessions: stored.sessions };
  }

  /**
   * Adds dismissals (merged into each session's list, newest kept). Also the
   * one-time import of a browser's saved dismissals.
   */
  dismissNotices(sessions: readonly NoticeDismissalSession[]): NoticeDismissalSnapshot {
    const incoming = normalizeNoticeDismissalSessions(sessions);
    return this.mutateNoticeDismissals((stored) => {
      let changed = false;
      for (const { sessionIdentity, occurrenceIds } of incoming) {
        if (occurrenceIds.length === 0) continue;
        const index = stored.sessions.findIndex(
          (session) => session.sessionIdentity === sessionIdentity,
        );
        const previous = index === -1 ? [] : stored.sessions[index]!.occurrenceIds;
        const merged = [
          ...previous.filter((id) => !occurrenceIds.includes(id)),
          ...occurrenceIds,
        ].slice(-NOTICE_DISMISSAL_LIMITS.occurrencesPerSession);
        if (index !== -1 && sameIds(previous, merged)) continue;
        if (index !== -1) stored.sessions.splice(index, 1);
        stored.sessions.push({ sessionIdentity, occurrenceIds: merged });
        changed = true;
      }
      stored.sessions = stored.sessions.slice(-NOTICE_DISMISSAL_LIMITS.sessions);
      return changed;
    });
  }

  /**
   * Keeps only a session's dismissals whose notices the authoritative snapshot
   * still carries, so a later recurrence of a recovered condition shows again.
   */
  reconcileNoticeDismissals(
    sessionIdentity: string,
    activeOccurrenceIds: readonly string[],
  ): NoticeDismissalSnapshot {
    const active = new Set(activeOccurrenceIds);
    return this.mutateNoticeDismissals((stored) => {
      const index = stored.sessions.findIndex(
        (session) => session.sessionIdentity === sessionIdentity,
      );
      if (index === -1) return false;
      const previous = stored.sessions[index]!;
      const occurrenceIds = previous.occurrenceIds.filter((id) => active.has(id));
      if (occurrenceIds.length === previous.occurrenceIds.length) return false;
      if (occurrenceIds.length === 0) stored.sessions.splice(index, 1);
      else stored.sessions[index] = { sessionIdentity, occurrenceIds };
      return true;
    });
  }

  private mutateNoticeDismissals(
    mutate: (stored: StoredNoticeDismissals) => boolean,
  ): NoticeDismissalSnapshot {
    const { snapshot, changed } = this.context.updateStoreRow<{
      snapshot: NoticeDismissalSnapshot;
      changed: boolean;
    }>(this.dismissalsFile(), "dismissals", (current) => {
      const stored = readNoticeDismissals(current);
      if (!mutate(stored)) {
        return { result: { snapshot: stored, changed: false } };
      }
      const next: StoredNoticeDismissals = {
        revision: stored.revision + 1,
        sessions: stored.sessions,
      };
      return { result: { snapshot: next, changed: true }, value: next };
    });
    if (changed) this.context.changes.announce("notice-dismissal", NOTICE_DISMISSALS_RESOURCE_ID);
    return snapshot;
  }
}

/**
 * Shared client presentation state: what callers reach as `storage.clientState`.
 * Every name here is an entry point `storage-writer-guards.test.ts` follows
 * store writes back to.
 */
export type ClientStateStorage = Pick<
  ClientStateRepository,
  | "getCoordinatorPaneLayout"
  | "saveCoordinatorPaneLayout"
  | "getCoordinatorUpstreamDecline"
  | "recordCoordinatorUpstreamDecline"
  | "getCoordinatorUpstreamAutoMerge"
  | "setCoordinatorUpstreamAutoMerge"
  | "listNoticeDismissals"
  | "dismissNotices"
  | "reconcileNoticeDismissals"
  | "getCoordinatorActionMarks"
  | "setCoordinatorActionMark"
>;
