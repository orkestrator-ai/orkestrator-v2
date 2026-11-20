import { useEffect, useState } from "react";
import { AlertTriangle, GitMerge, Loader2 } from "lucide-react";

import type {
  CapabilityDriftEntry,
  CapabilityOperationSnapshot,
} from "@orkestrator/protocol/capability-resources";
import type {
  CapabilityDriftAdoptionMode,
  CapabilityDriftMerge,
  CapabilityDriftMergeFile,
} from "@orkestrator/protocol/capability-resources-api";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Z_FULLSCREEN_DIALOG } from "@/constants/z-index";
import { capabilitiesApi } from "@/lib/backend/capabilities";

import { describeError, useDialogFocusReturn } from "./capability-format";
import { ChangePreview } from "./ChangePreview";

type Fallback = "keep-local" | "adopt" | "replace";

const OUTCOME_LABEL: Record<CapabilityDriftMergeFile["outcome"], string> = {
  unchanged: "Unchanged",
  local: "Local version",
  configured: "Configured revision",
  merged: "Merged",
  deleted: "Deleted",
  conflict: "Conflict",
};

const CONFLICT_MARKERS = /^<{7} |^={7}\r?$|^>{7} /m;

/** The text a resolution starts from: the marked-up merge, or the surviving side. */
function initialResolution(file: CapabilityDriftMergeFile): string {
  const conflict = file.conflict;
  return conflict?.merged ?? conflict?.local ?? conflict?.configured ?? "";
}

function SideText({ label, text }: { label: string; text: string | undefined }) {
  return (
    <div className="min-w-0 space-y-1">
      <div className="text-[11px] font-medium text-muted-foreground">{label}</div>
      <pre
        className="focus-hairline max-h-48 overflow-auto rounded border border-zinc-800 bg-zinc-950 p-2 text-[11px] whitespace-pre-wrap break-words"
        role="region"
        aria-label={label}
        tabIndex={0}
      >
        {text ?? "(no file)"}
      </pre>
    </div>
  );
}

/** One conflicted file: the three sides read-only, and the editable resolution. */
function ConflictEditor({
  file,
  value,
  deleted,
  onChange,
  onDeletedChange,
}: {
  file: CapabilityDriftMergeFile;
  value: string;
  deleted: boolean;
  onChange: (value: string) => void;
  onDeletedChange: (deleted: boolean) => void;
}) {
  const conflict = file.conflict!;
  const id = `merge-resolution-${file.path.replace(/[^A-Za-z0-9_-]/g, "-")}`;
  const deletion = conflict.kind === "deleted-locally" || conflict.kind === "deleted-in-revision";
  return (
    <fieldset className="min-w-0 space-y-2 rounded-md border border-amber-500/30 p-3">
      <legend className="px-1 text-xs font-medium text-foreground">{file.path}</legend>
      <p className="text-xs text-amber-200">
        {conflict.kind === "deleted-locally"
          ? "Deleted on this machine, changed in the configured revision."
          : conflict.kind === "deleted-in-revision"
            ? "Changed on this machine, deleted in the configured revision."
            : `Both sides changed the same lines${
                conflict.hunks?.length
                  ? ` (line ${conflict.hunks.map((hunk) => hunk.line).join(", ")})`
                  : ""
              }.`}
      </p>
      <div className="grid min-w-0 grid-cols-1 gap-2 md:grid-cols-3">
        <SideText label={`Installed revision (base) of ${file.path}`} text={conflict.base} />
        <SideText label={`This machine's version of ${file.path}`} text={conflict.local} />
        <SideText label={`Configured revision of ${file.path}`} text={conflict.configured} />
      </div>
      {deletion ? (
        <div className="flex flex-wrap gap-4 text-xs" role="radiogroup" aria-label={file.path}>
          <label className="flex items-center gap-2">
            <input type="radio" checked={!deleted} onChange={() => onDeletedChange(false)} />
            Keep the file with the text below
          </label>
          <label className="flex items-center gap-2">
            <input type="radio" checked={deleted} onChange={() => onDeletedChange(true)} />
            Delete the file
          </label>
        </div>
      ) : null}
      {!deleted ? (
        <div className="space-y-1">
          <Label htmlFor={id} className="text-xs">
            Resolved text for {file.path}
          </Label>
          <Textarea
            id={id}
            className="min-h-40 font-mono text-xs"
            value={value}
            onChange={(event) => onChange(event.target.value)}
            spellCheck={false}
          />
        </div>
      ) : null}
    </fieldset>
  );
}

