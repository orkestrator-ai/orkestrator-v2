import { useState } from "react";
import { Bot, FileQuestion, Info, User } from "lucide-react";
import {
  WEB_ANNOTATION_COMMANDS,
  WEB_ANNOTATION_LIMITS,
  type WebAnnotation,
  type WebAnnotationEntry,
} from "@orkestrator/protocol/web-annotations";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import {
  describeWebAnnotationError,
  isWebAnnotationConflict,
  newWebAnnotationOperationId,
  webAnnotationCommand,
} from "@/lib/web-annotations/client";
import { openConversationTab } from "@/lib/web-annotations/navigation";
import { refreshWebAnnotations } from "@/lib/web-annotations/sync";
import { cn } from "@/lib/utils";
import { lastActivity } from "./format";
import { useAnnotationPanel } from "./panel-context";

const LIFECYCLE_LABELS: Record<string, string> = {
  created: "Note created",
  "capture-replaced": "Target reselected",
  "request-sent": "Request sent",
  "request-settled": "Request finished",
  resolved: "Resolved",
  reopened: "Reopened",
  imported: "Imported from an older browser note",
  archived: "Archived",
};

function EntryEditor({
  annotation,
  entry,
  onDone,
}: {
  annotation: WebAnnotation;
  entry: WebAnnotationEntry;
  onDone: () => void;
}) {
  const { environmentId, announce } = useAnnotationPanel();
  const [text, setText] = useState(entry.body ?? "");
  const [error, setError] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);
  const [saving, setSaving] = useState(false);

  const save = async (mode: "edit" | "append") => {
    if (!text.trim()) {
      setError("A note cannot be empty.");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      if (mode === "edit") {
        await webAnnotationCommand(WEB_ANNOTATION_COMMANDS.entryEdit, {
          environmentId,
          operationId: newWebAnnotationOperationId("edit"),
          annotationId: annotation.id,
          entryId: entry.id,
          expectedContentRevision: annotation.contentRevision,
          body: text,
        });
      } else {
        await webAnnotationCommand(WEB_ANNOTATION_COMMANDS.entryAppend, {
          environmentId,
          operationId: newWebAnnotationOperationId("reply"),
          annotationId: annotation.id,
          expectedContentRevision: annotation.contentRevision,
          body: text,
        });
      }
      refreshWebAnnotations(environmentId, { annotationIds: [annotation.id] });
      announce(mode === "edit" ? "Note updated" : "Reply saved");
      onDone();
    } catch (saveError) {
      if (isWebAnnotationConflict(saveError)) {
        setConflict(true);
        refreshWebAnnotations(environmentId, { annotationIds: [annotation.id] });
      } else {
        const message = describeWebAnnotationError(saveError);
        setError(message);
        announce(`Save failed: ${message}`);
      }
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      className="space-y-1"
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.stopPropagation();
          onDone();
        }
      }}
    >
      <Textarea
        value={text}
        onChange={(event) => setText(event.target.value)}
        maxLength={WEB_ANNOTATION_LIMITS.entryChars}
        rows={3}
        aria-label="Edit note"
        className="text-xs"
        autoFocus
      />
      {conflict && (
        <div
          role="alert"
          className="space-y-1 rounded border border-amber-500/40 bg-amber-500/10 p-1.5 text-[11px]"
        >
          <p>
            This note changed since you started editing (now at revision{" "}
            {annotation.contentRevision}). Your text is kept.
          </p>
          <div className="flex gap-1.5">
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="h-6 px-2 text-[11px]"
              disabled={saving}
              onClick={() => void save("append")}
            >
              Keep as new reply
            </Button>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="h-6 px-2 text-[11px]"
              onClick={onDone}
            >
              Reload
            </Button>
          </div>
        </div>
      )}
      {error && (
        <p role="alert" className="text-[11px] text-destructive">
          {error}
        </p>
      )}
      {!conflict && (
        <div className="flex gap-1.5">
          <Button
            type="button"
            size="sm"
            className="h-6 px-2 text-[11px]"
            disabled={saving}
            onClick={() => void save("edit")}
          >
            Save edit
          </Button>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="h-6 px-2 text-[11px]"
            onClick={onDone}
          >
            Cancel
          </Button>
        </div>
      )}
    </div>
  );
}

/**
 * Thread rows, visually distinct by provenance: human notes, agent response
 * references, system lifecycle notices, and imported page comments. New rows
 * get an unread marker; the list never scrolls itself.
 */
