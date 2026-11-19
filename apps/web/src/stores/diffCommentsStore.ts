import type { MeasurementScope } from "@orkestrator/protocol/change-measurements";
import type { ChangeDiffLine } from "@orkestrator/protocol/change-resources";
import { defineScopedStore, scopedStoreHook } from "@/lib/node-scope/scoped-store";
import { createUuid } from "@/lib/uuid";

/**
 * Review comments the user leaves on local diff lines and hunks, collected
 * per environment and sent to an agent as one correction request
 * (`lib/changes/diff-comment-delivery.ts`).
 *
 * Each comment is pinned to the immutable diff identity it was written on and
 * keeps a copy of the lines it was about, so the request can quote them even
 * after the file has moved on. A live view reports the content it currently
 * shows (`observeLiveContent`); a comment written against other content is
 * then shown, and sent, as outdated rather than silently re-anchored.
 *
 * Delivery follows a snapshot: a send records the `(id, revision)` pairs it
 * carried, and settling it removes only comments still at those revisions. A
 * comment added or edited while the send is in flight is kept.
 *
 * Renderer-only state, like `promptDraftStore`: it survives tab and
 * environment switches (the tab unmounting is not a reason to lose a review)
 * but not a renderer restart. One instance per node scope, because the
 * environments are that node's.
 */

/** Comments one environment may hold; adding past it is refused. */
export const MAX_DIFF_COMMENTS_PER_ENVIRONMENT = 100;
/** Characters one comment body may hold. */
export const MAX_DIFF_COMMENT_BODY = 4000;
/** Lines of code a hunk comment captures. */
export const MAX_DIFF_COMMENT_EXCERPT_LINES = 20;
/** Characters of one captured line. */
export const MAX_DIFF_COMMENT_LINE_CHARACTERS = 300;
/** Environments held at once. Only entries without drafts or a send may be evicted. */
const MAX_ENVIRONMENTS = 50;
/** Paths whose live content is remembered per environment. */
const MAX_OBSERVED_PATHS = 500;

export type DiffCommentLine = Pick<ChangeDiffLine, "type" | "text" | "oldLine" | "newLine">;

export interface DiffCommentAnchor {
  /** `live` comments can become outdated; a historical identity never changes. */
  source: "live" | "historical";
  /** The immutable identity of the diff the comment was written on. */
  diffIdentityId: string;
  measurementId: string;
  scope: MeasurementScope;
  /** Opaque path identity of the file row, stable across identities of one path. */
  pathId: string;
  /** Display path, for the request and the list. */
  path: string;
  /**
   * Content of the compared sides when the comment was written (live file
   * identities only); a different value for the same path means it moved on.
   */
  contentKey: string | null;
  resourceKey?: string;
  kind: "line" | "hunk";
  /** Which side `line` counts on: removed lines on the old side, the rest on the new. */
  side: "old" | "new";
  /** Line number on `side`; null for a hunk comment. */
  line: number | null;
  hunkHeader: string;
  /** The code the comment was about, as shown when it was written. */
  excerpt: DiffCommentLine[];
  excerptTruncated: boolean;
}

export interface DiffComment {
  id: string;
  anchor: DiffCommentAnchor;
  body: string;
  /** Bumped on every edit; delivery removes a comment only at the revision it sent. */
  revision: number;
  /** Included in the next send. */
  selected: boolean;
  createdAt: number;
  editDraft?: string;
  /** The saved text was sent while this edit was open. */
  sentWhileEditing?: boolean;
}

export interface DiffCommentSend {
  requestId: string;
  tabId: string;
  items: ReadonlyArray<{ id: string; revision: number }>;
}

export interface NewDiffCommentDraft {
  anchor: DiffCommentAnchor;
  body: string;
}

export interface EnvironmentDiffComments {
  newDrafts: ReadonlyMap<string, NewDiffCommentDraft>;
  comments: readonly DiffComment[];
  /** The agent tab the last send went to (a preference; preselects only). */
  destinationTabId: string | null;
  /** The send in flight, if any; one at a time per environment. */
  sending: DiffCommentSend | null;
  /** Why the last send failed, until the next one starts. */
  lastError: string | null;
  /** pathId → content key of the live diff most recently shown for it. */
  liveContent: ReadonlyMap<string, string | null>;
}

export type DiffCommentSettlement = { sent: number; kept: number };

export interface DiffCommentsState {
  environments: ReadonlyMap<string, EnvironmentDiffComments>;
  /** Adds a comment; returns its id, or null when the environment is full or the body is blank. */
  addComment: (environmentId: string, anchor: DiffCommentAnchor, body: string) => string | null;
  setNewDraft: (environmentId: string, key: string, draft: NewDiffCommentDraft | null) => boolean;
  setEditDraft: (environmentId: string, commentId: string, body: string | null) => void;
  editComment: (environmentId: string, commentId: string, body: string) => void;
  removeComment: (environmentId: string, commentId: string) => void;
  setSelected: (environmentId: string, commentId: string, selected: boolean) => void;
  setAllSelected: (environmentId: string, selected: boolean) => void;
  setDestination: (environmentId: string, tabId: string) => void;
  observeLiveContent: (environmentId: string, pathId: string, contentKey: string | null) => void;
  /** Records a send of exactly these revisions; false when another send is in flight. */
  beginSend: (environmentId: string, send: DiffCommentSend) => boolean;
  /** The send landed: removes comments still at the revision it carried. */
  completeSend: (environmentId: string, requestId: string) => DiffCommentSettlement;
  /** The send failed or is unconfirmed: every comment stays. */
  failSend: (environmentId: string, requestId: string, error: string) => void;
  clearEnvironment: (environmentId: string) => void;
}

