import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AlertCircle, ChevronRight, Loader2 } from "lucide-react";
import type {
  ProjectCopyCandidate,
  ProjectCopyOptions,
  ProjectCopyRecord,
} from "@orkestrator/protocol/project-copy";
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
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Progress } from "@/components/ui/progress";
import { formatBytes } from "@/components/docker/docker-stats-format";
import { openMachineWorkspace } from "@/lib/federation/open-workspace";
import { resolveNodeActionRequest } from "@/lib/portal/portal-store";
import {
  copyProjectToNode,
  getProjectCopyOptions,
  listenProjectCopies,
  listProjectCopies,
} from "@/lib/portal/project-copy";
import { cn } from "@/lib/utils";
import { useProjectCopyStore, type ProjectCopyDialogRequest } from "@/stores/projectCopyStore";
import { MachineDot } from "./MachineDot";
import { useMachineViews } from "./useMachineViews";

/**
 * Copy a project to another machine: a fresh clone of its Git remote there,
 * plus the untracked and ignored files the user picks. `.env` files and the
 * project's files to copy are ticked; dependency and build output is listed
 * but never ticked, because it is installed on each machine. Approving a
 * coordinator's request to copy its project uses the same dialog.
 */
export function ProjectCopyDialog() {
  const request = useProjectCopyStore((state) => state.request);
  const close = useProjectCopyStore((state) => state.close);
  if (!request) return null;
  return <ProjectCopyDialogBody key={requestIdentity(request)} request={request} onClose={close} />;
}

function requestIdentity(request: ProjectCopyDialogRequest): string {
  return `${request.source.nodeId}:${request.source.projectId}:${request.actionRequestId ?? ""}`;
}

const STAGE_LABELS: Record<ProjectCopyRecord["stage"], string> = {
  queued: "Starting",
  cloning: "Cloning the repository",
  listing: "Listing the files",
  copying: "Copying files",
  configuring: "Copying the repository settings",
  completed: "Copied",
  failed: "The copy failed",
};

