import { useCallback, useMemo, useState, type ReactNode } from "react";
import { History, MessageSquarePlus, Pencil, Trash2 } from "lucide-react";
import type {
  ChangeDiffFileBody,
  ChangeDiffLine,
  DiffFileSide,
  DiffIdentity,
} from "@orkestrator/protocol/change-resources";
import { cn } from "@/lib/utils";
import { diffCommentLocation } from "@/lib/changes/diff-comment-request";
import { detectShortcutPlatform } from "@/lib/keyboard-shortcuts";
import {
  MAX_DIFF_COMMENT_BODY,
  MAX_DIFF_COMMENT_EXCERPT_LINES,
  environmentDiffComments,
  isDiffCommentOutdated,
  useDiffCommentsStore,
  type DiffComment,
  type DiffCommentAnchor,
  type EnvironmentDiffComments,
} from "@/stores/diffCommentsStore";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { ChangeHunksView, type ChangeHunksAnnotations } from "./ChangeHunksView";

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

function sideKey(side: DiffFileSide): string | null {
  if (side.state === "present") return `blob:${side.blobId}`;
  if (side.state === "absent") return "absent";
  return null;
}

/** Both compared sides of a file identity; null when either side is unknown. */
export function diffContentKey(identity: DiffIdentity): string | null {
  if (identity.kind !== "file") return null;
  const before = sideKey(identity.before);
  const after = sideKey(identity.after);
  return before === null || after === null ? null : `${before}|${after}`;
}

export interface DiffCommentContext {
  environmentId: string;
  identity: DiffIdentity;
  source: "live" | "historical";
}

type EditorTarget =
  { kind: "new"; key: string; anchor: DiffCommentAnchor } | { kind: "edit"; commentId: string };

function lineKey(hunkIndex: number, anchor: { side: string; line: number }): string {
  return `${hunkIndex}:${anchor.side}:${anchor.line}`;
}

// -----------------------------------------------------------------------------
// Editor and card
// -----------------------------------------------------------------------------