const EMPTY_ENVIRONMENT: EnvironmentDiffComments = Object.freeze({
  comments: [],
  newDrafts: new Map(),
  destinationTabId: null,
  sending: null,
  lastError: null,
  liveContent: new Map(),
});

export function environmentDiffComments(
  state: Pick<DiffCommentsState, "environments">,
  environmentId: string | null | undefined,
): EnvironmentDiffComments {
  return (environmentId ? state.environments.get(environmentId) : undefined) ?? EMPTY_ENVIRONMENT;
}

export function liveCommentPathKey(resourceKey: string | undefined, pathId: string): string {
  return resourceKey ? JSON.stringify([resourceKey, pathId]) : pathId;
}

export type DiffCommentFreshness = "current" | "outdated" | "unknown";

export function diffCommentFreshness(
  environment: Pick<EnvironmentDiffComments, "liveContent">,
  comment: DiffComment,
): DiffCommentFreshness {
  const { anchor } = comment;
  if (anchor.source !== "live") return "current";
  const current = environment.liveContent.get(
    liveCommentPathKey(anchor.resourceKey, anchor.pathId),
  );
  if (current == null || anchor.contentKey === null) return "unknown";
  return current === anchor.contentKey ? "current" : "outdated";
}

export function isDiffCommentSelected(comment: DiffComment): boolean {
  return comment.selected && !comment.sentWhileEditing;
}

function canHoldEnvironment(state: DiffCommentsState, environmentId: string): boolean {
  return (
    state.environments.has(environmentId) ||
    state.environments.size < MAX_ENVIRONMENTS ||
    Array.from(state.environments.values()).some(
      (entry) => !entry.comments.length && !entry.newDrafts.size && !entry.sending,
    )
  );
}

/** Bounds one captured line so a minified file cannot bloat the store or the request. */
export function captureDiffCommentLine(line: ChangeDiffLine): DiffCommentLine {
  return {
    type: line.type,
    text:
      line.text.length > MAX_DIFF_COMMENT_LINE_CHARACTERS
        ? `${line.text.slice(0, MAX_DIFF_COMMENT_LINE_CHARACTERS)}…`
        : line.text,
    oldLine: line.oldLine,
    newLine: line.newLine,
  };
}

function normalizeBody(body: string): string {
  const trimmed = body.trim();
  return trimmed.length > MAX_DIFF_COMMENT_BODY ? trimmed.slice(0, MAX_DIFF_COMMENT_BODY) : trimmed;
}

