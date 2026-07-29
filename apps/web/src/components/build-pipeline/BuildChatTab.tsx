import { useEffect, useMemo, useState } from "react";
import {
  AlertCircle,
  CheckCircle2,
  Circle,
  Loader2,
  Pause,
  Play,
  Square,
} from "lucide-react";
import { toast } from "sonner";
import type { BuildTabData } from "@/types/paneLayout";
import {
  useBuildPipelineStore,
  type PipelineSession,
} from "@/stores/buildPipelineStore";
import * as backend from "@/lib/backend";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";
import { StructuredReviewReportView } from "@/components/review/StructuredReviewReportView";

interface BuildChatTabProps {
  data: BuildTabData;
  isActive?: boolean;
}

const PHASE_LABELS: Record<string, string> = {
  "creating-environment": "Creating environment",
  "starting-environment": "Starting environment",
  "waiting-for-setup": "Running setup",
  building: "Building",
  reviewing: "Reviewing",
  addressing: "Addressing review",
  verifying: "Verifying",
  fixing: "Fixing",
  "creating-pr": "Creating pull request",
  "resolving-conflicts": "Resolving conflicts",
  paused: "Paused",
  complete: "Complete",
  failed: "Failed",
};

type DisplayMessage = {
  key: string;
  role: string;
  text: string;
};

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function partText(value: unknown): string {
  const part = record(value);
  if (!part) return "";
  for (const key of ["text", "content", "message", "output"]) {
    if (typeof part[key] === "string") return part[key] as string;
  }
  return "";
}

function normalizeMessages(messages: unknown[] | undefined): DisplayMessage[] {
  return (messages ?? []).flatMap((value, index) => {
    const item = record(value);
    if (!item) return [];
    const info = record(item.info);
    const role = typeof (info?.role ?? item.role) === "string"
      ? String(info?.role ?? item.role)
      : "assistant";
    const rawParts = Array.isArray(item.parts)
      ? item.parts
      : Array.isArray(item.content)
        ? item.content
        : [];
    const direct = typeof item.content === "string" ? item.content : "";
    const text = rawParts.map(partText).filter(Boolean).join("\n") || direct;
    if (!text.trim()) return [];
    const id = info?.id ?? item.id;
    return [{
      key: typeof id === "string" ? id : `${index}`,
      role,
      text,
    }];
  });
}

function SessionStateIcon({ session }: { session: PipelineSession }) {
  if (session.status === "running") {
    return <Loader2 className="h-3.5 w-3.5 animate-spin text-primary" />;
  }
  if (session.status === "error") {
    return <AlertCircle className="h-3.5 w-3.5 text-destructive" />;
  }
  return <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500" />;
}

