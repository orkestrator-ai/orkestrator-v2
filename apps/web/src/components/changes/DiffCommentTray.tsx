import { useMemo, useState } from "react";
import { ChevronDown, ChevronUp, Copy, Loader2, MessageSquare, Send } from "lucide-react";
import { toast } from "sonner";
import { useShallow } from "zustand/react/shallow";
import { useNodeScope } from "@/lib/node-scope/providers";
import { writeText } from "@/lib/native/clipboard";
import {
  defaultDiffCommentDestination,
  diffCommentDestinations,
  selectedDiffCommentRequest,
  sendDiffComments,
} from "@/lib/changes/diff-comment-delivery";
import { MAX_DIFF_COMMENT_REQUEST_CHARACTERS } from "@/lib/changes/diff-comment-request";
import { environmentDiffComments, useDiffCommentsStore } from "@/stores/diffCommentsStore";
import { usePaneLayoutStore } from "@/stores/paneLayoutStore";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { NativeSelect } from "@/components/ui/native-select";
import { DiffCommentCard } from "./DiffComments";

/**
 * The environment's diff comments as one batch: pick which to include, pick
 * the agent chat, and send them as a single correction request. Shown at the
 * foot of every diff tab of the environment while it has comments.
 */

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

export function DiffCommentTray({ environmentId }: { environmentId: string }) {
  const scope = useNodeScope();
  const environment = useDiffCommentsStore((state) =>
    environmentDiffComments(state, environmentId),
  );
  const setSelected = useDiffCommentsStore((state) => state.setSelected);
  const setAllSelected = useDiffCommentsStore((state) => state.setAllSelected);
  const setDestination = useDiffCommentsStore((state) => state.setDestination);
  const tabs = usePaneLayoutStore(useShallow((state) => state.getAllTabs(environmentId)));
  const destinations = useMemo(() => diffCommentDestinations(tabs), [tabs]);
  const destination = defaultDiffCommentDestination(destinations, environment.destinationTabId);
  const [expanded, setExpanded] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);

  const { comments, sending, lastError } = environment;
  if (comments.length === 0) return null;
  const selectedCount = comments.filter((comment) => comment.selected).length;
  const allSelected = selectedCount === comments.length;

  const send = async () => {
    if (!destination) return;
    const result = await sendDiffComments(scope, environmentId, destination);
    switch (result.kind) {
      case "sent": {
        const kept =
          result.kept > 0
            ? ` ${plural(result.kept, "comment")} edited while sending ${result.kept === 1 ? "was" : "were"} kept.`
            : "";
        toast.success(
          `Sent ${plural(result.sent + result.kept, "comment")} to ${destination.label}`,
          {
            description: `It runs when the agent is free.${kept}`,
          },
        );
        return;
      }
      case "too-long":
        toast.error(
          `The request is over ${MAX_DIFF_COMMENT_REQUEST_CHARACTERS.toLocaleString()} characters. Send fewer comments at a time.`,
        );
        return;
      case "failed":
        toast.error("Comments were not sent", { description: result.message });
        return;
      default:
        return;
    }
  };

  const copy = async () => {
    const text = selectedDiffCommentRequest(scope, environmentId);
    if (!text) return;
    try {
      await writeText(text);
      toast.success(`Copied ${plural(selectedCount, "comment")} as one request`);
    } catch (error) {
      toast.error("Could not copy the comments", {
        description: error instanceof Error ? error.message : String(error),
      });
    }
  };

  const noAgent = destinations.length === 0;
  const sendTitle = noAgent
    ? "Open an agent chat in this environment to send comments to it"
    : `Queue one request for ${destination?.label ?? "the agent"}; it runs when the agent is free`;

  return (
    <div
      data-testid="diff-comment-tray"
      className="flex max-h-[45%] shrink-0 flex-col border-t border-border bg-background text-xs"
    >
      {expanded && (
        <div
          data-testid="diff-comment-list"
          className="flex min-h-0 flex-col gap-1.5 overflow-auto border-b border-border/60 px-3 py-2"
        >
          <label className="flex items-center gap-2 text-[11px] text-muted-foreground">
            <Checkbox
              aria-label="Select all comments"
              checked={allSelected ? true : selectedCount === 0 ? false : "indeterminate"}
              onCheckedChange={(checked) => setAllSelected(environmentId, checked === true)}
            />
            Select all
          </label>
          {comments.map((comment) => (
            <DiffCommentCard
              key={comment.id}
              environmentId={environmentId}
              comment={comment}
              environment={environment}
              showLocation
              editing={editingId === comment.id}
              onEdit={() => setEditingId(comment.id)}
              onCancelEdit={() => setEditingId(null)}
              leading={
                <Checkbox
                  className="mt-0.5"
                  aria-label={`Include comment ${comment.anchor.path} in the request`}
                  checked={comment.selected}
                  onCheckedChange={(checked) =>
                    setSelected(environmentId, comment.id, checked === true)
                  }
                />
              }
            />
          ))}
        </div>
      )}
      <div className="flex flex-wrap items-center gap-2 px-3 py-1.5">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-7 gap-1.5 px-2"
          aria-expanded={expanded}
          onClick={() => setExpanded((value) => !value)}
        >
          <MessageSquare className="h-3.5 w-3.5" aria-hidden="true" />
          <span data-testid="diff-comment-count">
            {plural(comments.length, "comment")}
            {selectedCount !== comments.length ? ` · ${selectedCount} selected` : ""}
          </span>
          {expanded ? (
            <ChevronDown className="h-3.5 w-3.5" aria-hidden="true" />
          ) : (
            <ChevronUp className="h-3.5 w-3.5" aria-hidden="true" />
          )}
        </Button>
        {lastError && !sending && (
          <p role="alert" className="min-w-0 truncate text-failure" title={lastError}>
            Not sent: {lastError}
          </p>
        )}
        <div className="ml-auto flex min-w-0 items-center gap-1.5">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-7 px-2"
            disabled={selectedCount === 0}
            onClick={() => void copy()}
            title="Copy the selected comments as one request"
            aria-label="Copy comments as a request"
          >
            <Copy className="h-3.5 w-3.5" />
          </Button>
          {destinations.length > 1 && (
            <NativeSelect
              size="sm"
              aria-label="Agent to send comments to"
              wrapperClassName="max-w-40"
              className="h-7"
              value={destination?.tabId ?? ""}
              onChange={(event) => setDestination(environmentId, event.target.value)}
            >
              {destinations.map((candidate) => (
                <option key={candidate.tabId} value={candidate.tabId}>
                  {candidate.label}
                </option>
              ))}
            </NativeSelect>
          )}
          <Button
            type="button"
            size="sm"
            className="h-7 gap-1.5 px-2.5"
            disabled={noAgent || selectedCount === 0 || sending !== null}
            title={sendTitle}
            onClick={() => void send()}
          >
            {sending ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
            ) : (
              <Send className="h-3.5 w-3.5" aria-hidden="true" />
            )}
            {sending
              ? "Sending…"
              : noAgent
                ? "No agent chat"
                : destinations.length > 1
                  ? `Send ${selectedCount}`
                  : `Send ${selectedCount} to ${destination?.label}`}
          </Button>
        </div>
      </div>
    </div>
  );
}
