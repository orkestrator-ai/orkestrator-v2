import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Bug,
  Camera,
  ChevronDown,
  ExternalLink,
  FolderOpen,
  Loader2,
  LockKeyhole,
  Send,
  Trash2,
} from "lucide-react";
import { toast } from "sonner";
import type { AgentPlatform } from "@orkestrator/protocol/agent-platforms";
import {
  BUG_REPORT_AGENTS,
  isBugReportAgent,
  type BugReportSnapshot,
} from "@orkestrator/protocol/bug-report";
import { AgentNativeTab } from "@/components/native-agent";
import { useMachineViews } from "@/components/federation/useMachineViews";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Sheet, SheetContent, SheetDescription, SheetTitle } from "@/components/ui/sheet";
import {
  assignBugReportAgent,
  createBugReport,
  discardBugReport,
  fileBugReport,
  getBugReport,
  markBugReportFiled,
  openInBrowser,
  revealBugReportPath,
  saveBugReportScreenshot,
} from "@/lib/backend";
import { collectBugReportClientContext } from "@/lib/bug-report/client-context";
import { openBugReport, ownBugReportMachineId } from "@/lib/bug-report/open-bug-report";
import { createSessionKey } from "@/lib/utils";
import { useBugReportStore } from "@/stores/bugReportStore";
import { useNativeComposeStore } from "@/stores/nativeComposeStore";

const DRAFT_POLL_MS = 3_000;

type LaunchOptions = {
  modelId?: string;
  reasoningId?: string;
  fastMode: boolean;
  mode?: "build" | "plan";
  executionProfileId?: string;
};

type BrowserHandoff = { reason: string; bodyCopied: boolean };

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function nextFrame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

/**
 * The Report a bug sheet.
 *
 * Hosted once per renderer (the window, and each machine's realm), so the
 * report's agent session always talks to this renderer's own backend; another
 * machine's report is shown by that machine's realm (`openBugReport`). The
 * report itself lives in the backend: closing the sheet only hides it.
 */
