import { useEffect, useState, type FormEvent } from "react";
import {
  previewErrorFromUnknown,
  type PreviewScheme,
  type PreviewServiceDefinition,
  type PreviewTargetKind,
} from "@orkestrator/protocol/preview-services";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import * as backend from "@/lib/backend";

export interface PreviewServiceDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  environmentId: string;
  environmentType: "containerized" | "local";
  /** Edit an existing definition (compare-and-set on its revision). */
  existing?: PreviewServiceDefinition | null;
  /** Prefill for "register this port" flows. */
  suggestion?: {
    targetKind?: PreviewTargetKind;
    applicationPort?: number;
    scheme?: PreviewScheme;
    label?: string;
  };
  onSaved: (definition: PreviewServiceDefinition) => void;
}

const TARGETS: Array<{
  value: PreviewTargetKind;
  label: string;
  hint: string;
  environment: "containerized" | "local" | "any";
}> = [
  {
    value: "container",
    label: "Container port",
    hint: "A port inside this environment's container, reached through its published binding.",
    environment: "containerized",
  },
  {
    value: "worktree",
    label: "Worktree server",
    hint: "A server this local environment runs on the backend machine.",
    environment: "local",
  },
  {
    value: "backend-host",
    label: "Backend host port",
    hint: "Any loopback port on the backend machine. You are associating it with this environment; Orkestrator cannot verify who runs it.",
    environment: "any",
  },
];

/**
 * Register or edit a preview service. The backend validates everything again;
 * this form only prevents obvious mistakes. There is deliberately no field for
 * an arbitrary remote host.
 */
export function PreviewServiceDialog({
  open,
  onOpenChange,
  environmentId,
  environmentType,
  existing,
  suggestion,
  onSaved,
}: PreviewServiceDialogProps) {
  const defaultTarget: PreviewTargetKind =
    existing?.targetKind ??
    suggestion?.targetKind ??
    (environmentType === "containerized" ? "container" : "worktree");
  const [label, setLabel] = useState("");
  const [targetKind, setTargetKind] = useState<PreviewTargetKind>(defaultTarget);
  const [port, setPort] = useState("");
  const [scheme, setScheme] = useState<PreviewScheme>("http");
  const [tlsServerName, setTlsServerName] = useState("");
  const [readinessPath, setReadinessPath] = useState("");
  const [entry, setEntry] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // The form resets when the dialog opens. Re-running on every identity change
  // of `existing`/`suggestion` (rebuilt by the parent each render) would wipe
  // the user's edits mid-typing.
  /* oxlint-disable react-hooks/exhaustive-deps */
  useEffect(() => {
    if (!open) return;
    setLabel(existing?.label ?? suggestion?.label ?? "");
    setTargetKind(defaultTarget);
    setPort(String(existing?.applicationPort ?? suggestion?.applicationPort ?? ""));
    setScheme(existing?.scheme ?? suggestion?.scheme ?? "http");
    setTlsServerName(existing?.tlsServerName ?? "");
    setReadinessPath(existing?.readinessPath ?? "");
    setEntry(existing?.entry ?? false);
    setError(null);
  }, [open]);
  /* oxlint-enable react-hooks/exhaustive-deps */

  const portValue = /^[1-9]\d{0,4}$/.test(port) && Number(port) <= 65_535 ? Number(port) : null;
  const canSave = label.trim().length > 0 && portValue !== null && !saving;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!canSave || portValue === null) return;
    setSaving(true);
    setError(null);
    const input = {
      environmentId,
      label: label.trim(),
      targetKind,
      applicationPort: portValue,
      scheme,
      ...(scheme === "https" && tlsServerName.trim()
        ? { tlsServerName: tlsServerName.trim() }
        : {}),
      readinessPath: readinessPath.trim(),
      entry,
    };
    try {
      const result = existing
        ? await backend.updatePreviewService(existing.serviceId, existing.definitionRevision, input)
        : await backend.registerPreviewService(input);
      if (result.kind === "definition") {
        onSaved(result.definition);
        onOpenChange(false);
      }
    } catch (saveError) {
      const preview = previewErrorFromUnknown(saveError);
      setError(
        preview?.message ?? (saveError instanceof Error ? saveError.message : String(saveError)),
      );
    } finally {
      setSaving(false);
    }
  };

  const targets = TARGETS.filter(
    (target) => target.environment === "any" || target.environment === environmentType,
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <form onSubmit={submit} className="space-y-4">
          <DialogHeader>
            <DialogTitle>
              {existing ? "Edit preview service" : "Register preview service"}
            </DialogTitle>
            <DialogDescription>
              Browser tabs keep this service's identity, so they follow it when its published port
              changes.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-1.5">
            <Label htmlFor="preview-service-label">Label</Label>
            <Input
              id="preview-service-label"
              value={label}
              maxLength={120}
              onChange={(event) => setLabel(event.target.value)}
              placeholder="web"
            />
          </div>
          <fieldset className="space-y-1.5">
            <legend className="text-sm font-medium">Target</legend>
            {targets.map((target) => (
              <label
                key={target.value}
                className="flex cursor-pointer items-start gap-2 rounded-md border border-border p-2 text-sm has-[:checked]:border-primary/60"
              >
                <input
                  type="radio"
                  name="preview-service-target"
                  className="mt-1"
                  checked={targetKind === target.value}
                  onChange={() => setTargetKind(target.value)}
                />
                <span>
                  <span className="font-medium">{target.label}</span>
                  <span className="block text-xs text-muted-foreground">{target.hint}</span>
                </span>
              </label>
            ))}
          </fieldset>
          <div className="grid grid-cols-[1fr_auto] gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="preview-service-port">
                {targetKind === "container" ? "Container port" : "Port"}
              </Label>
              <Input
                id="preview-service-port"
                inputMode="numeric"
                value={port}
                onChange={(event) => setPort(event.target.value.trim())}
                aria-invalid={port !== "" && portValue === null}
                placeholder="3000"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="preview-service-scheme">Scheme</Label>
              <select
                id="preview-service-scheme"
                className="h-9 rounded-md border border-border bg-input-surface px-2 text-sm"
                value={scheme}
                onChange={(event) => setScheme(event.target.value as PreviewScheme)}
              >
                <option value="http">http</option>
                <option value="https">https</option>
              </select>
            </div>
          </div>
          {scheme === "https" && (
            <div className="space-y-1.5">
              <Label htmlFor="preview-service-tls">Certificate name</Label>
              <Input
                id="preview-service-tls"
                value={tlsServerName}
                onChange={(event) => setTlsServerName(event.target.value)}
                placeholder="localhost"
              />
              <p className="text-xs text-muted-foreground">
                The certificate is always verified. HTTPS services open through the private preview
                origin, not the desktop tunnel.
              </p>
            </div>
          )}
          <div className="space-y-1.5">
            <Label htmlFor="preview-service-readiness">Readiness path (optional)</Label>
            <Input
              id="preview-service-readiness"
              value={readinessPath}
              onChange={(event) => setReadinessPath(event.target.value)}
              placeholder="/health"
            />
            <p className="text-xs text-muted-foreground">
              Probed with HEAD (GET if unsupported). Without it, only the TCP port is checked.
            </p>
          </div>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={entry}
              onChange={(event) => setEntry(event.target.checked)}
            />
            Open this service from the environment's browser button
          </label>
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={!canSave}>
              {saving ? "Saving…" : existing ? "Save" : "Register"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
