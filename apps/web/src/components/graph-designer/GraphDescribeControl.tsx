import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { AlertTriangle, FileCheck2, Loader2, Sparkles, X } from "lucide-react";
import type { AgentPlatform } from "@orkestrator/protocol/agent-platforms";
import type { GraphDescribeJobView } from "@orkestrator/protocol/graphs/describe";
import type { GraphTemplateV1 } from "@orkestrator/protocol/graphs/template";
import { Button } from "@/components/ui/button";
import { useProjectModelCatalog } from "@/hooks/useBuildLaunchOptions";
import { onResourceChanged, onViewSafetyCheck } from "@/lib/resource-sync";
import { EMPTY_GRAPH_DESCRIBE_ENTRY, useGraphDescribeStore } from "@/stores/graphDescribeStore";
import {
  GRAPH_DESCRIBE_PROGRESS_LABELS,
  GraphDescribeDialog,
  type GraphDescribeSubmission,
} from "./GraphDescribeDialog";

/**
 * The designer's "Describe a graph" button, the job's status beside it, and
 * the dialog (item 215). The job is the backend's: it is read when the tab
 * mounts, on `graph-describe` hints for this environment and on view safety
 * checks, so a tab that was switched away (or a reload) shows it where it is.
 * A completed job's draft is handed to `onOpenDraft` (once per job, while the
 * tab is active); the job is dismissed once the draft is open.
 */
export function GraphDescribeControl({
  environmentId,
  projectId,
  isActive,
  providers,
  currentTemplate,
  onOpenDraft,
}: {
  environmentId: string;
  projectId: string | null;
  isActive: boolean;
  providers: readonly AgentPlatform[];
  /** The draft or template shown: what "Modify the current draft" sends. */
  currentTemplate: GraphTemplateV1 | null;
  /**
   * Opens the draft unsaved. Calls `opened` once it is open (after the user
   * agreed to drop unsaved edits, when there were any); not calling it keeps
   * the job so the draft can be opened later.
   */
  onOpenDraft: (template: GraphTemplateV1, opened: () => void) => void;
}) {
  const entry =
    useGraphDescribeStore((state) => state.entries.get(environmentId)) ??
    EMPTY_GRAPH_DESCRIBE_ENTRY;
  const refresh = useGraphDescribeStore((state) => state.refresh);
  const start = useGraphDescribeStore((state) => state.start);
  const cancel = useGraphDescribeStore((state) => state.cancel);
  const dismiss = useGraphDescribeStore((state) => state.dismiss);
  const clearError = useGraphDescribeStore((state) => state.clearError);
  const [open, setOpen] = useState(false);
  const catalog = useProjectModelCatalog(projectId ?? "", open);
  const job = entry.job;

  useEffect(() => {
    void refresh(environmentId);
    const offChange = onResourceChanged("graph-describe", (change) => {
      if (change.id === environmentId) void refresh(environmentId);
    });
    const offSafety = onViewSafetyCheck(() => void refresh(environmentId));
    return () => {
      offChange();
      offSafety();
    };
  }, [environmentId, refresh]);

  const openDraft = (finished: GraphDescribeJobView) => {
    if (!finished.template) return;
    onOpenDraft(finished.template, () => {
      setOpen(false);
      void dismiss(environmentId, finished.id);
      toast.success(`Opened "${finished.template!.name}" as an unsaved draft`, {
        description: "Review it, then save it before it can run.",
      });
    });
  };

  // A finished draft opens by itself the first time an active tab sees it.
  const offeredRef = useRef<string | null>(null);
  useEffect(() => {
    if (!isActive || job?.status !== "completed" || !job.template) return;
    if (offeredRef.current === job.id) return;
    offeredRef.current = job.id;
    openDraft(job);
    // openDraft closes over props that change every render; the job id gates it.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [isActive, job?.id, job?.status]);

  const submit = async (submission: GraphDescribeSubmission) => {
    const { selection } = submission;
    try {
      await start({
        environmentId,
        description: submission.description,
        agent: selection.agent,
        ...(selection.model && selection.model !== "default" ? { model: selection.model } : {}),
        ...(selection.reasoningEffort ? { reasoningEffort: selection.reasoningEffort } : {}),
        ...(typeof selection.fastMode === "boolean" ? { fastMode: selection.fastMode } : {}),
        ...(submission.modify && currentTemplate ? { baseDraft: currentTemplate } : {}),
      });
    } catch {
      // The store keeps the backend's reason; the dialog shows it.
    }
  };

  return (
    <>
      {job?.status === "running" ? (
        <Button
          variant="ghost"
          size="sm"
          data-graph-describe-status="running"
          title="The designer agent is working; open to see its progress"
          onClick={() => setOpen(true)}
        >
          <Loader2 className="size-3.5 animate-spin text-indigo-400" />
          {GRAPH_DESCRIBE_PROGRESS_LABELS[job.progress ?? "drafting"]}
        </Button>
      ) : job?.status === "completed" && job.template ? (
        <Button
          variant="outline"
          size="sm"
          data-graph-describe-status="completed"
          onClick={() => openDraft(job)}
        >
          <FileCheck2 className="size-3.5 text-success" />
          Open described draft
        </Button>
      ) : job?.status === "failed" ? (
        <span className="flex items-center gap-1" data-graph-describe-status="failed">
          <Button
            variant="ghost"
            size="sm"
            className="text-failure"
            title={job.error}
            onClick={() => setOpen(true)}
          >
            <AlertTriangle className="size-3.5" />
            Describe failed
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="size-7"
            aria-label="Dismiss the failed request"
            onClick={() => void dismiss(environmentId, job.id)}
          >
            <X className="size-3.5" />
          </Button>
        </span>
      ) : null}
      <Button
        variant="ghost"
        size="sm"
        onClick={() => {
          clearError(environmentId);
          setOpen(true);
        }}
      >
        <Sparkles className="size-3.5" />
        Describe a graph
      </Button>
      <GraphDescribeDialog
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
          if (!next) clearError(environmentId);
        }}
        catalog={catalog}
        providers={providers}
        currentName={currentTemplate?.name ?? null}
        job={job}
        busy={entry.busy !== null}
        error={entry.error}
        onSubmit={submit}
        onCancelJob={() => void cancel(environmentId)}
      />
    </>
  );
}