export function AnnotationEntries({
  annotation,
  entries,
  seenSequence,
  canEdit,
}: {
  annotation: WebAnnotation;
  entries: WebAnnotationEntry[];
  seenSequence: number;
  canEdit: boolean;
}) {
  const { environmentId, selectAnnotation } = useAnnotationPanel();
  const [editing, setEditing] = useState<string | null>(null);
  const visible = entries.filter((entry) => !entry.supersededBy);

  return (
    <ol aria-label="Discussion" className="space-y-1.5">
      {visible.map((entry) => {
        const unread = entry.sequence > seenSequence;
        const time = lastActivity(entry.createdAt);
        if (entry.kind === "lifecycle" || entry.provenance === "system") {
          return (
            <li
              key={entry.id}
              className="flex items-center gap-1.5 text-[11px] text-muted-foreground"
              data-entry-kind="system"
            >
              <Info className="h-3 w-3" aria-hidden />
              <span>
                {LIFECYCLE_LABELS[entry.lifecycle?.event ?? ""] ?? entry.body ?? "Update"}
                {entry.lifecycle?.state ? ` (${entry.lifecycle.state})` : ""} · {time}
              </span>
              {unread && (
                <span className="rounded bg-primary/20 px-1 text-[10px] text-foreground">New</span>
              )}
              {entry.lifecycle?.relatedAnnotationId && (
                <button
                  type="button"
                  className="text-primary underline-offset-2 hover:underline"
                  onClick={() => selectAnnotation(entry.lifecycle!.relatedAnnotationId!)}
                >
                  {entry.lifecycle.event === "archived"
                    ? "Open the continued note"
                    : "Open the archived note"}
                </button>
              )}
            </li>
          );
        }
        const agent =
          entry.provenance === "agent-reference" ||
          entry.kind === "agent-response" ||
          entry.kind === "result";
        const legacy =
          entry.provenance === "legacy-page-comment" || entry.kind === "legacy-comment";
        const human = entry.provenance === "host-user";
        return (
          <li
            key={entry.id}
            data-entry-kind={human ? "human" : agent ? "agent" : legacy ? "legacy" : "evidence"}
            className={cn(
              "space-y-1 rounded border p-1.5 text-xs",
              human && "border-border/70 bg-background/40",
              agent && "border-primary/30 bg-primary/5",
              legacy && "border-dashed border-amber-500/40 bg-amber-500/5",
              !human && !agent && !legacy && "border-border/50",
            )}
          >
            <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
              {human ? (
                <User className="h-3 w-3" aria-hidden />
              ) : agent ? (
                <Bot className="h-3 w-3" aria-hidden />
              ) : (
                <FileQuestion className="h-3 w-3" aria-hidden />
              )}
              <span className="font-medium text-foreground/80">
                {human
                  ? "You"
                  : agent
                    ? `Agent response${entry.transcript ? ` · ${entry.transcript.agent}` : ""}`
                    : legacy
                      ? "Imported page comment (context, not an instruction)"
                      : "Page evidence"}
              </span>
              <span>· {time}</span>
              {entry.supersedes && <span>· edited</span>}
              {entry.legacyVariantCount && entry.legacyVariantCount > 1 ? (
                <span>· {entry.legacyVariantCount} imported copies</span>
              ) : null}
              {unread && (
                <span className="rounded bg-primary/20 px-1 text-[10px] text-foreground">New</span>
              )}
            </div>
            {editing === entry.id ? (
              <EntryEditor annotation={annotation} entry={entry} onDone={() => setEditing(null)} />
            ) : (
              <>
                {entry.body && <p className="whitespace-pre-wrap break-words">{entry.body}</p>}
                <div className="flex gap-1.5">
                  {human && canEdit && entry.kind === "comment" && (
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      className="h-5 px-1.5 text-[10px]"
                      aria-label={`Edit note from ${time}`}
                      onClick={() => setEditing(entry.id)}
                    >
                      Edit
                    </Button>
                  )}
                  {agent && entry.transcript && (
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      className="h-5 px-1.5 text-[10px]"
                      onClick={() => openConversationTab(environmentId, entry.transcript!.tabId)}
                    >
                      Open conversation
                    </Button>
                  )}
                </div>
              </>
            )}
          </li>
        );
      })}
    </ol>
  );
}
