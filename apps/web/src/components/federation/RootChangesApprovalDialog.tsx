import { useEffect, useMemo, useState } from "react";
import { AlertCircle, Loader2 } from "lucide-react";
import { toast } from "sonner";
import type { RootChangeFile } from "@orkestrator/protocol/coordinator-surfaces";
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
import {
  listProjectRootChanges,
  resolveNodeActionRequest,
  type NodeActionRequestView,
  type RootChangesListing,
} from "@/lib/portal/portal-store";

const STATUS_LABEL: Record<RootChangeFile["status"], string> = {
  modified: "modified",
  added: "added",
  deleted: "deleted",
  renamed: "renamed",
  untracked: "new",
};

/** At most this many files go in one request; the backend refuses more. */
const MAX_SELECTION = 500;

/**
 * A coordinator asked to apply some of the project checkout's uncommitted
 * changes to a worker. The user picks the files here; the ones the
 * coordinator named start ticked. Nothing is read into the worker until the
 * user approves, and the patch then applies whole or not at all.
 */
export function RootChangesApprovalDialog({
  request,
  onSettled,
}: {
  request: NodeActionRequestView;
  onSettled: () => void;
}) {
  const target = request.targets[0];
  const projectId = target?.projectId ?? request.requestedBy?.projectId;
  const [listing, setListing] = useState<RootChangesListing | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  // Null until the user changes the selection: the coordinator's suggestion.
  const [picked, setPicked] = useState<Set<string> | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!projectId) return;
    let active = true;
    void listProjectRootChanges(projectId)
      .then((value) => {
        if (active) setListing(value);
      })
      .catch((error: unknown) => {
        if (active) setLoadError(error instanceof Error ? error.message : String(error));
      });
    return () => {
      active = false;
    };
  }, [projectId]);

  const selected = useMemo(() => {
    if (picked) return picked;
    const changed = new Set(listing?.files.map((file) => file.path) ?? []);
    return new Set((target?.files ?? []).filter((file) => changed.has(file)));
  }, [listing, picked, target?.files]);

  const toggle = (path: string, value: boolean) => {
    const next = new Set(selected);
    if (value) next.add(path);
    else next.delete(path);
    setPicked(next);
  };

  const decide = async (decision: "approve" | "reject") => {
    setBusy(true);
    try {
      const resolved = await resolveNodeActionRequest(
        request.requestId,
        decision,
        decision === "approve" ? { paths: Array.from(selected) } : undefined,
      );
      if (decision === "approve") {
        if (resolved.state === "executed") toast.success(resolved.result?.message ?? "Applied.");
        else
          toast.warning(`Changes not applied: ${resolved.state}`, {
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

  const worker = target?.environmentName ?? target?.environmentId ?? "a worker";
  const files = listing?.files ?? [];
  const tooMany = selected.size > MAX_SELECTION;

  return (
    // Like the other coordinator requests, it stays until approved or rejected.
    <Dialog open>
      <DialogContent
        className="max-w-xl"
        data-testid="root-changes-request"
        showCloseButton={false}
      >
        <DialogHeader>
          <DialogTitle>Apply uncommitted changes to “{worker}”?</DialogTitle>
          <DialogDescription>
            The project coordinator asked to copy some of this checkout&apos;s uncommitted changes
            into that worker. Pick the files; nothing happens unless you approve.
            {request.reason ? ` Its reason: “${request.reason}”` : ""}
          </DialogDescription>
        </DialogHeader>

        {loadError || !projectId ? (
          <p className="flex items-center gap-2 text-sm text-destructive">
            <AlertCircle className="h-4 w-4" /> {loadError ?? "This request names no project."}
          </p>
        ) : !listing ? (
          <p className="flex items-center gap-2 py-4 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> Reading the checkout&apos;s changes…
          </p>
        ) : files.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            The checkout has no uncommitted changes now.
          </p>
        ) : (
          <section className="space-y-2">
            <div className="flex items-center justify-between text-xs text-muted-foreground">
              <span aria-live="polite">
                {selected.size} of {files.length} picked
              </span>
              <span className="flex gap-2">
                <button
                  type="button"
                  className="hover:text-foreground"
                  disabled={busy}
                  onClick={() => setPicked(new Set(files.map((file) => file.path)))}
                >
                  Select all
                </button>
                <button
                  type="button"
                  className="hover:text-foreground"
                  disabled={busy}
                  onClick={() => setPicked(new Set())}
                >
                  Clear
                </button>
              </span>
            </div>
            <div className="max-h-72 overflow-y-auto rounded-md border border-white/[0.08] p-1">
              {files.map((file) => (
                <label
                  key={file.path}
                  className="flex items-center gap-3 rounded px-2 py-1 hover:bg-white/[0.04]"
                  data-testid="root-change-file"
                  data-path={file.path}
                >
                  <Checkbox
                    checked={selected.has(file.path)}
                    disabled={busy}
                    onCheckedChange={(value) => toggle(file.path, value === true)}
                    aria-label={file.path}
                  />
                  <span className="min-w-0 flex-1 truncate font-mono text-xs">{file.path}</span>
                  <span className="shrink-0 text-xs text-muted-foreground">
                    {STATUS_LABEL[file.status]}
                  </span>
                </label>
              ))}
            </div>
            {listing.truncated ? (
              <p className="text-xs text-muted-foreground">
                Only the first {files.length.toLocaleString()} changed files are listed.
              </p>
            ) : null}
            {listing.conflicts > 0 ? (
              <p className="text-xs text-muted-foreground">
                {listing.conflicts} conflicted file{listing.conflicts === 1 ? " is" : "s are"} left
                out.
              </p>
            ) : null}
            {tooMany ? (
              <p className="text-xs text-destructive">Pick at most {MAX_SELECTION} files.</p>
            ) : null}
          </section>
        )}

        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            disabled={busy}
            onClick={() => void decide("reject")}
          >
            Reject
          </Button>
          <Button
            type="button"
            disabled={busy || !listing || selected.size === 0 || tooMany}
            onClick={() => void decide("approve")}
          >
            {busy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
            Apply {selected.size} file{selected.size === 1 ? "" : "s"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
