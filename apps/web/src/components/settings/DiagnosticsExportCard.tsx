import { useCallback, useState } from "react";
import { Download, Loader2 } from "lucide-react";
import type { DiagnosticsBundlePlan } from "@orkestrator/protocol/backend-diagnostics";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Z_FULLSCREEN_DIALOG } from "@/constants/z-index";
import * as backend from "@/lib/backend";
import { base64ToBytes, downloadBlob } from "@/lib/chat/artifact-download";
import { sha256HexOfBytes } from "@/lib/chat/static-html-document";
import { cn } from "@/lib/utils";
import { incompatibilityNotice, type IncompatibilityNotice } from "@/lib/federation/fleet-currency";
import { portalStore } from "@/lib/portal/portal-store";
import { useAccountMachine } from "./account-machine";
import { formatDiagnosticsBytes } from "./DatabaseStorageCard";

/** The node a Settings machine choice names: `null` is the command node, `undefined` this view's. */
function settingsMachineNodeId(machine: string | null | undefined): string | null {
  if (typeof machine === "string") return machine;
  return portalStore.getState().selfId;
}

function failureNotice(
  error: unknown,
  fallback: string,
  machine: string | null | undefined,
  machineName: string | null,
  command: string,
): IncompatibilityNotice {
  // A typed incompatibility leads to the machine's update (plan item 5006).
  const tooOld = incompatibilityNotice(
    error,
    { nodeId: settingsMachineNodeId(machine), label: machineName ?? "this machine" },
    command,
  );
  if (tooOld) return tooOld;
  return { text: (error instanceof Error ? error.message : "") || fallback };
}

const UPDATE_IT = "Update it.";

/** The failure; an incompatibility's closing "Update it." opens the machine's update. */
function FailureText({ failure }: { failure: IncompatibilityNotice }) {
  const linked = failure.update && failure.text.endsWith(UPDATE_IT);
  return (
    <p className="text-xs text-destructive" role="alert">
      {linked ? failure.text.slice(0, -UPDATE_IT.length) : failure.text}
      {linked ? (
        <button
          type="button"
          className="underline underline-offset-2 hover:text-foreground"
          onClick={failure.update!.onClick}
        >
          {UPDATE_IT}
        </button>
      ) : null}
    </p>
  );
}

/** Reads a plan piece by piece and checks it adds up before anything is saved. */
async function fetchBundle(
  plan: DiagnosticsBundlePlan,
  machine: Parameters<typeof backend.readDiagnosticsBundle>[2],
): Promise<Blob> {
  const parts: BlobPart[] = [];
  let received = 0;
  let offset: number | null = 0;
  while (offset !== null) {
    const chunk = await backend.readDiagnosticsBundle(plan.planId, offset, machine);
    const bytes = base64ToBytes(chunk.data);
    received += bytes.byteLength;
    parts.push(bytes as unknown as BlobPart);
    offset = chunk.nextOffset;
  }
  if (received !== plan.archive.bytes) throw new Error("The bundle did not arrive intact.");
  const blob = new Blob(parts, { type: "application/gzip" });
  const sha256 = await sha256HexOfBytes(new Uint8Array(await blob.arrayBuffer()));
  if (sha256 !== plan.archive.sha256) throw new Error("The bundle did not arrive intact.");
  return blob;
}

/**
 * Two steps, so what is shown is what is saved: the backend builds the bundle and
 * answers with its manifest, and only then does the user choose to save those
 * bytes. It goes to a download here, and nowhere else.
 */
