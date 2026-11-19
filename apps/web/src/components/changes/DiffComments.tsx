import { useCallback, useMemo, useState, type ReactNode } from "react";
import { History, MessageSquarePlus, Pencil, Trash2 } from "lucide-react";
import type {
  ChangeDiffFileBody,
  ChangeDiffLine,
  DiffIdentity,
} from "@orkestrator/protocol/change-resources";
import { toast } from "sonner";
import { diffContentKey } from "@/lib/changes/diff-comment-freshness";
import { cn } from "@/lib/utils";
import { diffCommentLocation } from "@/lib/changes/diff-comment-request";
import { detectShortcutPlatform } from "@/lib/keyboard-shortcuts";
import {
  MAX_DIFF_COMMENT_BODY,
  MAX_DIFF_COMMENT_EXCERPT_LINES,
  captureDiffCommentLine,
  environmentDiffComments,
  diffCommentFreshness,
  useDiffCommentsStore,
  type DiffComment,
  type DiffCommentAnchor,
  type EnvironmentDiffComments,
  type NewDiffCommentDraft,
} from "@/stores/diffCommentsStore";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import {
  ChangeHunksView,
  type ChangeHunksAnnotations,
  type HunkNavigationProps,
} from "./ChangeHunksView";

/**
 * Review comments on a backend-rendered diff (`diffCommentsStore`).
 *
 * A comment is written on one line or one hunk of the identity on screen, and
 * keeps that identity and the lines it was about. It is shown under its line
 * while the view still shows the content it was written on; otherwise it is
 * listed above the file as written on an earlier version, never silently
 * re-attached to whatever line now has that number.
 */

/** Where a line comment attaches: removed lines count on the old side, the rest on the new. */
export function diffLineAnchor(line: ChangeDiffLine): { side: "old" | "new"; line: number } | null {
  if (line.type === "remove")
    return line.oldLine === null ? null : { side: "old", line: line.oldLine };
  if (line.type === "add" || line.type === "context")
    return line.newLine === null ? null : { side: "new", line: line.newLine };
  return null;
}

export interface DiffCommentContext {
  environmentId: string;
  identity: DiffIdentity;
  source: "live" | "historical";
  resourceKey?: string;
}

export function diffCommentDraftKey(pathId: string, context: DiffCommentContext): string {
  const { source, identity, resourceKey } = context;
  return JSON.stringify([source, pathId, source === "historical" ? identity.id : resourceKey]);
}

function lineKey(hunkIndex: number, anchor: { side: string; line: number }): string {
  return `${hunkIndex}:${anchor.side}:${anchor.line}`;
}

// -----------------------------------------------------------------------------
// Editor and card
// -----------------------------------------------------------------------------

export function DiffCommentEditor({
  body,
  onChange,
  label,
  submitLabel,
  onSubmit,
  onCancel,
}: {
  body: string;
  onChange: (body: string) => void;
  label: string;
  submitLabel: string;
  onSubmit: (body: string) => string | void;
  onCancel: () => void;
}) {
  const [error, setError] = useState<string>();
  const submit = () => {
    if (body.trim()) setError(onSubmit(body) || undefined);
  };
  return (
    <div
      data-testid="diff-comment-editor"
      className="flex flex-col gap-1.5 whitespace-normal font-sans"
    >
      <Textarea
        autoFocus
        aria-label={label}
        value={body}
        maxLength={MAX_DIFF_COMMENT_BODY}
        placeholder="Describe what should change…"
        className="min-h-14 text-xs md:text-xs"
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
            event.preventDefault();
            submit();
          } else if (event.key === "Escape") {
            event.preventDefault();
            onCancel();
          }
        }}
      />
      {error && (
        <p role="alert" className="text-failure">
          {error}
        </p>
      )}
      <div className="flex items-center justify-end gap-1.5">
        <span className="mr-auto text-[10px] text-muted-foreground">
          {detectShortcutPlatform() === "mac" ? "⌘" : "Ctrl"}+Enter to save · Esc to cancel
        </span>
        <Button type="button" variant="ghost" size="sm" className="h-7 px-2" onClick={onCancel}>
          Cancel
        </Button>
        <Button
          type="button"
          size="sm"
          className="h-7 px-2"
          disabled={!body.trim()}
          onClick={submit}
        >
          {submitLabel}
        </Button>
      </div>
    </div>
  );
}

