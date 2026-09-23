import { useCallback, useEffect, useState, type FormEvent } from "react";
import { AlertTriangle, Loader2, RefreshCw, ShieldOff } from "lucide-react";
import {
  previewErrorFromUnknown,
  type PreviewCapabilities,
} from "@orkestrator/protocol/preview-services";
import { toast } from "sonner";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Z_FULLSCREEN_DIALOG } from "@/constants/z-index";
import * as backend from "@/lib/backend";
import { ensurePreviewServiceSync, usePreviewServiceStore } from "@/stores/previewServiceStore";

type Publication = backend.PreviewSettingsShape["publication"];

function message(error: unknown): string {
  return (
    previewErrorFromUnknown(error)?.message ??
    (error instanceof Error ? error.message : String(error))
  );
}

function Availability({
  label,
  capability,
}: {
  label: string;
  capability: { available: boolean; reason?: string } | undefined;
}) {
  return (
    <li className="flex items-start gap-2 text-sm">
      <span
        className={
          capability?.available
            ? "mt-1.5 h-2 w-2 shrink-0 rounded-full bg-emerald-500"
            : "mt-1.5 h-2 w-2 shrink-0 rounded-full bg-muted-foreground/50"
        }
      />
      <span>
        <span className="font-medium">{label}</span>
        <span className="block text-xs text-muted-foreground">
          {capability?.available ? "Available" : (capability?.reason ?? "Unavailable")}
        </span>
      </span>
    </li>
  );
}

/**
 * Operator controls for browser previews. Everything here is backend state for
 * the connected backend: new-access issuance (the kill switch), private
 * publication, the optional relay, and a separate action that revokes all
 * active preview access. Environment variables can force these on the backend.
 */
