import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertCircle,
  ArrowLeft,
  CalendarClock,
  Check,
  Container,
  ExternalLink,
  FolderGit2,
  Loader2,
  RefreshCw,
  Search,
  Unplug,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { MessageMarkdown } from "@/components/chat/MessageMarkdown";
import { useBuildPipeline } from "@/hooks/useBuildPipeline";
import { useBuildPipelineStore, type BuildPipeline } from "@/stores/buildPipelineStore";
import {
  connectLinear,
  getLinearConnection,
  getLinearIssue,
  getLinearIssues,
  openInBrowser,
} from "@/lib/backend";
import { cn } from "@/lib/utils";
import type { EnvironmentType } from "@/types";
import type { LinearConnectionStatus, LinearIssueDetail, LinearIssueListItem } from "@/types/linear";

interface LinearTicketsViewProps {
  projectId: string;
}

type LinearBuildPipelineActions = Pick<
  ReturnType<typeof useBuildPipeline>,
  "startBuildFromLinearIssue" | "navigateToPipeline"
>;

interface LinearTicketsViewContentProps extends LinearTicketsViewProps {
  buildPipeline: LinearBuildPipelineActions;
}

type LoadState = "idle" | "loading" | "loaded" | "error";

function formatUpdatedDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}

function getIssuePipeline(pipelines: Map<string, BuildPipeline>, issueId: string): BuildPipeline | undefined {
  const matches = Array.from(pipelines.values()).filter(
    (pipeline) => pipeline.source?.type === "linear" && pipeline.source.issueId === issueId,
  );
  matches.sort((a, b) => {
    const activeDelta = Number(isActivePipeline(b)) - Number(isActivePipeline(a));
    if (activeDelta !== 0) return activeDelta;
    return b.createdAt.localeCompare(a.createdAt);
  });
  return matches[0];
}

function isActivePipeline(pipeline: BuildPipeline | undefined): boolean {
  return !!pipeline && !["complete", "failed"].includes(pipeline.phase);
}

function IssueMetadata({ issue }: { issue: LinearIssueListItem | LinearIssueDetail }) {
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
      <span className="font-medium text-foreground">{issue.identifier}</span>
      <span>{issue.status}</span>
      {issue.teamKey && <span>{issue.teamKey}</span>}
      {issue.assigneeName && <span>{issue.assigneeName}</span>}
      {issue.priorityLabel && <span>{issue.priorityLabel}</span>}
      <span className="inline-flex items-center gap-1">
        <CalendarClock className="h-3 w-3" />
        {formatUpdatedDate(issue.updatedAt)}
      </span>
    </div>
  );
}