export function NewDiffCommentEditor({
  environmentId,
  draftKey,
  draft,
}: {
  environmentId: string;
  draftKey: string;
  draft: NewDiffCommentDraft;
}) {
  const addComment = useDiffCommentsStore((state) => state.addComment);
  const setNewDraft = useDiffCommentsStore((state) => state.setNewDraft);
  const close = () => setNewDraft(environmentId, draftKey, null);
  const location = diffCommentLocation({ anchor: draft.anchor });
  return (
    <DiffCommentEditor
      body={draft.body}
      onChange={(body) => setNewDraft(environmentId, draftKey, { ...draft, body })}
      label={`Comment on ${location}`}
      submitLabel="Add comment"
      onSubmit={(body) => {
        if (!addComment(environmentId, draft.anchor, body)) {
          return "This environment has reached its comment limit. Delete or send a comment before saving this draft.";
        }
        close();
      }}
      onCancel={close}
    />
  );
}

export function DiffCommentCard({
  environmentId,
  comment,
  environment,
  showLocation = false,
  leading,
}: {
  environmentId: string;
  comment: DiffComment;
  environment: EnvironmentDiffComments;
  showLocation?: boolean;
  leading?: ReactNode;
}) {
  const editComment = useDiffCommentsStore((state) => state.editComment);
  const removeComment = useDiffCommentsStore((state) => state.removeComment);
  const setEditDraft = useDiffCommentsStore((state) => state.setEditDraft);
  const freshness = diffCommentFreshness(environment, comment);
  const editing = comment.editDraft !== undefined;
  const inFlight = environment.sending?.items.find((item) => item.id === comment.id);
  const location = diffCommentLocation(comment);
  return (
    <div
      data-testid="diff-comment"
      data-comment-id={comment.id}
      className="flex gap-2 whitespace-normal rounded-md border border-border/70 bg-background/95 px-2.5 py-2 font-sans text-xs text-foreground shadow-sm"
    >
      {leading}
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        {(showLocation || freshness !== "current" || inFlight) && (
          <div className="flex min-w-0 flex-wrap items-center gap-1.5 text-[11px] text-muted-foreground">
            {showLocation && (
              <span className="min-w-0 truncate font-mono" title={location}>
                {location}
              </span>
            )}
            {freshness === "outdated" && (
              <span
                className="inline-flex shrink-0 items-center gap-1 rounded bg-yellow-500/15 px-1.5 py-px text-yellow-400"
                title="The file has changed since this comment was written; the request quotes the code it was written about."
              >
                <History className="h-3 w-3" aria-hidden="true" />
                Outdated
              </span>
            )}
            {freshness === "unknown" && <span>Freshness unknown</span>}
            {inFlight &&
              (inFlight.revision === comment.revision ? (
                <span className="shrink-0 rounded bg-primary/15 px-1.5 py-px text-blue-300">
                  Sending…
                </span>
              ) : (
                <span
                  className="shrink-0 rounded bg-primary/15 px-1.5 py-px text-blue-300"
                  title="The earlier text is being sent; this edit will be kept for the next send."
                >
                  Edited while sending
                </span>
              ))}
          </div>
        )}
        {editing ? (
          <DiffCommentEditor
            body={comment.editDraft ?? comment.body}
            onChange={(body) => setEditDraft(environmentId, comment.id, body)}
            label={`Edit comment on ${location}`}
            submitLabel="Save"
            onSubmit={(body) => editComment(environmentId, comment.id, body)}
            onCancel={() => setEditDraft(environmentId, comment.id, null)}
          />
        ) : (
          <p className="whitespace-pre-wrap break-words">{comment.body}</p>
        )}
      </div>
      {!editing && (
        <div className="flex shrink-0 items-start gap-0.5">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-6 w-6 p-0"
            aria-label={`Edit comment on ${location}`}
            title="Edit"
            onClick={() => setEditDraft(environmentId, comment.id, comment.body)}
          >
            <Pencil className="h-3 w-3" />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-6 w-6 p-0"
            aria-label={`Delete comment on ${location}`}
            title="Delete"
            onClick={() => removeComment(environmentId, comment.id)}
          >
            <Trash2 className="h-3 w-3" />
          </Button>
        </div>
      )}
    </div>
  );
}