export function DiffCommentEditor({
  initialBody = "",
  label,
  submitLabel,
  onSubmit,
  onCancel,
}: {
  initialBody?: string;
  label: string;
  submitLabel: string;
  onSubmit: (body: string) => void;
  onCancel: () => void;
}) {
  const [body, setBody] = useState(initialBody);
  const submit = () => {
    if (body.trim()) onSubmit(body);
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
        onChange={(event) => setBody(event.target.value)}
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

export function DiffCommentCard({
  environmentId,
  comment,
  environment,
  showLocation = false,
  editing,
  onEdit,
  onCancelEdit,
  leading,
}: {
  environmentId: string;
  comment: DiffComment;
  environment: EnvironmentDiffComments;
  showLocation?: boolean;
  editing: boolean;
  onEdit: () => void;
  onCancelEdit: () => void;
  leading?: ReactNode;
}) {
  const editComment = useDiffCommentsStore((state) => state.editComment);
  const removeComment = useDiffCommentsStore((state) => state.removeComment);
  const outdated = isDiffCommentOutdated(environment, comment);
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
        {(showLocation || outdated || inFlight) && (
          <div className="flex min-w-0 flex-wrap items-center gap-1.5 text-[11px] text-muted-foreground">
            {showLocation && (
              <span className="min-w-0 truncate font-mono" title={location}>
                {location}
              </span>
            )}
            {outdated && (
              <span
                className="inline-flex shrink-0 items-center gap-1 rounded bg-yellow-500/15 px-1.5 py-px text-yellow-400"
                title="The file has changed since this comment was written; the request quotes the code it was written about."
              >
                <History className="h-3 w-3" aria-hidden="true" />
                Outdated
              </span>
            )}
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
            initialBody={comment.body}
            label={`Edit comment on ${location}`}
            submitLabel="Save"
            onSubmit={(body) => {
              editComment(environmentId, comment.id, body);
              onCancelEdit();
            }}
            onCancel={onCancelEdit}
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
            onClick={onEdit}
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
}: {
  file: ChangeDiffFileBody;
  mode: "unified" | "split";
  context: DiffCommentContext;
}) {
  const { environmentId, identity, source } = context;
  const environment = useDiffCommentsStore((state) =>
    environmentDiffComments(state, environmentId),
  );
  const addComment = useDiffCommentsStore((state) => state.addComment);
  const [editor, setEditor] = useState<EditorTarget | null>(null);
  const path = file.newPathDisplay ?? file.oldPathDisplay ?? file.pathId;
  const contentKey = source === "live" ? diffContentKey(identity) : null;

  // Comments on this file, split into the ones this view can place and the rest.
  const { placed, elsewhere } = useMemo(() => {
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
    for (const comment of environment.comments) {
      const { anchor } = comment;
      if (anchor.pathId !== file.pathId) continue;
      const sameContent =
        anchor.diffIdentityId === identity.id ||
        (contentKey !== null && anchor.contentKey === contentKey);
      const hunkIndex = hunkIndexByHeader.get(anchor.hunkHeader);
      const key =
        hunkIndex === undefined
          ? null
          : anchor.kind === "hunk" || anchor.line === null
            ? `${hunkIndex}:hunk`
            : lineKey(hunkIndex, { side: anchor.side, line: anchor.line });
      if (sameContent && key && (key.endsWith(":hunk") || lineKeys.has(key))) {
        placedComments.set(key, [...(placedComments.get(key) ?? []), comment]);
      } else {
        others.push(comment);
      }
    }
    return { placed: placedComments, elsewhere: others };
  }, [contentKey, environment.comments, file.hunks, file.pathId, identity.id]);

  const anchorBase = useCallback(
    (hunkIndex: number): Omit<DiffCommentAnchor, "kind" | "side" | "line" | "excerpt"> => ({
      source,
      diffIdentityId: identity.id,
      measurementId: identity.measurementId,
      scope: identity.scope,
      pathId: file.pathId,
      path,
      contentKey,
      hunkHeader: file.hunks[hunkIndex]?.header ?? "",
      excerptTruncated: false,
    }),
    [contentKey, file.hunks, file.pathId, identity, path, source],
  );

  const renderComments = (comments: readonly DiffComment[] | undefined, showLocation = false) =>
    comments?.map((comment) => (
      <DiffCommentCard
        key={comment.id}
        environmentId={environmentId}
        comment={comment}
        environment={environment}
        showLocation={showLocation}
        editing={editor?.kind === "edit" && editor.commentId === comment.id}
        onEdit={() => setEditor({ kind: "edit", commentId: comment.id })}
        onCancelEdit={() => setEditor(null)}
      />
    ));

  const renderNewEditor = (key: string) => {
    if (editor?.kind !== "new" || editor.key !== key) return null;
    const location = diffCommentLocation({
      id: "",
      anchor: editor.anchor,
      body: "",
      revision: 0,
      selected: true,
      createdAt: 0,
    });
    return (
      <DiffCommentEditor
        label={`Comment on ${location}`}
        submitLabel="Add comment"
        onSubmit={(body) => {
          addComment(environmentId, editor.anchor, body);
          setEditor(null);
        }}
        onCancel={() => setEditor(null)}
      />
    );
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
            setEditor({
              kind: "new",
              key: lineKey(hunkIndex, anchor),
              anchor: {
                ...anchorBase(hunkIndex),
                kind: "line",
                side: anchor.side,
                line: anchor.line,
                excerpt: [line],
              },
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
            setEditor({
              kind: "new",
              key: `${hunkIndex}:hunk`,
              anchor: {
                ...anchorBase(hunkIndex),
                kind: "hunk",
                side: "new",
                line: null,
                excerpt: hunk.lines.slice(0, MAX_DIFF_COMMENT_EXCERPT_LINES),
                excerptTruncated: hunk.lines.length > MAX_DIFF_COMMENT_EXCERPT_LINES,
              },
            })
          }
        />
      );
    },
    afterHeader: (hunkIndex) => slot(`${hunkIndex}:hunk`),
  };

  return (
    <>
      {elsewhere.length > 0 && (
        <div
          data-testid="diff-comments-elsewhere"
          className="flex flex-col gap-1.5 border-b border-border/40 bg-yellow-500/5 px-3 py-2"
        >
          <p className="text-[11px] text-muted-foreground">
            {elsewhere.length === 1
              ? "1 comment on this file is not on a line shown here."
              : `${elsewhere.length} comments on this file are not on a line shown here.`}{" "}
            Each keeps the code it was written about.
          </p>
          {renderComments(elsewhere, true)}
        </div>
      )}
      <ChangeHunksView
        file={file}
        mode={mode}
        maxHeightClass="max-h-none"
        annotations={annotations}
      />
    </>
  );
}