function LinearConnectDialog({
  open,
  onOpenChange,
  onConnected,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConnected: (status: LinearConnectionStatus) => void;
}) {
  const [apiKey, setApiKey] = useState("");
  const [isConnecting, setIsConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleConnect = async () => {
    if (!apiKey.trim()) return;
    setIsConnecting(true);
    setError(null);
    try {
      const status = await connectLinear(apiKey.trim());
      onConnected(status);
      setApiKey("");
      onOpenChange(false);
      toast.success("Linear connected");
    } catch (connectError) {
      setError(connectError instanceof Error ? connectError.message : "Failed to connect Linear");
    } finally {
      setIsConnecting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Connect Linear</DialogTitle>
          <DialogDescription>
            Paste a Linear personal API key. Orkestrator verifies it before loading tickets.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <Input
            type="password"
            value={apiKey}
            onChange={(event) => setApiKey(event.target.value)}
            placeholder="lin_api_..."
            autoComplete="off"
          />
          {error && (
            <div className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">
              <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
              <span className="break-words">{error}</span>
            </div>
          )}
        </div>
        <DialogFooter className="gap-2 sm:gap-0">
          <Button
            type="button"
            variant="outline"
            onClick={() => void openInBrowser("https://linear.app/settings/api")}
          >
            <ExternalLink className="h-4 w-4" />
            API settings
          </Button>
          <Button type="button" onClick={() => void handleConnect()} disabled={isConnecting || !apiKey.trim()}>
            {isConnecting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
            Connect
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function LinearTicketsView({ projectId }: LinearTicketsViewProps) {
  const buildPipeline = useBuildPipeline();
  return <LinearTicketsViewContent projectId={projectId} buildPipeline={buildPipeline} />;
}

export function LinearTicketsViewContent({ projectId, buildPipeline }: LinearTicketsViewContentProps) {
  const [connection, setConnection] = useState<LinearConnectionStatus | null>(null);
  const [connectionState, setConnectionState] = useState<LoadState>("idle");
  const [issues, setIssues] = useState<LinearIssueListItem[]>([]);
  const [issuesState, setIssuesState] = useState<LoadState>("idle");
  const [issuesError, setIssuesError] = useState<string | null>(null);
  const [selectedStatuses, setSelectedStatuses] = useState<Set<string>>(new Set());
  const [selectedIssueId, setSelectedIssueId] = useState<string | null>(null);
  const [detail, setDetail] = useState<LinearIssueDetail | null>(null);
  const [detailState, setDetailState] = useState<LoadState>("idle");
  const [detailError, setDetailError] = useState<string | null>(null);
  const [connectOpen, setConnectOpen] = useState(false);
  const [startingType, setStartingType] = useState<EnvironmentType | null>(null);
  const connectionRequestRef = useRef(0);
  const issuesRequestRef = useRef(0);
  const detailRequestRef = useRef(0);

  const pipelines = useBuildPipelineStore((state) => state.pipelines);
  const clearCompletionCommentStatus = useBuildPipelineStore((state) => state.clearCompletionCommentStatus);
  const { startBuildFromLinearIssue, navigateToPipeline } = buildPipeline;

  const loadConnection = useCallback(async () => {
    const requestId = connectionRequestRef.current + 1;
    connectionRequestRef.current = requestId;
    setConnectionState("loading");
    try {
      const status = await getLinearConnection();
      if (connectionRequestRef.current !== requestId) return null;
      setConnection(status);
      setConnectionState("loaded");
      return status;
    } catch (error) {
      if (connectionRequestRef.current !== requestId) return null;
      setConnection({
        connected: false,
        hasToken: false,
        error: error instanceof Error ? error.message : "Failed to verify Linear connection",
      });
      setConnectionState("error");
      return null;
    }
  }, []);

  const loadIssues = useCallback(async () => {
    const requestId = issuesRequestRef.current + 1;
    issuesRequestRef.current = requestId;
    setIssuesState("loading");
    setIssuesError(null);
    try {
      const status = await loadConnection();
      if (issuesRequestRef.current !== requestId) return;
      if (!status?.connected) {
        setIssues([]);
        setIssuesState("loaded");
        return;
      }
      const nextIssues = await getLinearIssues();
      if (issuesRequestRef.current !== requestId) return;
      setIssues(nextIssues);
      setIssuesState("loaded");
    } catch (error) {
      if (issuesRequestRef.current !== requestId) return;
      setIssuesError(error instanceof Error ? error.message : "Failed to load Linear tickets");
      setIssuesState("error");
    }
  }, [loadConnection]);

  useEffect(() => {
    void loadIssues();
  }, [loadIssues]);

  const statusCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const issue of issues) {
      counts.set(issue.status, (counts.get(issue.status) ?? 0) + 1);
    }
    return Array.from(counts.entries()).sort(([a], [b]) => a.localeCompare(b));
  }, [issues]);

  const filteredIssues = useMemo(() => {
    if (selectedStatuses.size === 0) return issues;
    return issues.filter((issue) => selectedStatuses.has(issue.status));
  }, [issues, selectedStatuses]);

  const groupedIssues = useMemo(() => {
    const groups = new Map<string, LinearIssueListItem[]>();
    for (const issue of filteredIssues) {
      const group = groups.get(issue.status) ?? [];
      group.push(issue);
      groups.set(issue.status, group);
    }
    return Array.from(groups.entries()).sort(([a], [b]) => a.localeCompare(b));
  }, [filteredIssues]);

  const selectedPipeline = selectedIssueId ? getIssuePipeline(pipelines, selectedIssueId) : undefined;
  const selectedIssueSummary = selectedIssueId ? issues.find((issue) => issue.id === selectedIssueId) : undefined;

  const loadDetail = useCallback(async (issueId: string) => {
    const requestId = detailRequestRef.current + 1;
    detailRequestRef.current = requestId;
    setDetailState("loading");
    setDetailError(null);
    try {
      const nextDetail = await getLinearIssue(issueId);
      if (detailRequestRef.current !== requestId) return;
      setDetail(nextDetail);
      setDetailState("loaded");
    } catch (error) {
      if (detailRequestRef.current !== requestId) return;
      setDetail(null);
      setDetailError(error instanceof Error ? error.message : "Failed to load Linear ticket");
      setDetailState("error");
    }
  }, []);

  const handleSelectIssue = (issueId: string) => {
    setSelectedIssueId(issueId);
    setDetail(null);
    setDetailError(null);
    void loadDetail(issueId);
  };

  const handleBackToList = () => {
    detailRequestRef.current += 1;
    setSelectedIssueId(null);
    setDetail(null);
    setDetailError(null);
    setDetailState("idle");
    setStartingType(null);
  };

  const handleToggleStatus = (status: string) => {
    setSelectedStatuses((current) => {
      const next = new Set(current);
      if (next.has(status)) next.delete(status);
      else next.add(status);
      return next;
    });
  };

  const handleStartBuild = async (type: EnvironmentType) => {
    if (!detail) return;
    setStartingType(type);
    try {
      await startBuildFromLinearIssue(detail, projectId, type);
    } finally {
      setStartingType(null);
    }
  };

  if (selectedIssueId) {
    const issueForHeader = detail ?? selectedIssueSummary;
    return (
      <div className="flex h-full flex-col bg-background">
        <div className="flex items-center gap-3 border-b border-border px-6 py-4">
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8"
            aria-label="Back to Linear tickets"
            onClick={handleBackToList}
          >
            <ArrowLeft className="h-4 w-4" />
          </Button>
          <div className="min-w-0">
            <h2 className="truncate text-lg font-semibold text-foreground">
              {issueForHeader?.title ?? "Linear Ticket"}
            </h2>
            {issueForHeader && <IssueMetadata issue={issueForHeader} />}
          </div>
          {issueForHeader?.url && (
            <Button
              variant="outline"
              size="sm"
              className="ml-auto"
              onClick={() => void openInBrowser(issueForHeader.url!)}
            >
              <ExternalLink className="h-3.5 w-3.5" />
              Open
            </Button>
          )}
        </div>

        <ScrollArea className="min-h-0 flex-1">
          <div className="mx-auto max-w-4xl space-y-5 p-6">
            {detailState === "loading" && (
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" />
                Loading ticket
              </div>
            )}

            {detailState === "error" && (
              <div className="rounded-md border border-destructive/30 bg-destructive/10 p-4">
                <div className="flex items-start gap-2 text-sm text-destructive">
                  <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
                  <span>{detailError}</span>
                </div>
                <div className="mt-3 flex gap-2">
                  <Button size="sm" variant="outline" onClick={() => void loadDetail(selectedIssueId)}>
                    <RefreshCw className="h-3.5 w-3.5" />
                    Retry
                  </Button>
                  <Button size="sm" variant="ghost" onClick={handleBackToList}>
                    Back
                  </Button>
                </div>
              </div>
            )}

            {detail && (
              <>
                <div className="space-y-2">
                  <h3 className="text-sm font-medium text-foreground">Description</h3>
                  {detail.description ? (
                    <div className="rounded-md border border-border/60 bg-muted/20 p-4">
                      <MessageMarkdown content={detail.description} />
                    </div>
                  ) : (
                    <div className="rounded-md border border-border/60 bg-muted/20 p-4 text-sm text-muted-foreground">
                      No description
                    </div>
                  )}
                </div>

                <div className="grid gap-3 text-sm sm:grid-cols-2">
                  <div className="rounded-md border border-border/60 p-3">
                    <div className="text-xs text-muted-foreground">Created</div>
                    <div>{detail.createdAt ? formatUpdatedDate(detail.createdAt) : "Unknown"}</div>
                  </div>
                  <div className="rounded-md border border-border/60 p-3">
                    <div className="text-xs text-muted-foreground">Updated</div>
                    <div>{formatUpdatedDate(detail.updatedAt)}</div>
                  </div>
                  {detail.creatorName && (
                    <div className="rounded-md border border-border/60 p-3">
                      <div className="text-xs text-muted-foreground">Creator</div>
                      <div>{detail.creatorName}</div>
                    </div>
                  )}
                  {detail.projectName && (
                    <div className="rounded-md border border-border/60 p-3">
                      <div className="text-xs text-muted-foreground">Linear Project</div>
                      <div>{detail.projectName}</div>
                    </div>
                  )}
                  {detail.cycleName && (
                    <div className="rounded-md border border-border/60 p-3">
                      <div className="text-xs text-muted-foreground">Cycle</div>
                      <div>{detail.cycleName}</div>
                    </div>
                  )}
                  {detail.labels.length > 0 && (
                    <div className="rounded-md border border-border/60 p-3 sm:col-span-2">
                      <div className="text-xs text-muted-foreground">Labels</div>
                      <div className="mt-1 flex flex-wrap gap-1.5">
                        {detail.labels.map((label) => (
                          <span key={label} className="rounded bg-muted px-2 py-0.5 text-xs">{label}</span>
                        ))}
                      </div>
                    </div>
                  )}
                </div>

                <Separator />

                <div className="flex flex-wrap items-center gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={!!startingType || isActivePipeline(selectedPipeline)}
                    onClick={() => void handleStartBuild("containerized")}
                  >
                    {startingType === "containerized" ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <Container className="h-3.5 w-3.5" />
                    )}
                    Build Container
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={!!startingType || isActivePipeline(selectedPipeline)}
                    onClick={() => void handleStartBuild("local")}
                  >
                    {startingType === "local" ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <FolderGit2 className="h-3.5 w-3.5" />
                    )}
                    Build Local
                  </Button>
                  {selectedPipeline?.environmentId && (
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => void navigateToPipeline(selectedPipeline)}
                    >
                      <ExternalLink className="h-3.5 w-3.5" />
                      View Build
                      <span className="text-xs text-muted-foreground">({selectedPipeline.phase})</span>
                    </Button>
                  )}
                  {selectedPipeline?.completionCommentStatus === "failed" && (
                    <>
                      <span className="text-xs text-destructive">
                        Linear comment failed: {selectedPipeline.completionCommentError}
                      </span>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => clearCompletionCommentStatus(selectedPipeline.id)}
                      >
                        <RefreshCw className="h-3.5 w-3.5" />
                        Retry comment
                      </Button>
                    </>
                  )}
                  {selectedPipeline?.completionCommentStatus === "posting" && (
                    <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
                      <Loader2 className="h-3 w-3 animate-spin" />
                      Posting Linear comment
                    </span>
                  )}
                  {selectedPipeline?.completionCommentStatus === "posted" && (
                    <span className="inline-flex items-center gap-1 text-xs text-green-500">
                      <Check className="h-3 w-3" />
                      Linear comment posted
                    </span>
                  )}
                </div>
              </>
            )}
          </div>
        </ScrollArea>
      </div>
    );
  }

  const connected = connection?.connected;

  return (
    <div className="flex h-full flex-col bg-background">
      <div className="flex items-center gap-3 border-b border-border px-6 py-4">
        <div>
          <h2 className="text-lg font-semibold text-foreground">Linear Tickets</h2>
          <p className="text-sm text-muted-foreground">
            {connected
              ? `${issues.length} ticket${issues.length === 1 ? "" : "s"} available`
              : "Linear is not connected"}
          </p>
        </div>
        <div className="ml-auto flex items-center gap-2">
          {connection?.viewer && (
            <span className="hidden text-xs text-muted-foreground sm:inline">
              {connection.viewer.name}
            </span>
          )}
          <Button variant="outline" size="sm" onClick={() => void loadIssues()} disabled={issuesState === "loading"}>
            {issuesState === "loading" || connectionState === "loading" ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <RefreshCw className="h-3.5 w-3.5" />
            )}
            Refresh
          </Button>
          <Button variant={connected ? "outline" : "default"} size="sm" onClick={() => setConnectOpen(true)}>
            <Unplug className="h-3.5 w-3.5" />
            {connected ? "Reconnect" : "Connect"}
          </Button>
        </div>
      </div>

      {!connected ? (
        <div className="flex flex-1 items-center justify-center p-6">
          <div className="w-full max-w-md rounded-md border border-border bg-muted/20 p-6 text-center">
            <Unplug className="mx-auto mb-3 h-8 w-8 text-muted-foreground" />
            <h3 className="text-base font-medium text-foreground">Connect Linear</h3>
            <p className="mt-2 text-sm text-muted-foreground">
              {connection?.error ?? "Connect a Linear workspace before loading tickets."}
            </p>
            <Button className="mt-4" onClick={() => setConnectOpen(true)}>
              Connect Linear
            </Button>
          </div>
        </div>
      ) : (
        <>
          <div className="border-b border-border px-6 py-3">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-xs font-medium text-muted-foreground">Status</span>
              {statusCounts.map(([status, count]) => {
                const checked = selectedStatuses.has(status);
                return (
                  <label
                    key={status}
                    className={cn(
                      "inline-flex cursor-pointer items-center gap-2 rounded-md border px-2.5 py-1.5 text-xs transition-colors",
                      checked ? "border-primary bg-primary/10 text-foreground" : "border-border bg-background text-muted-foreground hover:text-foreground",
                    )}
                  >
                    <Checkbox
                      checked={checked}
                      onCheckedChange={() => handleToggleStatus(status)}
                      className="h-3.5 w-3.5"
                    />
                    <span>{status}</span>
                    <span className="text-muted-foreground">{count}</span>
                  </label>
                );
              })}
              {selectedStatuses.size > 0 && (
                <Button size="sm" variant="ghost" onClick={() => setSelectedStatuses(new Set())}>
                  Clear
                </Button>
              )}
            </div>
          </div>

          <ScrollArea className="min-h-0 flex-1">
            <div className="space-y-5 p-6">
              {issuesState === "loading" && (
                <div className="flex items-center gap-2 text-sm text-muted-foreground">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Loading Linear tickets
                </div>
              )}

              {issuesState === "error" && (
                <div className="rounded-md border border-destructive/30 bg-destructive/10 p-4">
                  <div className="flex items-start gap-2 text-sm text-destructive">
                    <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
                    <span>{issuesError}</span>
                  </div>
                  <Button className="mt-3" size="sm" variant="outline" onClick={() => void loadIssues()}>
                    <RefreshCw className="h-3.5 w-3.5" />
                    Retry
                  </Button>
                </div>
              )}

              {issuesState === "loaded" && issues.length === 0 && (
                <div className="flex flex-col items-center justify-center rounded-md border border-dashed border-border p-8 text-center text-muted-foreground">
                  <Search className="mb-2 h-6 w-6" />
                  <p className="text-sm">No Linear tickets found</p>
                </div>
              )}

              {issuesState === "loaded" && issues.length > 0 && filteredIssues.length === 0 && (
                <div className="flex flex-col items-center justify-center rounded-md border border-dashed border-border p-8 text-center text-muted-foreground">
                  <Search className="mb-2 h-6 w-6" />
                  <p className="text-sm">No tickets match the selected statuses</p>
                </div>
              )}

              {groupedIssues.map(([status, group]) => (
                <section key={status} className="space-y-2">
                  <div className="flex items-center gap-2">
                    <h3 className="text-sm font-semibold text-foreground">{status}</h3>
                    <span className="text-xs text-muted-foreground">{group.length}</span>
                  </div>
                  <div className="overflow-hidden rounded-md border border-border">
                    {group.map((issue, index) => {
                      const pipeline = getIssuePipeline(pipelines, issue.id);
                      return (
                        <button
                          key={issue.id}
                          type="button"
                          className={cn(
                            "block w-full p-3 text-left transition-colors hover:bg-muted/50",
                            index > 0 && "border-t border-border",
                          )}
                          onClick={() => handleSelectIssue(issue.id)}
                        >
                          <div className="flex items-start justify-between gap-4">
                            <div className="min-w-0 space-y-1">
                              <div className="truncate text-sm font-medium text-foreground">{issue.title}</div>
                              <IssueMetadata issue={issue} />
                            </div>
                            {pipeline && (
                              <span className="shrink-0 rounded bg-muted px-2 py-0.5 text-xs text-muted-foreground">
                                {pipeline.phase}
                              </span>
                            )}
                          </div>
                        </button>
                      );
                    })}
                  </div>
                </section>
              ))}
            </div>
          </ScrollArea>
        </>
      )}

      <LinearConnectDialog
        open={connectOpen}
        onOpenChange={setConnectOpen}
        onConnected={(status) => {
          connectionRequestRef.current += 1;
          setConnection(status);
          setConnectionState("loaded");
          if (status.connected) {
            void loadIssues();
          } else {
            setIssues([]);
            setIssuesState("loaded");
          }
        }}
      />
    </div>
  );
}