export function PreviewSettings() {
  const [settings, setSettings] = useState<backend.PreviewSettingsResponse | null>(null);
  const [publication, setPublication] = useState<Publication | null>(null);
  const [diagnostics, setDiagnostics] = useState<backend.PreviewDiagnosticsSnapshot | null>(null);
  const [capabilities, setCapabilities] = useState<PreviewCapabilities | null>(null);
  const [unsupported, setUnsupported] = useState(false);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    ensurePreviewServiceSync();
    const loaded = await usePreviewServiceStore.getState().loadCapabilities({ force: true });
    if (!loaded) {
      setUnsupported(usePreviewServiceStore.getState().status === "unsupported");
      return;
    }
    setCapabilities(loaded);
    const [nextSettings, nextDiagnostics] = await Promise.all([
      backend.getPreviewSettings(),
      backend.getPreviewDiagnostics(),
    ]);
    setSettings(nextSettings);
    setPublication(nextSettings.stored.publication);
    setDiagnostics(nextDiagnostics);
  }, []);

  useEffect(() => {
    void load().catch((error: unknown) =>
      toast.error("Could not load preview settings", { description: message(error) }),
    );
  }, [load]);

  const save = async (update: Parameters<typeof backend.updatePreviewSettings>[0]) => {
    setSaving(true);
    try {
      await backend.updatePreviewSettings(update);
      await load();
    } catch (error) {
      toast.error("Could not save preview settings", { description: message(error) });
    } finally {
      setSaving(false);
    }
  };

  if (unsupported) {
    return (
      <p className="text-sm text-muted-foreground">
        The connected backend predates service previews. Browser tabs use backend ports directly.
      </p>
    );
  }
  if (!settings || !publication) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" /> Loading preview settings…
      </div>
    );
  }

  const forced = settings.effective.transport !== settings.stored.transport;
  const text = (field: keyof Publication) => (publication[field] as string | null) ?? "";
  const setText = (field: keyof Publication, value: string) =>
    setPublication({ ...publication, [field]: value.trim() ? value : null });
  const setPort = (field: "port" | "publicPort", value: string) =>
    setPublication({ ...publication, [field]: /^\d{1,5}$/.test(value) ? Number(value) : null });
  const detail = diagnostics?.publication;

  return (
    <div className="max-w-2xl space-y-8">
      <section className="space-y-3">
        <h2 className="text-base font-semibold">Service previews</h2>
        <ul className="space-y-2">
          <Availability label="Desktop tunnel" capability={capabilities?.surfaces.desktopTunnel} />
          <Availability
            label="Private browser origins"
            capability={capabilities?.surfaces.browserTopLevel}
          />
          <Availability
            label="Embedded web and iOS previews"
            capability={capabilities?.surfaces.browserEmbedded}
          />
          <Availability label="Container relay" capability={capabilities?.relay} />
        </ul>
        <label className="flex items-center justify-between gap-4 rounded-md border border-border p-3">
          <span>
            <span className="block text-sm font-medium">Issue new preview access</span>
            <span className="block text-xs text-muted-foreground">
              Service tabs use the authenticated desktop tunnel and isolated per-service sessions.
              Turning this off stops new access immediately; it does not close previews that are
              already open.
              {forced ? " This backend's environment currently overrides the setting." : ""}
            </span>
          </span>
          <Switch
            checked={settings.stored.transport}
            disabled={saving}
            aria-label="Issue new preview access"
            onCheckedChange={(checked) => void save({ transport: checked })}
          />
        </label>
        <label className="flex items-center justify-between gap-4 rounded-md border border-border p-3">
          <span>
            <span className="block text-sm font-medium">Container relay (experimental)</span>
            <span className="block text-xs text-muted-foreground">
              Reach services that are not published or listen only on the container's loopback,
              without recreating the container.
            </span>
          </span>
          <Switch
            checked={settings.stored.relay}
            disabled={saving}
            aria-label="Container relay"
            onCheckedChange={(checked) => void save({ relay: checked })}
          />
        </label>
        <AlertDialog>
          <AlertDialogTrigger asChild>
            <Button type="button" variant="outline" size="sm" className="gap-2">
              <ShieldOff className="h-4 w-4" />
              Revoke all active preview access
            </Button>
          </AlertDialogTrigger>
          <AlertDialogContent
            className={Z_FULLSCREEN_DIALOG}
            overlayClassName={Z_FULLSCREEN_DIALOG}
          >
            <AlertDialogHeader>
              <AlertDialogTitle>Revoke all preview access?</AlertDialogTitle>
              <AlertDialogDescription>
                Open previews and external preview sessions disconnect and must be opened again.
                Applications keep running; their data is not changed.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction
                onClick={() =>
                  void backend
                    .revokePreviewAccess()
                    .then(({ revoked }) =>
                      toast.success(
                        `Revoked ${revoked} preview attachment${revoked === 1 ? "" : "s"}`,
                      ),
                    )
                    .catch((error: unknown) =>
                      toast.error("Could not revoke preview access", {
                        description: message(error),
                      }),
                    )
                }
              >
                Revoke
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </section>

      <form
        className="space-y-3"
        onSubmit={(event: FormEvent) => {
          event.preventDefault();
          void save({ publication });
        }}
      >
        <h2 className="text-base font-semibold">Private preview origins</h2>
        <p className="text-xs text-muted-foreground">
          Lets normal browsers (and the web and iOS clients) open services at{" "}
          <code>https://s-…​.&lt;domain&gt;</code>. You provide wildcard DNS for the domain on your
          private network (for example a Tailscale split-DNS zone) and a certificate covering{" "}
          <code>*.&lt;domain&gt;</code>. The listener only binds to loopback or a Tailscale address;
          it never serves Orkestrator's control API.
        </p>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={publication.enabled}
            onChange={(event) => setPublication({ ...publication, enabled: event.target.checked })}
          />
          Publish private preview origins
        </label>
        <div className="grid gap-3 sm:grid-cols-2">
          {(
            [
              ["domain", "Preview domain", "preview.example.ts.net"],
              ["certFile", "Certificate file (PEM)", "/etc/orkestrator/preview.crt"],
              ["keyFile", "Private key file (PEM)", "/etc/orkestrator/preview.key"],
              ["listenAddress", "Listen address", "127.0.0.1 or 100.x.y.z"],
              [
                "upstreamCaFile",
                "Extra CA for HTTPS services (optional)",
                "/etc/orkestrator/dev-ca.pem",
              ],
            ] as const
          ).map(([field, label, placeholder]) => (
            <div key={field} className="space-y-1.5">
              <Label htmlFor={`preview-${field}`}>{label}</Label>
              <Input
                id={`preview-${field}`}
                value={text(field)}
                placeholder={placeholder}
                onChange={(event) => setText(field, event.target.value)}
              />
            </div>
          ))}
          <div className="space-y-1.5">
            <Label htmlFor="preview-port">Listen port</Label>
            <Input
              id="preview-port"
              inputMode="numeric"
              value={publication.port ?? ""}
              placeholder="8443"
              onChange={(event) => setPort("port", event.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="preview-public-port">Public port (if forwarded)</Label>
            <Input
              id="preview-public-port"
              inputMode="numeric"
              value={publication.publicPort ?? ""}
              placeholder="443"
              onChange={(event) => setPort("publicPort", event.target.value)}
            />
          </div>
        </div>
        {detail && (
          <div
            className={
              detail.available
                ? "rounded-md border border-emerald-500/30 p-2 text-xs"
                : "rounded-md border border-amber-500/30 p-2 text-xs"
            }
          >
            {detail.available ? (
              <span>
                Listening on {detail.listening?.address}:{detail.listening?.port} for *.
                {detail.domain}. Certificate valid to {detail.certificate?.validTo}.
              </span>
            ) : (
              <span className="flex items-start gap-1.5">
                <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                {detail.reason ?? "Publication is unavailable."}
              </span>
            )}
          </div>
        )}
        <div className="flex gap-2">
          <Button type="submit" size="sm" disabled={saving}>
            {saving ? "Saving…" : "Save publication settings"}
          </Button>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="gap-1.5"
            onClick={() => void load()}
          >
            <RefreshCw className="h-3.5 w-3.5" /> Refresh status
          </Button>
        </div>
      </form>

      {diagnostics && (
        <section className="space-y-2">
          <h2 className="text-base font-semibold">Diagnostics</h2>
          <p className="text-xs text-muted-foreground">
            Counts and failure categories only. No addresses, paths, headers, or page content are
            recorded.
          </p>
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 font-mono text-xs">
            <dt>services</dt>
            <dd>
              {String(diagnostics.registry.definitions)} ({String(diagnostics.registry.available)}{" "}
              available, {String(diagnostics.registry.unavailable)} unavailable)
            </dd>
            <dt>attachments</dt>
            <dd>
              {diagnostics.access.attachments} active · {diagnostics.access.resources} connections ·{" "}
              {diagnostics.access.pendingGrants} pending sign-ins
            </dd>
            {Object.entries(diagnostics.metrics.gauges).map(([name, value]) => (
              <div key={name} className="contents">
                <dt>{name}</dt>
                <dd>{value}</dd>
              </div>
            ))}
            {Object.entries(diagnostics.metrics.counters)
              .filter(([, value]) => value > 0)
              .slice(0, 40)
              .map(([name, value]) => (
                <div key={name} className="contents">
                  <dt>{name}</dt>
                  <dd>{value}</dd>
                </div>
              ))}
          </dl>
        </section>
      )}
    </div>
  );
}
