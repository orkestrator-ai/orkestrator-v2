import { useEffect, useMemo, useState } from "react";
import { AlertCircle, Loader2 } from "lucide-react";
import { toast } from "sonner";
import {
  diffAgentsMdLines,
  mergeOrkestratorSection,
  parseAgentsMdChanges,
  type AgentsMdChange,
  type AgentsMdChangeOutcome,
  type AgentsMdDiffLine,
  type AgentsMdMergeResult,
} from "@orkestrator/protocol/agents-md-orkestrator";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import {
  previewAgentsMdUpdate,
  resolveNodeActionRequest,
  type AgentsMdPreview,
  type NodeActionRequestView,
} from "@/lib/portal/portal-store";

const ACTION_LABEL: Record<AgentsMdChange["action"], string> = {
  add: "Add",
  replace: "Replace",
  remove: "Remove",
};

const RESULT_NOTE: Partial<Record<AgentsMdChangeOutcome["result"], string>> = {
  already: "no change needed",
  conflict: "conflict",
};

type Merged =
  | { ok: true; result: AgentsMdMergeResult; diff: AgentsMdDiffLine[] }
  | { ok: false; error: string };

// Entries are single lines (the backend refuses line breaks) but wrap on screen.
const LINE_BREAKS = /[\r\n\u000b\u000c\u0085\u2028\u2029]/g;

interface Row {
  change: AgentsMdChange;
  text: string;
  include: boolean;
}

/**
 * A coordinator asked to save decisions to the `## Orkestrator` section of
 * the project's AGENTS.md. The user sees the change as a diff against that
 * section on the latest base branch, may edit or drop entries, and approves
 * or declines. Only an approval opens a pull request; nothing merges.
 *
 * The diff comes from the same merge the backend runs when it opens the pull
 * request, so what is shown is what the pull request changes (unless the base
 * moves meanwhile, when the backend re-applies the entries and reports a
 * conflict instead of guessing).
 */