// -----------------------------------------------------------------------------
// One file of the diff, with its comments
// -----------------------------------------------------------------------------

/** The add-comment control in a row's gutter: shown on hover or focus, always on touch. */
function GutterButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      className={cn(
        "absolute left-1 top-0.5 flex h-4 w-4 items-center justify-center rounded bg-primary-fill text-primary-foreground",
        "opacity-0 transition-opacity focus-visible:opacity-100 group-hover/diff-line:opacity-100",
        "[@media(hover:none)]:opacity-60",
      )}
    >
      <MessageSquarePlus className="h-3 w-3" aria-hidden="true" />
    </button>
  );
}

export function CommentableHunks({
  file,
  mode,
  context,
  ...navigation
}: HunkNavigationProps & {
  file: ChangeDiffFileBody;
  mode: "unified" | "split";
  context: DiffCommentContext;
}) {
  const { environmentId, identity, source, resourceKey } = context;
  const environment = useDiffCommentsStore((state) =>
    environmentDiffComments(state, environmentId),
  );
  const setNewDraft = useDiffCommentsStore((state) => state.setNewDraft);
  const draftKey = diffCommentDraftKey(file.pathId, context);
  const draft = environment.newDrafts.get(draftKey);
  const draftAnchor = draft?.anchor;
  const path = file.newPathDisplay ?? file.oldPathDisplay ?? file.pathId;
  const contentKey = source === "live" ? diffContentKey(identity) : null;

  // Comments on this file, split into the ones this view can place and the rest.
  const { placed, elsewhere, draftSlot } = useMemo(() => {
    const placedComments = new Map<string, DiffComment[]>();
    const others: DiffComment[] = [];
    const hunkIndexByHeader = new Map(file.hunks.map((hunk, index) => [hunk.header, index]));
    const lineKeys = new Set<string>();
    file.hunks.forEach((hunk, hunkIndex) => {
      for (const line of hunk.lines) {
        const anchor = diffLineAnchor(line);
        if (anchor) lineKeys.add(lineKey(hunkIndex, anchor));
      }
    });
    const slotFor = (anchor: DiffCommentAnchor) => {
      const sameContent =
        anchor.diffIdentityId === identity.id ||
        (contentKey !== null && anchor.contentKey === contentKey);
      if (!sameContent) return null;
      const hunkIndex = hunkIndexByHeader.get(anchor.hunkHeader);
      if (hunkIndex === undefined) return null;
      if (anchor.kind === "hunk" || anchor.line === null) return `${hunkIndex}:hunk`;
      const key = lineKey(hunkIndex, { side: anchor.side, line: anchor.line });
      return lineKeys.has(key) ? key : null;
    };
    for (const comment of environment.comments) {
      if (comment.anchor.pathId !== file.pathId) continue;
      const key = slotFor(comment.anchor);
      if (key) {
        placedComments.set(key, [...(placedComments.get(key) ?? []), comment]);
      } else {
        others.push(comment);
      }
    }
    return {
      placed: placedComments,
      elsewhere: others,
      draftSlot: draftAnchor ? slotFor(draftAnchor) : null,
    };
  }, [contentKey, draftAnchor, environment.comments, file.hunks, file.pathId, identity.id]);

  const anchorBase = useCallback(
    (hunkIndex: number): Omit<DiffCommentAnchor, "kind" | "side" | "line" | "excerpt"> => ({
      source,
      diffIdentityId: identity.id,
      measurementId: identity.measurementId,
      scope: identity.scope,
      pathId: file.pathId,
      path,
      contentKey,
      resourceKey,
      hunkHeader: file.hunks[hunkIndex]?.header ?? "",
      excerptTruncated: false,
    }),
    [contentKey, file.hunks, file.pathId, identity, path, resourceKey, source],
  );

  const renderComments = (comments: readonly DiffComment[] | undefined, showLocation = false) =>
    comments?.map((comment) => (
      <DiffCommentCard
        key={comment.id}
        environmentId={environmentId}
        comment={comment}
        environment={environment}
        showLocation={showLocation}
      />
    ));

  const renderNewEditor = (key: string | null) =>
    draft && draftSlot === key ? (
      <NewDiffCommentEditor environmentId={environmentId} draftKey={draftKey} draft={draft} />
    ) : null;

  const openDraft = (anchor: DiffCommentAnchor) => {
    if (draft) {
      toast.info("Save or cancel the open comment draft first.");
      return;
    }
    if (!setNewDraft(environmentId, draftKey, { anchor, body: "" })) {
      toast.error("Comment draft limit reached. Save or cancel an open draft.");
    }
  };

  const slot = (key: string) => {
    const comments = placed.get(key);
    const newEditor = renderNewEditor(key);
    if (!comments?.length && !newEditor) return null;
    return (
      <div
        key={`comments:${key}`}
        className="flex flex-col gap-1.5 border-y border-border/40 bg-muted/20 px-3 py-2"
      >
        {renderComments(comments)}
        {newEditor}
      </div>
    );
  };

  const annotations: ChangeHunksAnnotations = {
    lineAction: (hunkIndex, line) => {
      const anchor = diffLineAnchor(line);
      if (!anchor) return null;
      const label =
        anchor.side === "old"
          ? `Comment on ${path} removed line ${anchor.line}`
          : `Comment on ${path} line ${anchor.line}`;
      return (
        <GutterButton
          label={label}
          onClick={() =>
            openDraft({
              ...anchorBase(hunkIndex),
              kind: "line",
              side: anchor.side,
              line: anchor.line,
              excerpt: [captureDiffCommentLine(line)],
            })
          }
        />
      );
    },
    afterLines: (hunkIndex, lines) => {
      const slots = lines
        .map((line) => diffLineAnchor(line))
        .filter((anchor) => anchor !== null)
        .map((anchor) => slot(lineKey(hunkIndex, anchor)))
        .filter((node) => node !== null);
      return slots.length > 0 ? slots : null;
    },
    hunkAction: (hunkIndex) => {
      const hunk = file.hunks[hunkIndex];
      if (!hunk) return null;
      return (
        <GutterButton
          label={`Comment on ${path} hunk ${hunk.header}`}
          onClick={() =>
            openDraft({
              ...anchorBase(hunkIndex),
              kind: "hunk",
              side: "new",
              line: null,
              excerpt: hunk.lines
                .slice(0, MAX_DIFF_COMMENT_EXCERPT_LINES)
                .map(captureDiffCommentLine),
              excerptTruncated: hunk.lines.length > MAX_DIFF_COMMENT_EXCERPT_LINES,
            })
          }
        />
      );
    },
    afterHeader: (hunkIndex) => slot(`${hunkIndex}:hunk`),
  };

  return (
    <>
      {(elsewhere.length > 0 || (draft && draftSlot === null)) && (
        <div
          data-testid="diff-comments-elsewhere"
          className="flex flex-col gap-1.5 border-b border-border/40 bg-yellow-500/5 px-3 py-2"
        >
          {elsewhere.length > 0 && (
            <p className="text-[11px] text-muted-foreground">
              {elsewhere.length === 1
                ? "1 comment on this file is not on a line shown here."
                : `${elsewhere.length} comments on this file are not on a line shown here.`}{" "}
              Each keeps the code it was written about.
            </p>
          )}
          {renderComments(elsewhere, true)}
          {draft && draftSlot === null && (
            <p className="text-[11px] text-muted-foreground">Draft on an earlier diff</p>
          )}
          {renderNewEditor(null)}
        </div>
      )}
      <ChangeHunksView
        file={file}
        mode={mode}
        maxHeightClass="max-h-none"
        annotations={annotations}
        {...navigation}
      />
    </>
  );
}