export function BugReportSheet() {
  const open = useBugReportStore((state) => state.sheetOpen);
  const closeSheet = useBugReportStore((state) => state.closeSheet);
  const setDraftInProgress = useBugReportStore((state) => state.setDraftInProgress);
  const [snapshot, setSnapshot] = useState<BugReportSnapshot | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [pendingLaunch, setPendingLaunch] = useState<
    (LaunchOptions & { reportId: string; prompt: string }) | null
  >(null);
  const [filing, setFiling] = useState(false);
  const [capturing, setCapturing] = useState(false);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const [draftExpanded, setDraftExpanded] = useState(false);
  const [browserHandoff, setBrowserHandoff] = useState<BrowserHandoff | null>(null);
  const [issueUrl, setIssueUrl] = useState("");
  const report = snapshot?.report ?? null;
  const draft = snapshot?.draft ?? null;

  const apply = useCallback(
    (next: BugReportSnapshot) => {
      setSnapshot(next);
      setDraftInProgress(Boolean(next.report && !next.report.filed));
    },
    [setDraftInProgress],
  );

  // Whether a report is open, for the bottom bar's dot, before anyone opens the sheet.
  useEffect(() => {
    let current = true;
    void (async () => {
      const next = await getBugReport().catch(() => null);
      if (current && next) apply(next);
    })();
    return () => {
      current = false;
    };
  }, [apply]);

  // Opening the sheet resumes the open report, or starts one.
  const machineLabel = useMachineLabel();
  useEffect(() => {
    if (!open) return;
    let current = true;
    void (async () => {
      try {
        let next = await getBugReport();
        if (current) setLoadError(null);
        if (!next.report) {
          next = await createBugReport(
            collectBugReportClientContext({ id: ownBugReportMachineId(), label: machineLabel }),
          );
        }
        if (current) apply(next);
      } catch (error) {
        if (current) setLoadError(errorText(error));
      }
    })();
    return () => {
      current = false;
    };
  }, [apply, machineLabel, open]);

  // The agent rewrites its draft as the conversation goes; follow it while shown.
  useEffect(() => {
    if (!open || !report) return;
    const timer = setInterval(() => {
      getBugReport()
        .then(apply)
        .catch(() => undefined);
    }, DRAFT_POLL_MS);
    return () => clearInterval(timer);
  }, [apply, open, report]);

  const assign = useCallback(
    async (platform: AgentPlatform, prompt: string, options: LaunchOptions) => {
      if (!report) throw new Error("The bug report is still starting");
      if (!isBugReportAgent(platform)) throw new Error("This agent cannot be used for bug reports");
      const next = await assignBugReportAgent(report.id, platform);
      setPendingLaunch({ reportId: report.id, prompt, ...options });
      apply(next);
    },
    [apply, report],
  );

  const capture = useCallback(async () => {
    const api = window.orkestrator?.bugReport;
    if (!api || !report) return;
    setCapturing(true);
    // Step the sheet aside so the capture shows what the user was looking at.
    closeSheet();
    try {
      await nextFrame();
      await nextFrame();
      await new Promise((resolve) => setTimeout(resolve, 250));
      const base64 = await api.captureWindow();
      const saved = await saveBugReportScreenshot(report.id, base64);
      apply(saved.snapshot);
      const sessionKey = createSessionKey(report.runtimeId, report.tabId);
      const compose = useNativeComposeStore.getState();
      const current = compose.drafts.get(sessionKey);
      compose.updateDraft(sessionKey, {
        attachments: [
          ...(current?.attachments ?? []),
          {
            id: Math.random().toString(36).slice(2, 9),
            type: "image",
            path: saved.path,
            previewUrl: `data:image/png;base64,${base64}`,
            name: saved.path.split("/").pop() ?? "window.png",
          },
        ],
      });
      toast.success("Window captured", {
        description: "It is attached to your next message.",
      });
    } catch (error) {
      toast.error("Could not capture the window", { description: errorText(error) });
    } finally {
      useBugReportStore.getState().openSheet();
      setCapturing(false);
    }
  }, [apply, closeSheet, report]);

  const file = useCallback(
    async (via?: "browser") => {
      if (!report || !draft) return;
      setFiling(true);
      try {
        const result = await fileBugReport(report.id, {
          title: draft.title,
          body: draft.body,
          ...(via ? { via } : {}),
        });
        if (result.kind === "filed") {
          toast.success("Issue filed", { description: result.url });
          apply(await getBugReport());
          return;
        }
        let bodyCopied = false;
        if (!result.bodyInUrl) {
          bodyCopied = await navigator.clipboard
            .writeText(draft.body)
            .then(() => true)
            .catch(() => false);
        }
        await openInBrowser(result.url);
        setBrowserHandoff({ reason: result.reason, bodyCopied });
      } catch (error) {
        toast.error("Could not file the issue", { description: errorText(error) });
      } finally {
        setFiling(false);
      }
    },
    [apply, draft, report],
  );

  const discard = useCallback(async () => {
    if (!report) return;
    try {
      apply(await discardBugReport(report.id));
      setBrowserHandoff(null);
      setIssueUrl("");
      setDraftExpanded(false);
      closeSheet();
    } catch (error) {
      toast.error("Could not discard the report", { description: errorText(error) });
    }
  }, [apply, closeSheet, report]);

  const markFiled = useCallback(async () => {
    if (!report) return;
    try {
      apply(await markBugReportFiled(report.id, issueUrl.trim()));
      setBrowserHandoff(null);
    } catch (error) {
      toast.error("Could not record the issue", { description: errorText(error) });
    }
  }, [apply, issueUrl, report]);

  /*
   * The opening prompt is held until the session is observed, as the
   * coordinator holds its own: the tab sends it after its first authoritative
   * read, and the submit carries a deterministic idempotency key, so a remount
   * in the meantime (the sheet closed and reopened) cannot send it twice.
   */
  if (pendingLaunch && report?.providerSessionId) setPendingLaunch(null);
  const launch = pendingLaunch && pendingLaunch.reportId === report?.id ? pendingLaunch : null;
  const canCapture = Boolean(window.orkestrator?.bugReport) && Boolean(report);

  return (
    <Sheet
      open={open}
      onOpenChange={(next) => {
        if (!next) closeSheet();
      }}
    >
      <SheetContent
        className="max-w-[min(100vw,44rem)]"
        data-testid="bug-report-sheet"
        // The composer focuses itself; Radix would otherwise focus the close button.
        onOpenAutoFocus={(event) => event.preventDefault()}
      >
        <div className="shrink-0 border-b border-border/70 bg-chrome px-4 py-3 pr-10">
          <div className="flex min-w-0 items-center gap-2">
            <Bug className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
            <SheetTitle className="text-sm font-semibold">Report a bug</SheetTitle>
            <MachinePicker />
          </div>
          <SheetDescription className="mt-1 whitespace-normal">
            An agent asks what went wrong, reads this machine's logs and drafts a GitHub issue for
            you to approve. Closing this panel keeps the report.
          </SheetDescription>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <span className="flex items-center gap-1.5 rounded-md border border-emerald-500/25 bg-emerald-500/10 px-2 py-0.5 text-[11px] text-emerald-200">
              <LockKeyhole className="size-3" aria-hidden="true" />
              Writes only to its scratch folder · asks before commands
            </span>
            <div className="ml-auto flex items-center gap-1">
              {canCapture ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-7 gap-1.5 px-2 text-xs"
                  disabled={capturing}
                  onClick={() => void capture()}
                >
                  <Camera className="size-3.5" aria-hidden="true" />
                  Capture window
                </Button>
              ) : null}
              {report ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-7 gap-1.5 px-2 text-xs text-muted-foreground hover:text-destructive"
                  onClick={() => {
                    if (confirmDiscard) void discard();
                    else setConfirmDiscard(true);
                  }}
                  onBlur={() => setConfirmDiscard(false)}
                >
                  <Trash2 className="size-3.5" aria-hidden="true" />
                  {confirmDiscard ? "Discard report?" : "Discard"}
                </Button>
              ) : null}
            </div>
          </div>
        </div>

        {report?.filed ? (
          <FiledNotice
            url={report.filed.url}
            screenshots={report.screenshots}
            onDone={() => void discard()}
          />
        ) : browserHandoff ? (
          <div className="shrink-0 space-y-2 border-b border-border/70 bg-sky-500/5 px-4 py-3 text-sm">
            <p className="font-medium">Finish on GitHub</p>
            <p className="text-xs text-muted-foreground">
              {browserHandoff.reason}, so the new-issue page was opened with the draft filled in.
              {browserHandoff.bodyCopied
                ? " The body was too long for the link and is on your clipboard: paste it into the description."
                : ""}{" "}
              Paste the new issue's URL here once you have submitted it.
            </p>
            <div className="flex gap-2">
              <Input
                value={issueUrl}
                onChange={(event) => setIssueUrl(event.target.value)}
                placeholder="https://github.com/orkestrator-ai/orkestrator-v2/issues/…"
                className="h-8 text-xs"
                aria-label="GitHub issue URL"
              />
              <Button
                type="button"
                size="sm"
                className="h-8"
                disabled={!issueUrl.trim()}
                onClick={() => void markFiled()}
              >
                Done
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-8"
                onClick={() => setBrowserHandoff(null)}
              >
                Back
              </Button>
            </div>
          </div>
        ) : draft ? (
          <div className="shrink-0 border-b border-border/70 bg-amber-500/5 px-4 py-3">
            <div className="flex items-start gap-2">
              <div className="min-w-0 flex-1">
                <p className="text-[11px] uppercase tracking-wide text-muted-foreground">
                  Draft issue
                </p>
                <p className="truncate text-sm font-medium" title={draft.title}>
                  {draft.title}
                </p>
              </div>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-7 gap-1 px-2 text-xs"
                aria-expanded={draftExpanded}
                onClick={() => setDraftExpanded((value) => !value)}
              >
                {draftExpanded ? "Hide" : "Review"}
                <ChevronDown
                  className={`size-3.5 transition-transform ${draftExpanded ? "rotate-180" : ""}`}
                  aria-hidden="true"
                />
              </Button>
            </div>
            {draftExpanded ? (
              <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap rounded-md border border-border/60 bg-background/60 p-2 font-mono text-[11px] leading-relaxed">
                {draft.body}
              </pre>
            ) : null}
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <Button
                type="button"
                size="sm"
                className="h-7 gap-1.5 text-xs"
                disabled={filing}
                onClick={() => void file()}
              >
                {filing ? (
                  <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
                ) : (
                  <Send className="size-3.5" aria-hidden="true" />
                )}
                File issue
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-7 gap-1.5 text-xs"
                disabled={filing}
                onClick={() => void file("browser")}
              >
                <ExternalLink className="size-3.5" aria-hidden="true" />
                Open on GitHub instead
              </Button>
              <span className="text-[11px] text-muted-foreground">
                Public issue. Check it for anything private first.
              </span>
            </div>
          </div>
        ) : null}

        <div className="min-h-0 flex-1">
          {loadError ? (
            <div className="grid h-full place-items-center p-6 text-center text-sm text-destructive">
              <div className="space-y-3">
                <p>{loadError}</p>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    closeSheet();
                    useBugReportStore.getState().openSheet();
                  }}
                >
                  Retry
                </Button>
              </div>
            </div>
          ) : !report ? (
            <div className="grid h-full place-items-center text-sm text-muted-foreground">
              <Loader2 className="size-5 animate-spin" aria-label="Starting the bug report" />
            </div>
          ) : (
            <AgentNativeTab
              key={`${report.id}:${report.agent ?? "unassigned"}`}
              tabId={report.tabId}
              data={{
                platform: report.agent,
                environmentId: report.runtimeId,
                isLocal: true,
                ...(report.providerSessionId ? { sessionId: report.providerSessionId } : {}),
              }}
              isActive
              ownsGlobalShortcuts={false}
              coordinatorWorkspacePath={report.scratchDir}
              availablePlatforms={BUG_REPORT_AGENTS}
              unassignedPlaceholder="Describe what went wrong, and what you expected to happen…"
              emptyPlatformsMessage="Bug reports use Claude Code, Codex or OpenCode. Enable one of them in Settings → Agents."
              onAssignPlatform={report.agent ? undefined : assign}
              {...(launch
                ? {
                    initialPrompt: launch.prompt,
                    initialAgentModel: launch.modelId,
                    initialReasoningEffort: launch.reasoningId,
                    initialConversationMode: launch.mode,
                    initialFastMode: launch.fastMode,
                    initialExecutionProfileId: launch.executionProfileId,
                  }
                : {})}
            />
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}