/**
 * Merge for one package's local changes on a machine: a clean merge goes
 * straight to the usual preview and approval; conflicts are resolved here,
 * file by file, and checked again by the command node (including for
 * secrets) before the preview. Binary files changed on both sides cannot be
 * merged, so the dialog offers keep, adopt or replace instead.
 */
export function MergeLocalChangesDialog(props: {
  entry: CapabilityDriftEntry | null;
  machineNames: Record<string, string>;
  onClose: () => void;
  onApplied: () => void;
  onFallback: (entry: CapabilityDriftEntry, decision: Fallback) => void;
}) {
  const { entry, onClose } = props;
  const focusReturn = useDialogFocusReturn();
  return (
    <Dialog open={entry !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent
        {...focusReturn}
        size="5xl"
        className={Z_FULLSCREEN_DIALOG}
        overlayClassName={Z_FULLSCREEN_DIALOG}
        data-testid="capability-merge-dialog"
      >
        {entry ? <MergeBody key={entry.id} {...props} entry={entry} /> : null}
      </DialogContent>
    </Dialog>
  );
}

function MergeBody({
  entry,
  machineNames,
  onClose,
  onApplied,
  onFallback,
}: {
  entry: CapabilityDriftEntry;
  machineNames: Record<string, string>;
  onClose: () => void;
  onApplied: () => void;
  onFallback: (entry: CapabilityDriftEntry, decision: Fallback) => void;
}) {
  const [merge, setMerge] = useState<CapabilityDriftMerge | null>(null);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [texts, setTexts] = useState<Record<string, string>>({});
  const [deletions, setDeletions] = useState<Record<string, boolean>>({});

  const adopt = (result: CapabilityDriftMerge) => {
    setMerge(result);
    const conflicts = result.files.filter((file) => file.outcome === "conflict");
    setTexts(Object.fromEntries(conflicts.map((file) => [file.path, initialResolution(file)])));
    setDeletions({});
  };

  useEffect(() => {
    let cancelled = false;
    capabilitiesApi
      .mergeCapabilityDrift(entry.id)
      .then((result) => {
        if (!cancelled) adopt(result);
      })
      .catch((mergeError: unknown) => {
        if (!cancelled) setError(describeError(mergeError));
      })
      .finally(() => {
        if (!cancelled) setBusy(false);
      });
    return () => {
      cancelled = true;
    };
  }, [entry]);

  const conflicts = (merge?.files ?? []).filter(
    (file) => file.outcome === "conflict" && file.conflict?.kind !== "binary",
  );
  const unresolved = conflicts.filter(
    (file) => !deletions[file.path] && CONFLICT_MARKERS.test(texts[file.path] ?? ""),
  );

  const submit = async () => {
    if (!merge) return;
    setBusy(true);
    setError(null);
    try {
      adopt(
        await capabilitiesApi.mergeCapabilityDrift(entry.id, {
          basis: merge.basis,
          resolutions: conflicts.map((file) =>
            deletions[file.path]
              ? { path: file.path, delete: true }
              : { path: file.path, content: texts[file.path] ?? "" },
          ),
        }),
      );
    } catch (submitError) {
      setError(describeError(submitError));
    } finally {
      setBusy(false);
    }
  };

  const operation: CapabilityOperationSnapshot | undefined = merge?.operation;
  const changed = (merge?.files ?? []).filter((file) => file.outcome !== "conflict");
  return (
    <>
      <DialogHeader>
        <DialogTitle>Merge local changes</DialogTitle>
        <DialogDescription>
          {`${entry.name} on ${machineNames[entry.nodeId] ?? entry.nodeId}: combine this machine's edits with the configured revision as the package's next revision.`}
        </DialogDescription>
      </DialogHeader>
      {busy && !merge ? (
        <p className="flex items-center gap-2 text-xs text-muted-foreground">
          <Loader2 className="h-3.5 w-3.5 animate-spin" /> Reading the local files and merging…
        </p>
      ) : null}
      {error ? (
        <p className="text-xs text-rose-300" role="alert">
          {error}
        </p>
      ) : null}
      {merge ? (
        <div className="min-w-0 space-y-4">
          <p className="text-xs text-muted-foreground">
            Installed revision {merge.baseRevision.slice(0, 12)} · configured revision{" "}
            {merge.configuredRevision.slice(0, 12)}
          </p>
          {changed.length > 0 ? (
            <ul className="space-y-0.5 text-xs" aria-label="Merged files">
              {changed.map((file) => (
                <li key={file.path} className="flex flex-wrap gap-2">
                  <span className="font-mono text-foreground">{file.path}</span>
                  <span className="text-muted-foreground">{OUTCOME_LABEL[file.outcome]}</span>
                </li>
              ))}
            </ul>
          ) : null}
          {merge.unmergeable.length > 0 ? (
            <div
              className="space-y-2 rounded-md border border-rose-500/40 bg-rose-500/5 p-3 text-xs"
              role="alert"
            >
              <p className="flex items-center gap-2 font-medium text-rose-200">
                <AlertTriangle className="h-3.5 w-3.5" /> These files cannot be merged
              </p>
              <p className="text-rose-100">
                {merge.unmergeable.join(", ")} changed on this machine and in the configured
                revision, and binary or very large files cannot be merged line by line. Keep the
                local version, adopt it as the package's revision, or replace it with the configured
                revision.
              </p>
              <div className="flex flex-wrap gap-2">
                <Button size="sm" variant="ghost" onClick={() => onFallback(entry, "keep-local")}>
                  Keep local
                </Button>
                <Button size="sm" variant="ghost" onClick={() => onFallback(entry, "adopt")}>
                  Adopt local
                </Button>
                <Button size="sm" variant="outline" onClick={() => onFallback(entry, "replace")}>
                  Replace
                </Button>
              </div>
            </div>
          ) : null}
          {!operation && merge.unmergeable.length === 0 && conflicts.length > 0 ? (
            <div className="space-y-3">
              <p className="text-xs text-foreground">
                {conflicts.length === 1
                  ? "One file has conflicting changes."
                  : `${conflicts.length} files have conflicting changes.`}{" "}
                Edit each resolved text until no conflict markers are left, then check the merge.
              </p>
              {conflicts.map((file) => (
                <ConflictEditor
                  key={file.path}
                  file={file}
                  value={texts[file.path] ?? ""}
                  deleted={deletions[file.path] === true}
                  onChange={(value) => setTexts({ ...texts, [file.path]: value })}
                  onDeletedChange={(deleted) =>
                    setDeletions({ ...deletions, [file.path]: deleted })
                  }
                />
              ))}
              {unresolved.length > 0 ? (
                <p className="text-xs text-amber-200">
                  Conflict markers remain in {unresolved.map((file) => file.path).join(", ")}.
                </p>
              ) : null}
              <div className="flex flex-wrap justify-end gap-2">
                <Button size="sm" variant="ghost" onClick={onClose} disabled={busy}>
                  Cancel
                </Button>
                <Button
                  size="sm"
                  onClick={() => void submit()}
                  disabled={busy || unresolved.length > 0}
                  data-testid="capability-merge-check"
                >
                  {busy ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <GitMerge className="h-3.5 w-3.5" />
                  )}
                  Check merge
                </Button>
              </div>
            </div>
          ) : null}
          {operation ? (
            <ChangePreview
              operation={operation}
              machineNames={machineNames}
              componentNames={{}}
              onCancel={onClose}
              onApplied={() => onApplied()}
            />
          ) : null}
        </div>
      ) : null}
    </>
  );
}