export const diffCommentsStore = defineScopedStore<DiffCommentsState>(
  "diff-comments",
  () => (set, get) => {
    /** Applies `update` to one environment, re-inserting it as most recently touched. */
    const update = (
      environmentId: string,
      change: (current: EnvironmentDiffComments) => EnvironmentDiffComments | null,
    ) =>
      set((state) => {
        const current = environmentDiffComments(state, environmentId);
        const nextEnvironment = change(current);
        if (nextEnvironment === null || nextEnvironment === current) return state;
        const environments = new Map(state.environments);
        environments.delete(environmentId);
        environments.set(environmentId, nextEnvironment);
        if (environments.size > MAX_ENVIRONMENTS) {
          for (const [id, entry] of Array.from(environments)) {
            if (entry.comments.length || entry.newDrafts.size || entry.sending) continue;
            environments.delete(id);
            break;
          }
        }
        return { environments };
      });

    const mapComment = (
      environmentId: string,
      commentId: string,
      change: (comment: DiffComment) => DiffComment,
    ) =>
      update(environmentId, (current) => {
        const index = current.comments.findIndex((comment) => comment.id === commentId);
        if (index < 0) return null;
        const comment = current.comments[index]!;
        const next = change(comment);
        if (next === comment) return null;
        const comments = [...current.comments];
        comments[index] = next;
        return { ...current, comments };
      });

    return {
      environments: new Map(),

      addComment: (environmentId, anchor, body) => {
        const text = normalizeBody(body);
        if (!text || !canHoldEnvironment(get(), environmentId)) return null;
        const current = environmentDiffComments(get(), environmentId);
        if (current.comments.length >= MAX_DIFF_COMMENTS_PER_ENVIRONMENT) return null;
        const id = createUuid();
        const excerpt = anchor.excerpt
          .slice(0, MAX_DIFF_COMMENT_EXCERPT_LINES)
          .map(captureDiffCommentLine);
        update(environmentId, (environment) => ({
          ...environment,
          comments: [
            ...environment.comments,
            {
              id,
              anchor: {
                ...anchor,
                excerpt,
                excerptTruncated: anchor.excerptTruncated || anchor.excerpt.length > excerpt.length,
              },
              body: text,
              revision: 1,
              selected: true,
              createdAt: Date.now(),
            },
          ],
        }));
        return id;
      },

      setNewDraft: (environmentId, key, draft) => {
        const state = get();
        const { newDrafts } = environmentDiffComments(state, environmentId);
        if (
          draft &&
          (!canHoldEnvironment(state, environmentId) ||
            (!newDrafts.has(key) && newDrafts.size >= MAX_DIFF_COMMENTS_PER_ENVIRONMENT))
        )
          return false;
        update(environmentId, (current) => {
          if (!draft && !current.newDrafts.has(key)) return null;
          const newDrafts = new Map(current.newDrafts);
          if (draft) newDrafts.set(key, draft);
          else newDrafts.delete(key);
          return { ...current, newDrafts };
        });
        return true;
      },

      setEditDraft: (environmentId, commentId, body) => {
        if (
          body === null &&
          environmentDiffComments(get(), environmentId).comments.some(
            (comment) => comment.id === commentId && comment.sentWhileEditing,
          )
        ) {
          get().removeComment(environmentId, commentId);
          return;
        }
        mapComment(environmentId, commentId, (comment) => ({
          ...comment,
          editDraft: body ?? undefined,
        }));
      },

      editComment: (environmentId, commentId, body) => {
        const text = normalizeBody(body);
        if (!text) return;
        mapComment(environmentId, commentId, (comment) => {
          const changed = comment.body !== text || comment.sentWhileEditing;
          return {
            ...comment,
            body: text,
            revision: changed ? comment.revision + 1 : comment.revision,
            editDraft: undefined,
            sentWhileEditing: undefined,
          };
        });
      },

      removeComment: (environmentId, commentId) =>
        update(environmentId, (current) => {
          const comments = current.comments.filter((comment) => comment.id !== commentId);
          return comments.length === current.comments.length ? null : { ...current, comments };
        }),

      setSelected: (environmentId, commentId, selected) =>
        mapComment(environmentId, commentId, (comment) =>
          comment.selected === selected ? comment : { ...comment, selected },
        ),

      setAllSelected: (environmentId, selected) =>
        update(environmentId, (current) =>
          current.comments.every((comment) => comment.selected === selected)
            ? null
            : {
                ...current,
                comments: current.comments.map((comment) =>
                  comment.selected === selected ? comment : { ...comment, selected },
                ),
              },
        ),

      setDestination: (environmentId, tabId) =>
        update(environmentId, (current) =>
          current.destinationTabId === tabId ? null : { ...current, destinationTabId: tabId },
        ),

      observeLiveContent: (environmentId, pathId, contentKey) =>
        update(environmentId, (current) => {
          if (current.liveContent.get(pathId) === contentKey) return null;
          const liveContent = new Map(current.liveContent);
          liveContent.delete(pathId);
          liveContent.set(pathId, contentKey);
          while (liveContent.size > MAX_OBSERVED_PATHS) {
            const oldest = liveContent.keys().next().value;
            if (oldest === undefined) break;
            liveContent.delete(oldest);
          }
          return { ...current, liveContent };
        }),

      beginSend: (environmentId, send) => {
        if (
          !canHoldEnvironment(get(), environmentId) ||
          environmentDiffComments(get(), environmentId).sending
        )
          return false;
        update(environmentId, (current) => ({
          ...current,
          destinationTabId: send.tabId,
          sending: send,
          lastError: null,
        }));
        return true;
      },

      completeSend: (environmentId, requestId) => {
        let settlement: DiffCommentSettlement = { sent: 0, kept: 0 };
        update(environmentId, (current) => {
          if (current.sending?.requestId !== requestId) return null;
          const sentRevisions = new Map(
            current.sending.items.map((item) => [item.id, item.revision]),
          );
          let kept = 0;
          const comments = current.comments.flatMap((comment) => {
            const revision = sentRevisions.get(comment.id);
            if (revision === undefined) return [comment];
            if (revision !== comment.revision) {
              kept++;
              return [comment];
            }
            if (comment.editDraft !== undefined) {
              kept++;
              return [{ ...comment, sentWhileEditing: true }];
            }
            return [];
          });
          settlement = { sent: current.sending.items.length, kept };
          return {
            ...current,
            comments,
            sending: null,
            lastError: null,
          };
        });
        return settlement;
      },

      failSend: (environmentId, requestId, error) =>
        update(environmentId, (current) =>
          current.sending?.requestId !== requestId
            ? null
            : { ...current, sending: null, lastError: error },
        ),

      clearEnvironment: (environmentId) =>
        set((state) => {
          if (!state.environments.has(environmentId)) return state;
          const environments = new Map(state.environments);
          environments.delete(environmentId);
          return { environments };
        }),
    };
  },
);

/** Reads the nearest node scope's diff comments; other code uses `scope.store(diffCommentsStore)`. */
export const useDiffCommentsStore = scopedStoreHook(diffCommentsStore);