function FiledNotice({
  url,
  screenshots,
  onDone,
}: {
  url: string;
  screenshots: readonly string[];
  onDone: () => void;
}) {
  return (
    <div className="shrink-0 space-y-2 border-b border-border/70 bg-emerald-500/5 px-4 py-3 text-sm">
      <p className="font-medium">Issue filed. Thank you!</p>
      <button
        type="button"
        className="block max-w-full truncate text-left text-xs text-sky-300 underline-offset-2 hover:underline"
        onClick={() => void openInBrowser(url)}
      >
        {url}
      </button>
      {screenshots.length > 0 ? (
        <p className="text-xs text-muted-foreground">
          Screenshots are not attached automatically. Drag{" "}
          {screenshots.length === 1 ? "it" : `these ${screenshots.length}`} into the issue on
          GitHub.
        </p>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="h-7 gap-1.5 text-xs"
          onClick={() => void openInBrowser(url)}
        >
          <ExternalLink className="size-3.5" aria-hidden="true" />
          Open issue
        </Button>
        {screenshots.length > 0 ? (
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="h-7 gap-1.5 text-xs"
            onClick={() =>
              void revealBugReportPath(screenshots[0]!).catch((error: unknown) =>
                toast.error("Could not show the screenshots", { description: errorText(error) }),
              )
            }
          >
            <FolderOpen className="size-3.5" aria-hidden="true" />
            Show screenshots
          </Button>
        ) : null}
        <Button type="button" size="sm" className="h-7 text-xs" onClick={onDone}>
          Done
        </Button>
      </div>
      <p className="text-[11px] text-muted-foreground">
        Done deletes the report's scratch folder, screenshots included.
      </p>
    </div>
  );
}

/** The machines a report can run on, by the label each is shown with. */
function useMachineLabel(): string {
  const machines = useMachineViews();
  const own = ownBugReportMachineId();
  const machine =
    machines.find((candidate) => candidate.bound) ??
    machines.find((candidate) => candidate.connectionId === own || candidate.backendId === own);
  return machine?.name ?? "This machine";
}

/**
 * Which machine's logs the report reads. A report runs where its sheet is
 * hosted, so choosing another machine hands the report over to that
 * machine's own sheet.
 */
function MachinePicker() {
  const machines = useMachineViews();
  const label = useMachineLabel();
  const own = ownBugReportMachineId();
  const current = useMemo(
    () =>
      machines.find((machine) => machine.bound) ??
      machines.find((machine) => machine.connectionId === own || machine.backendId === own) ??
      null,
    [machines, own],
  );
  const triggerRef = useRef<HTMLButtonElement>(null);
  if (machines.length < 2) {
    return <span className="truncate text-xs text-muted-foreground">on {label}</span>;
  }
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          ref={triggerRef}
          type="button"
          variant="ghost"
          size="sm"
          className="h-6 min-w-0 gap-1 px-1.5 text-xs text-muted-foreground"
          aria-label={`Machine: ${label}`}
        >
          <span className="truncate">on {label}</span>
          <ChevronDown className="size-3 shrink-0" aria-hidden="true" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-64">
        <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">
          The agent reads the logs of the machine it runs on
        </DropdownMenuLabel>
        <DropdownMenuRadioGroup
          value={current?.connectionId ?? ""}
          onValueChange={(connectionId) => {
            if (connectionId === current?.connectionId) return;
            const machine = machines.find((candidate) => candidate.connectionId === connectionId);
            if (machine) openBugReport(machine.connectionId);
          }}
        >
          {machines.map((machine) => (
            <DropdownMenuRadioItem
              key={machine.connectionId}
              value={machine.connectionId}
              disabled={machine.transport !== "connected" && !machine.bound}
            >
              <span className="truncate">{machine.name}</span>
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