/**
 * Adopt for one package's local changes: the user chooses the identity, the
 * package's next revision or a separate package (a local variant), then
 * reviews and approves the plan.
 */
export function AdoptLocalChangesDialog(props: {
  entry: CapabilityDriftEntry | null;
  machineNames: Record<string, string>;
  onClose: () => void;
  onApplied: () => void;
}) {
  const { entry, onClose } = props;
  const focusReturn = useDialogFocusReturn();
  return (
    <Dialog open={entry !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent
        {...focusReturn}
        size="3xl"
        className={Z_FULLSCREEN_DIALOG}
        overlayClassName={Z_FULLSCREEN_DIALOG}
      >
        {entry ? <AdoptBody key={entry.id} {...props} entry={entry} /> : null}
      </DialogContent>
    </Dialog>
  );
}

function AdoptBody({
  entry,
  machineNames,
  onClose,
  onApplied,
}: {
  entry: CapabilityDriftEntry;
  machineNames: Record<string, string>;
  onClose: () => void;
  onApplied: () => void;
}) {
  // An authored package's identity is Orkestrator's own; anything else keeps its source's.
  const authored = entry.packageId?.startsWith("managed:") ?? false;
  const [mode, setMode] = useState<CapabilityDriftAdoptionMode>(authored ? "revision" : "variant");
  const [operation, setOperation] = useState<CapabilityOperationSnapshot | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const review = async () => {
    setBusy(true);
    setError(null);
    try {
      setOperation(
        (
          await capabilitiesApi.previewCapabilityChange({
            kind: "adopt-drift",
            driftId: entry.id,
            mode,
          })
        ).operation,
      );
    } catch (reviewError) {
      setError(describeError(reviewError));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <DialogHeader>
        <DialogTitle>Adopt local changes</DialogTitle>
        <DialogDescription>
          Publish the local files from {machineNames[entry.nodeId] ?? entry.nodeId}, every changed
          component of the package, after the same inspection as any source.
        </DialogDescription>
      </DialogHeader>
      {operation ? (
        <ChangePreview
          operation={operation}
          machineNames={machineNames}
          componentNames={{}}
          onCancel={() => setOperation(null)}
          onApplied={() => onApplied()}
        />
      ) : (
        <div className="space-y-3 text-xs">
          <fieldset className="space-y-2">
            <legend className="mb-1 font-medium text-foreground">Publish as</legend>
            <label className="flex items-start gap-2">
              <input
                type="radio"
                className="mt-0.5"
                checked={mode === "revision"}
                onChange={() => setMode("revision")}
              />
              <span>
                <span className="text-foreground">This package's next revision</span>
                <span className="block text-muted-foreground">
                  {authored
                    ? "Every setup that uses the package gets the local version."
                    : "The package diverges from its source: its upstream updates will always need review, and taking one replaces these changes."}
                </span>
              </span>
            </label>
            <label className="flex items-start gap-2">
              <input
                type="radio"
                className="mt-0.5"
                checked={mode === "variant"}
                onChange={() => setMode("variant")}
              />
              <span>
                <span className="text-foreground">A separate package (local variant)</span>
                <span className="block text-muted-foreground">
                  A new package of its own replaces the original in its setups; the original stays
                  in the library unchanged.
                </span>
              </span>
            </label>
          </fieldset>
          {error ? (
            <p className="text-rose-300" role="alert">
              {error}
            </p>
          ) : null}
          <div className="flex flex-wrap justify-end gap-2">
            <Button size="sm" variant="ghost" onClick={onClose} disabled={busy}>
              Cancel
            </Button>
            <Button size="sm" onClick={() => void review()} disabled={busy}>
              {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
              Review
            </Button>
          </div>
        </div>
      )}
    </>
  );
}