export function DiagnosticsExportCard() {
  const { machine, name } = useAccountMachine();
  const [plan, setPlan] = useState<DiagnosticsBundlePlan | null>(null);
  const [isPlanning, setIsPlanning] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<IncompatibilityNotice | null>(null);
  const [savedName, setSavedName] = useState<string | null>(null);

  const startPlan = useCallback(async () => {
    setIsPlanning(true);
    setError(null);
    setSavedName(null);
    try {
      setPlan(await backend.planDiagnosticsBundle(machine));
    } catch (planError) {
      setError(
        failureNotice(
          planError,
          "The diagnostics bundle could not be built.",
          machine,
          name,
          "plan_diagnostics_bundle",
        ),
      );
    } finally {
      setIsPlanning(false);
    }
  }, [machine, name]);

  const save = useCallback(async () => {
    if (!plan) return;
    setIsSaving(true);
    setError(null);
    try {
      downloadBlob(await fetchBundle(plan, machine), plan.fileName);
      setSavedName(plan.fileName);
      setPlan(null);
    } catch (saveError) {
      setError(
        failureNotice(
          saveError,
          "The diagnostics bundle could not be saved.",
          machine,
          name,
          "read_diagnostics_bundle",
        ),
      );
    } finally {
      setIsSaving(false);
    }
  }, [machine, name, plan]);

  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-4 space-y-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1 basis-64">
          <p className="text-sm font-medium text-foreground">Export diagnostics</p>
          <p className="text-xs text-muted-foreground mt-1">
            Save a local bundle of metrics, health figures and redacted logs to attach to a report.
            You see what it holds first, and nothing is uploaded.
          </p>
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => void startPlan()}
          disabled={isPlanning}
        >
          {isPlanning ? (
            <Loader2 className="h-4 w-4 mr-1.5 animate-spin" />
          ) : (
            <Download className="h-4 w-4 mr-1.5" />
          )}
          {isPlanning ? "Preparing…" : "Export diagnostics"}
        </Button>
      </div>
      {savedName ? (
        <p className="text-xs text-muted-foreground" role="status">
          {`Saved ${savedName} to your downloads. Read it before sharing it.`}
        </p>
      ) : null}
      {error && !plan ? <FailureText failure={error} /> : null}
      <Dialog
        open={plan !== null}
        onOpenChange={(open) => {
          if (!open && !isSaving) setPlan(null);
        }}
      >
        <DialogContent
          size="2xl"
          className={cn("max-h-[85vh] overflow-y-auto", Z_FULLSCREEN_DIALOG)}
          overlayClassName={Z_FULLSCREEN_DIALOG}
        >
          <DialogHeader>
            <DialogTitle>Export diagnostics</DialogTitle>
            <DialogDescription>
              {plan
                ? `${plan.fileName}, ${formatDiagnosticsBytes(plan.archive.bytes)}. This is exactly what will be saved.`
                : ""}
            </DialogDescription>
          </DialogHeader>
          {plan ? (
            <div className="space-y-4 text-xs">
              <p className="rounded-md border border-amber-500/30 bg-amber-500/10 p-2 text-foreground">
                {plan.manifest.notice}
              </p>
              <ul aria-label="Files in the bundle" className="space-y-2">
                {plan.manifest.entries.map((entry) => (
                  <li key={entry.path} className="min-w-0">
                    <div className="flex justify-between gap-3">
                      <span className="min-w-0 break-all font-mono text-foreground">
                        {entry.path}
                      </span>
                      <span className="shrink-0 text-muted-foreground">
                        {formatDiagnosticsBytes(entry.bytes)}
                      </span>
                    </div>
                    <p className="text-muted-foreground">
                      {entry.description}
                      {entry.redactions > 0 ? ` ${entry.redactions} redacted.` : ""}
                    </p>
                  </li>
                ))}
              </ul>
              {plan.manifest.absent.length > 0 ? (
                <div className="space-y-1">
                  <p className="font-medium text-foreground">Not in the bundle</p>
                  <ul aria-label="Not in the bundle" className="space-y-1 text-muted-foreground">
                    {plan.manifest.absent.map((item) => (
                      <li key={item.name}>
                        <span className="font-mono">{item.name}</span>: {item.reason}
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
              {error ? <FailureText failure={error} /> : null}
            </div>
          ) : null}
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => setPlan(null)}
              disabled={isSaving}
            >
              Cancel
            </Button>
            <Button type="button" onClick={() => void save()} disabled={isSaving}>
              {isSaving ? "Saving…" : "Save bundle"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
