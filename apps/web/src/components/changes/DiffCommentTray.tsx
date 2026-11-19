import { useEffect, useMemo, useState } from "react";
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
import { liveCommentResource, readLiveCommentContent } from "@/lib/changes/diff-comment-freshness";
import { subscribeChangeResource } from "@/lib/changes/subscriptions";
import { useChangeProjectionStore } from "@/stores/changeProjectionStore";
import {
  environmentDiffComments,
  isDiffCommentSelected,
  useDiffCommentsStore,
} from "@/stores/diffCommentsStore";
import { usePaneLayoutStore } from "@/stores/paneLayoutStore";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { NativeSelect } from "@/components/ui/native-select";
import { DiffCommentCard, NewDiffCommentEditor } from "./DiffComments";

/**
 * The environment's diff comments as one batch: pick which to include, pick
 * the agent chat, and send them as a single correction request. Shown at the
 * foot of every diff tab of the environment while it has comments.
 */

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

export function DiffCommentTray({
  environmentId,
  isActive,
  inlineDraftKeys,
}: {
  environmentId: string;
  isActive: boolean;
  inlineDraftKeys?: ReadonlySet<string>;
}) {
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

  const { comments, sending, lastError } = environment;
  const liveAnchors = useDiffCommentsStore(
    useShallow((state) =>
      environmentDiffComments(state, environmentId)
        .comments.map(({ anchor }) => anchor)
        .filter((anchor) => anchor.source === "live"),
    ),
  );
  const resourceKeys = useMemo(
    () =>
      Array.from(new Set(liveAnchors.map((anchor) => liveCommentResource(environmentId, anchor)))),
    [environmentId, liveAnchors],
  );
  const invalidation = useChangeProjectionStore(
    useShallow((state) => [
      state.transportRevision,
      ...resourceKeys.map((key) => state.contentGenerations.get(key)),
    ]),
  );
  const observeLiveContent = useDiffCommentsStore((state) => state.observeLiveContent);
  useEffect(() => {
    if (!isActive) return;
    const releases = resourceKeys.map((key) => subscribeChangeResource(key, scope));
    return () => releases.forEach((release) => release());
  }, [isActive, resourceKeys, scope]);
  useEffect(() => {
    if (!isActive || !liveAnchors.length) return;
    const controller = new AbortController();
    void readLiveCommentContent(scope, environmentId, liveAnchors, controller.signal).then(
      (content) => {
        if (controller.signal.aborted || scope.disposed) return;
        for (const [pathKey, key] of content) observeLiveContent(environmentId, pathKey, key);
      },
    );
    return () => controller.abort();
  }, [environmentId, invalidation, isActive, liveAnchors, observeLiveContent, scope]);

  const detachedDrafts = Array.from(environment.newDrafts).filter(
    ([key]) => !inlineDraftKeys?.has(key),
  );
  if (comments.length === 0 && detachedDrafts.length === 0) return null;
  const selectedCount = comments.filter(isDiffCommentSelected).length;
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
        toast.success(`Sent ${plural(result.sent, "comment")} to ${destination.label}`, {
          description: `It runs when the agent is free.${kept}`,
        });
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
    try {
      const text = await selectedDiffCommentRequest(scope, environmentId);
      if (!text) return;
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
    ? "Comments go to an agent chat of this environment that has started a conversation. Start one, or copy the request instead."
    : `Queue one request for ${destination?.label ?? "the agent"}; it runs when the agent is free`;

  return (
    <div
      data-testid="diff-comment-tray"
      className="flex max-h-[45%] shrink-0 flex-col border-t border-border bg-background text-xs"
    >
      {detachedDrafts.length > 0 && (
        <div className="flex min-h-0 flex-col gap-2 overflow-auto border-b border-border/60 px-3 py-2">
          {detachedDrafts.map(([key, draft]) => (
            <div key={key} className="flex flex-col gap-1">
              <p className="text-muted-foreground">Draft on {draft.anchor.path}</p>
              <NewDiffCommentEditor environmentId={environmentId} draftKey={key} draft={draft} />
            </div>
          ))}
        </div>
      )}
      {expanded && comments.length > 0 && (
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
              leading={
                <Checkbox
                  className="mt-0.5"
                  aria-label={`Include comment ${comment.anchor.path} in the request`}
                  disabled={comment.sentWhileEditing}
                  checked={isDiffCommentSelected(comment)}
                  onCheckedChange={(checked) =>
                    setSelected(environmentId, comment.id, checked === true)
                  }
                />
              }
            />
          ))}
        </div>
      )}
      {comments.length > 0 && (
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
      )}
    </div>
  );
}