export function BuildChatTab({ data }: BuildChatTabProps) {
  const pipeline = useBuildPipelineStore(
    (state) => state.pipelines.get(data.pipelineId),
  );
  const replacePipeline = useBuildPipelineStore(
    (state) => state.replacePipeline,
  );
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);
  const [controlPending, setControlPending] = useState(false);

  useEffect(() => {
    if (!pipeline?.sessions.length) {
      setSelectedSessionId(null);
      return;
    }
    if (
      !selectedSessionId
      || !pipeline.sessions.some(
        (session) => session.sdkSessionId === selectedSessionId,
      )
    ) {
      setSelectedSessionId(
        pipeline.sessions[pipeline.currentSessionIndex]?.sdkSessionId
        ?? pipeline.sessions.at(-1)?.sdkSessionId
        ?? null,
      );
    }
  }, [pipeline?.currentSessionIndex, pipeline?.sessions, selectedSessionId]);

  const selectedSession = pipeline?.sessions.find(
    (session) => session.sdkSessionId === selectedSessionId,
  );
  const messages = useMemo(
    () => normalizeMessages(selectedSession?.messages),
    [selectedSession?.messages],
  );

  const runControl = async (
    action: "pause" | "resume" | "cancel",
  ): Promise<void> => {
    if (!pipeline || controlPending) return;
    setControlPending(true);
    try {
      const next = action === "pause"
        ? await backend.pauseBuildPipeline(pipeline.id)
        : action === "resume"
          ? await backend.resumeBuildPipeline(pipeline.id)
          : await backend.cancelBuildPipeline(pipeline.id);
      replacePipeline(next);
    } catch (error) {
      toast.error(`Failed to ${action} build`, {
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setControlPending(false);
    }
  };

  if (!pipeline) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        Loading build pipeline…
      </div>
    );
  }

  const phaseLabel = PHASE_LABELS[pipeline.phase] ?? pipeline.phase;
  const active = !["paused", "complete", "failed"].includes(pipeline.phase);

  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <div className="flex items-center justify-between gap-3 border-b px-4 py-3">
        <div className="min-w-0">
          <div className="truncate text-sm font-medium">{pipeline.taskTitle}</div>
          <div className="mt-0.5 flex items-center gap-1.5 text-xs text-muted-foreground">
            {active ? (
              <Loader2 className="h-3 w-3 animate-spin" />
            ) : pipeline.phase === "complete" ? (
              <CheckCircle2 className="h-3 w-3 text-emerald-500" />
            ) : pipeline.phase === "failed" ? (
              <AlertCircle className="h-3 w-3 text-destructive" />
            ) : (
              <Circle className="h-3 w-3" />
            )}
            <span>{phaseLabel}</span>
            <span>·</span>
            <span className="capitalize">{pipeline.agentType}</span>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          {active && (
            <Button
              size="sm"
              variant="outline"
              disabled={controlPending}
              onClick={() => void runControl("pause")}
            >
              <Pause className="mr-1.5 h-3.5 w-3.5" />
              Pause
            </Button>
          )}
          {pipeline.phase === "paused" && (
            <Button
              size="sm"
              variant="outline"
              disabled={controlPending}
              onClick={() => void runControl("resume")}
            >
              <Play className="mr-1.5 h-3.5 w-3.5" />
              Resume
            </Button>
          )}
          {(active || pipeline.phase === "paused") && (
            <Button
              size="sm"
              variant="ghost"
              disabled={controlPending}
              onClick={() => void runControl("cancel")}
            >
              <Square className="mr-1.5 h-3.5 w-3.5" />
              Cancel
            </Button>
          )}
        </div>
      </div>

      {pipeline.error && (
        <div className="border-b border-destructive/30 bg-destructive/10 px-4 py-2 text-sm text-destructive">
          {pipeline.error}
        </div>
      )}

      <div className="flex min-h-0 flex-1">
        <ScrollArea className="w-56 shrink-0 border-r">
          <div className="space-y-1 p-2">
            {pipeline.sessions.length === 0 ? (
              <div className="px-2 py-4 text-xs text-muted-foreground">
                The backend is preparing the first stage.
              </div>
            ) : pipeline.sessions.map((session) => (
              <button
                key={session.sessionKey}
                type="button"
                className={cn(
                  "flex w-full items-start gap-2 rounded-md px-2 py-2 text-left hover:bg-muted",
                  selectedSessionId === session.sdkSessionId && "bg-muted",
                )}
                onClick={() => setSelectedSessionId(session.sdkSessionId)}
              >
                <SessionStateIcon session={session} />
                <span className="min-w-0">
                  <span className="block truncate text-xs font-medium">
                    {session.label}
                  </span>
                  <span className="block text-[11px] text-muted-foreground">
                    Iteration {session.iteration + 1}
                  </span>
                </span>
              </button>
            ))}
          </div>
        </ScrollArea>

        <ScrollArea className="min-w-0 flex-1">
          <div className="mx-auto max-w-4xl space-y-4 p-4">
            {!selectedSession ? (
              <div className="py-12 text-center text-sm text-muted-foreground">
                Waiting for the backend to start a build stage.
              </div>
            ) : messages.length === 0 ? (
              <div className="py-12 text-center text-sm text-muted-foreground">
                {selectedSession.status === "running"
                  ? "This stage is running. Its authoritative transcript will appear here as it is synchronized."
                  : "No text transcript was produced for this stage."}
              </div>
            ) : messages.map((message) => (
              <div
                key={message.key}
                className={cn(
                  "rounded-lg border px-4 py-3",
                  message.role === "user" && "ml-8 bg-muted/50",
                )}
              >
                <div className="mb-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                  {message.role}
                </div>
                <div className="whitespace-pre-wrap break-words text-sm">
                  {message.text}
                </div>
              </div>
            ))}
            {pipeline.structuredReview && (
              <StructuredReviewReportView report={pipeline.structuredReview} />
            )}
          </div>
        </ScrollArea>
      </div>
    </div>
  );
}