export function AgentsMdApprovalDialog({
  request,
  onSettled,
}: {
  request: NodeActionRequestView;
  onSettled: () => void;
}) {
  const [preview, setPreview] = useState<AgentsMdPreview | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [rows, setRows] = useState<Row[]>(() =>
    (request.agentsMd?.changes ?? []).map((change) => ({
      change,
      text: change.text,
      include: true,
    })),
  );
  const [previewAttempt, setPreviewAttempt] = useState(0);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let active = true;
    void previewAgentsMdUpdate(request.requestId)
      .then((value) => {
        if (active) setPreview(value);
      })
      .catch((error: unknown) => {
        if (active) setLoadError(error instanceof Error ? error.message : String(error));
      });
    return () => {
      active = false;
    };
  }, [request.requestId, previewAttempt]);

  // The user's final entries, validated by the same rules the backend applies.
  const proposal = useMemo((): { changes: AgentsMdChange[] } | { error: string } => {
    const included = rows.filter((row) => row.include);
    if (included.length === 0) return { error: "Keep at least one entry, or decline." };
    try {
      return {
        changes: parseAgentsMdChanges(included.map((row) => ({ ...row.change, text: row.text }))),
      };
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) };
    }
  }, [rows]);

  const merged = useMemo((): Merged | null => {
    if (!preview || !("changes" in proposal)) return null;
    try {
      const result = mergeOrkestratorSection(
        preview.section.exists ? preview.section.text : null,
        proposal.changes,
      );
      return {
        ok: true,
        result,
        diff: diffAgentsMdLines(result.sectionBefore ?? "", result.sectionAfter ?? ""),
      };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }, [preview, proposal]);

  const outcomes = merged?.ok ? merged.result.outcomes : [];
  const conflicts = merged?.ok ? merged.result.conflicts : [];
  const unchanged = merged?.ok === true && !merged.result.changed && conflicts.length === 0;
  // Outcomes follow the included rows in order.
  const outcomeByRow = new Map<number, AgentsMdChangeOutcome["result"]>();
  let included = 0;
  for (const [index, row] of rows.entries()) {
    if (!row.include) continue;
    const outcome = outcomes[included];
    if (outcome) outcomeByRow.set(index, outcome.result);
    included += 1;
  }

  const canApprove =
    !!preview &&
    !loadError &&
    merged?.ok === true &&
    conflicts.length === 0 &&
    "changes" in proposal;

  const decide = async (decision: "approve" | "reject") => {
    if (busy || (decision === "approve" && !canApprove)) return;
    setBusy(true);
    try {
      const resolved = await resolveNodeActionRequest(
        request.requestId,
        decision,
        decision === "approve" && "changes" in proposal ? { changes: proposal.changes } : undefined,
      );
      if (decision === "approve") {
        if (resolved.state === "executed")
          toast.success(
            resolved.result?.url ? "Pull request opened" : "AGENTS.md already up to date",
            { description: resolved.result?.url ?? resolved.result?.message },
          );
        else
          toast.warning(`AGENTS.md not updated: ${resolved.state}`, {
            description: resolved.result?.message,
          });
      }
    } catch (error) {
      toast.error("Could not resolve the request", {
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setBusy(false);
      onSettled();
    }
  };

  const target = request.targets[0];
  const where = target?.projectName ?? "this project";

  return (
    // Like the other coordinator requests, it stays until approved or declined.
    <Dialog open>
      {/* Long tokens (paths, URLs) in entries and the diff wrap instead of widening the dialog.
          The header and buttons stay put; the entries and diff scroll between them. */}
      <DialogContent
        size="3xl"
        className="flex flex-col wrap-anywhere"
        data-testid="agents-md-request"
        showCloseButton={false}
      >
        <DialogHeader className="shrink-0">
          <DialogTitle>Save decisions to AGENTS.md?</DialogTitle>
          <DialogDescription>
            The project coordinator proposes updating the ## Orkestrator section of AGENTS.md in{" "}
            {where}
            {target?.nodeName ? ` on ${target.nodeName}` : ""}. Edit or drop entries below.
            Approving opens a pull request with only this change; nothing happens unless you
            approve, and nothing is merged.
            {request.reason ? ` Its reason: “${request.reason}”` : ""}
          </DialogDescription>
        </DialogHeader>

        {/* The padding keeps focus rings clear of the scroll area's edges. */}
        <div
          className="-mx-1 min-h-0 flex-1 space-y-4 overflow-y-auto px-1 py-1"
          data-testid="agents-md-body"
        >
          <section className="min-w-0 space-y-2" aria-label="Proposed entries">
            {rows.map((row, index) => {
              const result = outcomeByRow.get(index);
              return (
                <div
                  key={`${row.change.action}:${row.change.replaces ?? ""}:${index}`}
                  className="flex items-start gap-3 rounded-md border border-white/[0.08] p-2"
                  data-testid="agents-md-entry"
                >
                  <Checkbox
                    className="mt-2"
                    checked={row.include}
                    disabled={busy}
                    aria-label={`Include entry ${index + 1}`}
                    onCheckedChange={(value) =>
                      setRows((current) =>
                        current.map((item, at) =>
                          at === index ? { ...item, include: value === true } : item,
                        ),
                      )
                    }
                  />
                  <div className="min-w-0 flex-1 space-y-1">
                    <div className="flex items-center gap-2 text-xs text-muted-foreground">
                      <span className="font-medium text-foreground">
                        {ACTION_LABEL[row.change.action]}
                      </span>
                      {row.change.replaces ? (
                        <span className="truncate">“{row.change.replaces}” with</span>
                      ) : null}
                      {result && RESULT_NOTE[result] ? (
                        <span
                          className={cn(result === "conflict" ? "text-destructive" : "")}
                          data-testid="agents-md-entry-note"
                        >
                          ({RESULT_NOTE[result]})
                        </span>
                      ) : null}
                    </div>
                    {row.change.action === "remove" ? (
                      <p className="font-mono text-xs">{row.text}</p>
                    ) : (
                      <Textarea
                        value={row.text}
                        disabled={busy || !row.include}
                        aria-label={`Entry ${index + 1} text`}
                        maxLength={500}
                        rows={1}
                        className="max-h-[calc(8lh+0.75rem+2px)] min-h-9 resize-none py-1.5"
                        onKeyDown={(event) => {
                          if (event.key === "Enter" && !event.nativeEvent.isComposing)
                            event.preventDefault();
                        }}
                        onChange={(event) => {
                          // Pasted or dropped line breaks become spaces. Same length, so
                          // the caret stays where it was.
                          const field = event.target;
                          const text = field.value.replace(LINE_BREAKS, " ");
                          if (text !== field.value) {
                            const { selectionStart, selectionEnd } = field;
                            field.value = text;
                            field.setSelectionRange(selectionStart, selectionEnd);
                          }
                          setRows((current) =>
                            current.map((item, at) => (at === index ? { ...item, text } : item)),
                          );
                        }}
                      />
                    )}
                  </div>
                </div>
              );
            })}
            {"error" in proposal ? (
              <p className="text-xs text-destructive" role="alert">
                {proposal.error}
              </p>
            ) : null}
          </section>

          <section className="min-w-0 space-y-1" aria-label="Change to the section">
            {loadError ? (
              <div>
                <p className="flex items-center gap-2 text-sm text-destructive">
                  <AlertCircle className="h-4 w-4" /> Could not read the current section:{" "}
                  {loadError}
                </p>
                <Button
                  type="button"
                  variant="outline"
                  disabled={busy}
                  onClick={() => {
                    setLoadError(null);
                    setPreview(null);
                    setPreviewAttempt((attempt) => attempt + 1);
                  }}
                >
                  Retry preview
                </Button>
              </div>
            ) : !preview ? (
              <p className="flex items-center gap-2 py-4 text-sm text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" /> Reading AGENTS.md on the base branch…
              </p>
            ) : (
              <>
                <p className="text-xs text-muted-foreground">
                  Compared with origin/{preview.baseBranch} ({preview.baseCommit.slice(0, 8)})
                  {preview.section.exists
                    ? ""
                    : preview.fileExists
                      ? "; the section will be added at the end of AGENTS.md"
                      : "; AGENTS.md will be created"}
                  .{preview.fetched ? "" : " Could not fetch the latest base; this may be stale."}
                </p>
                {merged?.ok ? (
                  <pre
                    className="max-h-72 overflow-auto rounded-md border border-white/[0.08] p-2 text-xs leading-5"
                    data-testid="agents-md-diff"
                  >
                    {merged.diff.map((line, index) => (
                      <div
                        key={index}
                        data-diff={line.type}
                        className={cn(
                          "whitespace-pre-wrap",
                          line.type === "add" && "bg-emerald-500/10 text-emerald-300",
                          line.type === "remove" && "bg-red-500/10 text-red-300 line-through",
                          line.type === "same" && "text-muted-foreground",
                        )}
                      >
                        {line.type === "add" ? "+ " : line.type === "remove" ? "- " : "  "}
                        {line.text}
                      </div>
                    ))}
                  </pre>
                ) : merged && !merged.ok ? (
                  <p className="text-xs text-destructive">{merged.error}</p>
                ) : null}
                {conflicts.length > 0 ? (
                  <p className="text-xs text-destructive" role="alert">
                    {conflicts.map((outcome) => outcome.detail).join(" ")} Drop that entry or
                    decline and ask the coordinator to propose again.
                  </p>
                ) : unchanged ? (
                  <p className="text-xs text-muted-foreground">
                    The section already says this; approving opens no pull request.
                  </p>
                ) : null}
              </>
            )}
          </section>
        </div>

        <DialogFooter className="shrink-0">
          <Button
            type="button"
            variant="outline"
            disabled={busy}
            onClick={() => void decide("reject")}
          >
            Decline
          </Button>
          <Button
            type="button"
            disabled={busy || !canApprove}
            onClick={() => void decide("approve")}
          >
            {busy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
            Approve and open PR
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