function size(entry: Pick<ProjectCopyCandidate, "bytes" | "truncated">): string {
  return `${entry.truncated ? "at least " : ""}${formatBytes(entry.bytes)}`;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function ProjectCopyDialogBody({
  request,
  onClose,
}: {
  request: ProjectCopyDialogRequest;
  onClose: () => void;
}) {
  const machines = useMachineViews();
  const colorOf = (nodeId: string) =>
    machines.find((machine) => machine.backendId === nodeId)?.colorToken;
  const [options, setOptions] = useState<ProjectCopyOptions | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [targetId, setTargetId] = useState<string | null>(request.targetNodeId ?? null);
  const [location, setLocation] = useState(request.location ?? "");
  const locationEdited = useRef(Boolean(request.location));
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [remember, setRemember] = useState(true);
  const [filter, setFilter] = useState("");
  const [showHeavy, setShowHeavy] = useState(false);
  const [busy, setBusy] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [record, setRecord] = useState<ProjectCopyRecord | null>(null);
  const [tracking, setTracking] = useState<{
    copyId?: string;
    actionRequestId?: string;
  } | null>(null);
  const requestKey = useMemo(() => crypto.randomUUID(), []);
  const lastCopy = useRef<Parameters<typeof copyProjectToNode>[0] | null>(null);
  const approving = Boolean(request.actionRequestId);

  useEffect(() => {
    let active = true;
    void getProjectCopyOptions(request.source.nodeId, request.source.projectId)
      .then((value) => {
        if (!active) return;
        setOptions(value);
        const paths = new Set(request.paths ?? []);
        setSelected(
          new Set(
            value.candidates
              .filter((entry) => entry.suggested || paths.has(entry.path))
              .map((entry) => entry.path),
          ),
        );
        if (!request.targetNodeId) {
          const first =
            value.targets.find((target) => !target.unavailableReason && !target.hasProject) ??
            value.targets.find((target) => !target.unavailableReason);
          if (first) setTargetId(first.nodeId);
        }
      })
      .catch((error: unknown) => {
        if (active) setLoadError(errorText(error));
      });
    return () => {
      active = false;
    };
  }, [request]);

  const target = options?.targets.find((entry) => entry.nodeId === targetId) ?? null;

  useEffect(() => {
    if (!target || locationEdited.current) return;
    setLocation(target.defaultLocation ?? "");
  }, [target]);

  // Follow the copy's progress once it has started.
  const refreshRecord = useCallback(() => {
    if (!tracking) return;
    void listProjectCopies()
      .then((records) => {
        const found = records.find((entry) =>
          tracking.copyId
            ? entry.copyId === tracking.copyId
            : entry.actionRequestId === tracking.actionRequestId,
        );
        if (found) setRecord(found);
      })
      .catch(() => undefined);
  }, [tracking]);

  useEffect(() => {
    if (!tracking) return;
    refreshRecord();
    let stop: (() => void) | null = null;
    let active = true;
    // A copy reports every file; read at most a few times a second.
    let queued: ReturnType<typeof setTimeout> | null = null;
    const throttled = () => {
      if (queued) return;
      queued = setTimeout(() => {
        queued = null;
        refreshRecord();
      }, 400);
    };
    void listenProjectCopies(throttled).then((unlisten) => {
      if (active) stop = unlisten;
      else unlisten();
    });
    // Events are hints: a slow poll covers one that was missed.
    const timer = setInterval(refreshRecord, 3_000);
    return () => {
      active = false;
      stop?.();
      clearInterval(timer);
      if (queued) clearTimeout(queued);
    };
  }, [tracking, refreshRecord]);

  const candidates = options?.candidates ?? [];
  const visible = candidates.filter(
    (entry) => !filter.trim() || entry.path.toLowerCase().includes(filter.trim().toLowerCase()),
  );
  const light = visible.filter((entry) => !entry.heavy);
  const heavy = visible.filter((entry) => entry.heavy);
  const chosen = candidates.filter((entry) => selected.has(entry.path));
  const totals = chosen.reduce(
    (sum, entry) => ({
      files: sum.files + entry.files,
      bytes: sum.bytes + entry.bytes,
      truncated: sum.truncated || entry.truncated,
    }),
    { files: 0, bytes: 0, truncated: false },
  );
  const overLimit =
    options && (totals.files > options.limits.files || totals.bytes > options.limits.bytes)
      ? `That is more than one copy can move (${options.limits.files.toLocaleString()} files, ${formatBytes(options.limits.bytes)}). Untick some, such as dependency folders.`
      : null;
  const locationError =
    target && !target.hasProject && !location.trim().startsWith("/")
      ? "Enter an absolute folder on that machine."
      : null;
  const canCopy = Boolean(
    options && target && !target.unavailableReason && !overLimit && !locationError && !busy,
  );

  const toggle = (path: string, value: boolean) =>
    setSelected((current) => {
      const next = new Set(current);
      if (value) next.add(path);
      else next.delete(path);
      return next;
    });

  const submit = async () => {
    if (!options || !target) return;
    setBusy(true);
    setSubmitError(null);
    const paths = chosen.map((entry) => entry.path);
    const chosenLocation = target.hasProject ? undefined : location.trim();
    try {
      if (request.actionRequestId) {
        const resolved = await resolveNodeActionRequest(request.actionRequestId, "approve", {
          ...(chosenLocation ? { location: chosenLocation } : {}),
          paths,
          rememberFiles: remember,
        });
        if (resolved.state !== "executed") {
          throw new Error(resolved.result?.message ?? `The request is ${resolved.state}.`);
        }
        setTracking({ actionRequestId: request.actionRequestId });
      } else {
        lastCopy.current = {
          requestKey,
          source: request.source,
          target: {
            nodeId: target.nodeId,
            ...(chosenLocation ? { location: chosenLocation } : {}),
          },
          paths,
          rememberFiles: remember,
        };
        const started = await copyProjectToNode(lastCopy.current);
        setRecord(started);
        setTracking({ copyId: started.copyId });
      }
    } catch (error) {
      setSubmitError(errorText(error));
    } finally {
      setBusy(false);
    }
  };

  /** The same copy again: it reuses whatever the failed run left on the target. */
  const retry = async () => {
    const input =
      lastCopy.current ??
      (record
        ? {
            requestKey: record.requestKey,
            source: { nodeId: record.source.nodeId, projectId: record.source.projectId },
            target: { nodeId: record.target.nodeId, location: record.target.location },
            paths: record.paths,
            rememberFiles: record.rememberFiles,
          }
        : null);
    if (!input) return;
    setBusy(true);
    try {
      setRecord(await copyProjectToNode(input));
    } catch (error) {
      setRecord((current) =>
        current ? { ...current, error: { code: "failed", message: errorText(error) } } : current,
      );
    } finally {
      setBusy(false);
    }
  };

  const reject = async () => {
    if (!request.actionRequestId) return onClose();
    setBusy(true);
    try {
      await resolveNodeActionRequest(request.actionRequestId, "reject");
      onClose();
    } catch (error) {
      setSubmitError(errorText(error));
    } finally {
      setBusy(false);
    }
  };

  const projectName = options?.source.projectName ?? "this project";
  const started = tracking !== null;

  return (
    <Dialog open onOpenChange={(open) => !open && !busy && onClose()}>
      <DialogContent className="sm:max-w-2xl" data-testid="project-copy-dialog">
        <DialogHeader>
          <DialogTitle>
            Copy {projectName}
            {options ? ` from ${options.source.nodeName}` : ""} to another machine
          </DialogTitle>
          <DialogDescription>
            {approving
              ? `The project coordinator asked for this${request.reason ? `: “${request.reason}”` : "."} Nothing is copied unless you approve it.`
              : "The repository is cloned there from its Git remote. Pick the files Git does not carry that the copy needs, such as .env files. Dependencies are installed there, not copied."}
          </DialogDescription>
        </DialogHeader>

        {loadError ? (
          <p role="alert" className="flex items-start gap-2 text-sm text-destructive">
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
            {loadError}
          </p>
        ) : !options ? (
          <div className="flex items-center gap-2 py-6 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> Reading the project…
          </div>
        ) : started ? (
          <CopyProgress record={record} />
        ) : (
          <div className="space-y-5">
            <section className="space-y-2">
              <Label className="text-sm font-medium">Copy to</Label>
              <div className="space-y-1" role="radiogroup" aria-label="Machine to copy to">
                {options.targets.length === 0 ? (
                  <p className="text-sm text-muted-foreground">
                    This command node controls no other machine yet.
                  </p>
                ) : null}
                {options.targets.map((entry) => {
                  const disabled =
                    Boolean(entry.unavailableReason) ||
                    (approving && entry.nodeId !== request.targetNodeId);
                  return (
                    <label
                      key={entry.nodeId}
                      className={cn(
                        "flex items-center gap-3 rounded-md px-2 py-1.5",
                        disabled ? "opacity-50" : "cursor-pointer hover:bg-white/[0.04]",
                      )}
                    >
                      <input
                        type="radio"
                        name="project-copy-target"
                        className="accent-primary"
                        checked={targetId === entry.nodeId}
                        disabled={disabled || busy}
                        onChange={() => setTargetId(entry.nodeId)}
                        aria-label={entry.nodeName}
                      />
                      <MachineDot colorToken={colorOf(entry.nodeId)} machineName={entry.nodeName} />
                      <span className="min-w-0 flex-1 truncate text-sm">
                        {entry.nodeName}
                        {entry.unavailableReason ? (
                          <span className="ml-2 text-xs text-muted-foreground">
                            {entry.unavailableReason}
                          </span>
                        ) : entry.hasProject ? (
                          <span className="ml-2 text-xs text-muted-foreground">
                            already has it: only files it lacks are copied
                          </span>
                        ) : null}
                      </span>
                    </label>
                  );
                })}
              </div>
            </section>

            {target ? (
              <section className="space-y-2">
                <Label htmlFor="project-copy-location" className="text-sm font-medium">
                  Location on {target.nodeName}
                </Label>
                <Input
                  id="project-copy-location"
                  value={target.hasProject ? (target.defaultLocation ?? "") : location}
                  disabled={target.hasProject || busy}
                  onChange={(event) => {
                    locationEdited.current = true;
                    setLocation(event.target.value);
                  }}
                  spellCheck={false}
                  className="font-mono"
                  placeholder="/path/on/that/machine"
                  aria-invalid={locationError ? true : undefined}
                />
                {locationError ? <p className="text-xs text-destructive">{locationError}</p> : null}
              </section>
            ) : null}

            <section className="space-y-2">
              <div className="flex items-center justify-between gap-3">
                <Label className="text-sm font-medium">Files Git does not carry</Label>
                {candidates.length > 12 ? (
                  <Input
                    value={filter}
                    onChange={(event) => setFilter(event.target.value)}
                    placeholder="Filter"
                    aria-label="Filter files"
                    className="h-7 w-44 text-xs"
                  />
                ) : null}
              </div>
              {candidates.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  Every file in this project is tracked by Git; the clone brings them all.
                </p>
              ) : (
                <div className="max-h-64 overflow-y-auto rounded-md border border-white/[0.08] p-1">
                  {light.map((entry) => (
                    <CandidateRow
                      key={entry.path}
                      entry={entry}
                      checked={selected.has(entry.path)}
                      disabled={busy}
                      onChange={(value) => toggle(entry.path, value)}
                    />
                  ))}
                  {heavy.length > 0 ? (
                    <>
                      <button
                        type="button"
                        className="flex w-full items-center gap-1 px-2 py-1.5 text-left text-xs text-muted-foreground hover:text-foreground"
                        onClick={() => setShowHeavy((value) => !value)}
                        aria-expanded={showHeavy}
                      >
                        <ChevronRight
                          className={cn(
                            "h-3.5 w-3.5 transition-transform",
                            showHeavy && "rotate-90",
                          )}
                        />
                        Dependencies and build output ({heavy.length}) — installed on each machine
                      </button>
                      {showHeavy
                        ? heavy.map((entry) => (
                            <CandidateRow
                              key={entry.path}
                              entry={entry}
                              checked={selected.has(entry.path)}
                              disabled={busy}
                              onChange={(value) => toggle(entry.path, value)}
                            />
                          ))
                        : null}
                    </>
                  ) : null}
                </div>
              )}
              {options.candidatesTruncated ? (
                <p className="text-xs text-muted-foreground">
                  Only the first {candidates.length.toLocaleString()} entries are listed.
                </p>
              ) : null}
              <p className="text-xs text-muted-foreground" aria-live="polite">
                {chosen.length === 0
                  ? "No files picked: only the clone is made."
                  : `${chosen.length} picked · ${totals.truncated ? "at least " : ""}${totals.files.toLocaleString()} file${totals.files === 1 ? "" : "s"}, ${totals.truncated ? "at least " : ""}${formatBytes(totals.bytes)}`}
              </p>
              {overLimit ? <p className="text-xs text-destructive">{overLimit}</p> : null}
            </section>

            {target ? (
              <label className="flex items-start gap-3 text-sm">
                <Checkbox
                  checked={remember}
                  disabled={busy || chosen.length === 0}
                  onCheckedChange={(value) => setRemember(value === true)}
                  aria-label="Also copy these files into new environments there"
                />
                <span>
                  Also copy these files into new environments on {target.nodeName}
                  <span className="block text-xs text-muted-foreground">
                    Adds them to that copy's files to copy in its repository settings.
                  </span>
                </span>
              </label>
            ) : null}

            {submitError ? (
              <p role="alert" className="flex items-start gap-2 text-sm text-destructive">
                <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
                {submitError}
              </p>
            ) : null}
          </div>
        )}

        <DialogFooter>
          {started ? (
            <>
              {record?.stage === "completed" && record.target.projectId ? (
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => {
                    openMachineWorkspace({
                      connectionId: record.target.nodeId,
                      projectId: record.target.projectId!,
                      title: record.source.projectName,
                    });
                    onClose();
                  }}
                >
                  Open on {record.target.nodeName}
                </Button>
              ) : null}
              {record?.stage === "failed" ? (
                <Button
                  type="button"
                  variant="outline"
                  disabled={busy}
                  onClick={() => void retry()}
                >
                  Try again
                </Button>
              ) : null}
              <Button type="button" onClick={onClose}>
                {record?.stage === "completed" || record?.stage === "failed"
                  ? "Close"
                  : "Hide (keeps copying)"}
              </Button>
            </>
          ) : (
            <>
              <Button type="button" variant="outline" disabled={busy} onClick={() => void reject()}>
                {approving ? "Reject" : "Cancel"}
              </Button>
              <Button type="button" disabled={!canCopy} onClick={() => void submit()}>
                {busy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
                {approving ? "Approve and copy" : "Copy"}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function CandidateRow({
  entry,
  checked,
  disabled,
  onChange,
}: {
  entry: ProjectCopyCandidate;
  checked: boolean;
  disabled: boolean;
  onChange: (value: boolean) => void;
}) {
  return (
    <label
      className="flex items-center gap-3 rounded px-2 py-1 hover:bg-white/[0.04]"
      data-testid="project-copy-candidate"
      data-path={entry.path}
    >
      <Checkbox
        checked={checked}
        disabled={disabled}
        onCheckedChange={(value) => onChange(value === true)}
        aria-label={entry.path}
      />
      <span className="min-w-0 flex-1 truncate font-mono text-xs">{entry.path}</span>
      <span className="shrink-0 text-xs text-muted-foreground">
        {entry.kind === "directory"
          ? `${entry.truncated ? "≥ " : ""}${entry.files.toLocaleString()} files · `
          : ""}
        {size(entry)}
        {entry.ignored ? "" : " · untracked"}
      </span>
    </label>
  );
}

function CopyProgress({ record }: { record: ProjectCopyRecord | null }) {
  if (!record) {
    return (
      <div className="flex items-center gap-2 py-6 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" /> Starting the copy…
      </div>
    );
  }
  const { progress } = record;
  const copiedFiles = progress.files - (progress.existing ?? 0);
  const copiedBytes = progress.bytes - (progress.existingBytes ?? 0);
  const percent =
    record.stage === "completed"
      ? 100
      : progress.totalBytes > 0
        ? Math.round((progress.bytes / progress.totalBytes) * 100)
        : progress.totalFiles > 0
          ? Math.round((progress.files / progress.totalFiles) * 100)
          : 0;
  const running = record.stage !== "completed" && record.stage !== "failed";
  return (
    <div className="space-y-3 py-2" role="status" aria-live="polite">
      <p className="flex items-center gap-2 text-sm">
        {running ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
        {STAGE_LABELS[record.stage]}
        {record.stage === "cloning" ? ` on ${record.target.nodeName}` : ""}
        {record.stage === "copying"
          ? ` (${progress.files.toLocaleString()} of ${progress.totalFiles.toLocaleString()})`
          : ""}
      </p>
      {record.stage === "copying" || record.stage === "completed" ? (
        <Progress value={percent} aria-label="Copy progress" />
      ) : null}
      <p className="font-mono text-xs text-muted-foreground">
        {record.target.nodeName}: {record.target.location || "default projects folder"}
      </p>
      {record.stage === "completed" ? (
        <p className="text-sm text-muted-foreground">
          {record.reusedProject ? "Added to the existing copy" : "Cloned"}
          {progress.totalFiles > 0
            ? `, with ${copiedFiles.toLocaleString()} file${copiedFiles === 1 ? "" : "s"} (${formatBytes(copiedBytes)})`
            : ""}
          .
          {record.tooLarge.length > 0
            ? ` ${record.tooLarge.length} file(s) over 64 MiB were not copied.`
            : ""}
        </p>
      ) : null}
      {record.error ? (
        <p role="alert" className="flex items-start gap-2 text-sm text-destructive">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
          {record.error.message}
        </p>
      ) : null}
    </div>
  );
}
