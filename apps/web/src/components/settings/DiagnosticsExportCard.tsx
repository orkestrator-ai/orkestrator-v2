import { useCallback, useState } from "react";
import { Download, Loader2 } from "lucide-react";
import {
  DIAGNOSTICS_MAX_CONTAINER_LOG_ENVIRONMENTS,
  type DiagnosticsBundlePlan,
  type DiagnosticsContainerLogOption,
} from "@orkestrator/protocol/backend-diagnostics";
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

function includedIds(plan: DiagnosticsBundlePlan | null): string[] {
  return (plan?.containerLogs ?? [])
    .filter((option) => option.included)
    .map((option) => option.environmentId)
    .sort();
}

function sameChoice(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((id, index) => id === right[index]);
}

/**
 * The opt-in for container server logs: the user picks environments and the
 * bundle is built again, so the manifest above it always says what this plan
 * holds. Never ticked by default: these are raw provider lines, and each read is
 * a `docker exec` per server.
 */
function ContainerLogChoice({
  options,
  chosen,
  onChange,
  onApply,
  disabled,
  applying,
  changed,
}: {
  options: DiagnosticsContainerLogOption[];
  chosen: readonly string[];
  onChange: (next: string[]) => void;
  onApply: () => void;
  disabled: boolean;
  applying: boolean;
  changed: boolean;
}) {
  const full = chosen.length >= DIAGNOSTICS_MAX_CONTAINER_LOG_ENVIRONMENTS;
  return (
    <section aria-labelledby="diagnostics-container-logs" className="space-y-2">
      <div>
        <p id="diagnostics-container-logs" className="font-medium text-foreground">
          Container server logs (optional)
        </p>
        <p className="text-muted-foreground">
          {`Adds the newest output of each agent server in the environments you choose, up to ${DIAGNOSTICS_MAX_CONTAINER_LOG_ENVIRONMENTS}. These are raw provider lines, the riskiest content a bundle can hold: they go through the same redaction, but read them before sharing. Each one is read from its running container.`}
        </p>
      </div>
      <ul aria-label="Environments with container logs" className="space-y-1">
        {options.map((option) => {
          const checked = chosen.includes(option.environmentId);
          const id = `diagnostics-container-${option.environmentId}`;
          return (
            <li key={option.environmentId} className="flex min-w-0 items-center gap-2">
              <Checkbox
                id={id}
                checked={checked}
                disabled={disabled || (!checked && full)}
                onCheckedChange={(value) =>
                  onChange(
                    value === true
                      ? [...chosen, option.environmentId].sort()
                      : chosen.filter((environmentId) => environmentId !== option.environmentId),
                  )
                }
              />
              <label htmlFor={id} className="min-w-0 flex-1 truncate text-foreground">
                {option.name}
              </label>
              <span className="shrink-0 text-muted-foreground">{option.status}</span>
            </li>
          );
        })}
      </ul>
      {changed && !applying ? (
        <p className="text-muted-foreground" role="status">
          Not in the bundle yet: rebuild it, and the list above will show exactly what it holds.
        </p>
      ) : null}
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={onApply}
        disabled={disabled || !changed}
      >
        {applying ? <Loader2 className="h-4 w-4 mr-1.5 animate-spin" /> : null}
        {applying
          ? "Rebuilding…"
          : chosen.length === 0
            ? "Rebuild without container logs"
            : "Rebuild with these logs"}
      </Button>
    </section>
  );
}

/**
 * Two steps, so what is shown is what is saved: the backend builds the bundle and
 * answers with its manifest, and only then does the user choose to save those
 * bytes. It goes to a download here, and nowhere else.
 */
export function DiagnosticsExportCard() {
  const { machine, name } = useAccountMachine();
  const [plan, setPlanState] = useState<DiagnosticsBundlePlan | null>(null);
  const [chosen, setChosen] = useState<string[]>([]);
  const [isPlanning, setIsPlanning] = useState(false);
  const [isReplanning, setIsReplanning] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<IncompatibilityNotice | null>(null);
  const [savedName, setSavedName] = useState<string | null>(null);

  // The choice always starts from what the plan on screen holds.
  const setPlan = useCallback((next: DiagnosticsBundlePlan | null) => {
    setPlanState(next);
    setChosen(includedIds(next));
  }, []);

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
  }, [machine, name, setPlan]);

  const replan = useCallback(async () => {
    setIsReplanning(true);
    setError(null);
    try {
      setPlan(await backend.planDiagnosticsBundle(machine, { containerLogs: chosen }));
    } catch (planError) {
      setError(
        failureNotice(
          planError,
          "The diagnostics bundle could not be built with those logs.",
          machine,
          name,
          chosen.length > 0
            ? "plan_diagnostics_bundle_with_container_logs"
            : "plan_diagnostics_bundle",
        ),
      );
    } finally {
      setIsReplanning(false);
    }
  }, [chosen, machine, name, setPlan]);

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
  }, [machine, name, plan, setPlan]);

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
          if (!open && !isSaving && !isReplanning) setPlan(null);
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
              {plan.containerLogs && plan.containerLogs.length > 0 ? (
                <ContainerLogChoice
                  options={plan.containerLogs}
                  chosen={chosen}
                  onChange={setChosen}
                  onApply={() => void replan()}
                  disabled={isSaving || isReplanning}
                  applying={isReplanning}
                  changed={!sameChoice(chosen, includedIds(plan))}
                />
              ) : null}
              {error ? <FailureText failure={error} /> : null}
            </div>
          ) : null}
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => setPlan(null)}
              disabled={isSaving || isReplanning}
            >
              Cancel
            </Button>
            <Button type="button" onClick={() => void save()} disabled={isSaving || isReplanning}>
              {isSaving ? "Saving…" : "Save bundle"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
