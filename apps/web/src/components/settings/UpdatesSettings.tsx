import { useEffect, useMemo, useState } from "react";
import type { ReleaseChannel } from "@orkestrator/protocol/release-channels";
import type { UpdateAuditEntry } from "@orkestrator/protocol/updates";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { UpdateDetails } from "@/components/updates/UpdateDetails";
import { CHANNEL_OPTIONS } from "@/components/updates/update-text";
import { useUpdateTarget } from "@/components/updates/useUpdateTarget";
import { localUpdateTransport } from "@/lib/updates/update-client";

const AUDIT_LABELS: Record<UpdateAuditEntry["action"], string> = {
  "set-channel": "Channel changed",
  start: "Update approved",
  install: "Install started",
  cancel: "Cancel requested",
  succeeded: "Updated",
  failed: "Update failed",
  "rolled-back": "Rolled back",
  cancelled: "Cancelled",
};

function requesterLabel(entry: UpdateAuditEntry): string {
  const requester = entry.requester;
  if (!requester) return "";
  if (requester.tailscaleUser) return ` by ${requester.tailscaleUser}`;
  if (requester.listener === "browser") {
    return ` from ${requester.client?.name ?? requester.remoteAddress ?? "a remote client"}`;
  }
  return "";
}

/**
 * This installation's release channel and updates. The section always talks
 * to this app's own backend: in the desktop app that is the local backend even
 * when the window is bound to a remote, whose updates live under Connections.
 */
export function UpdatesSettings() {
  const transport = useMemo(() => localUpdateTransport(), []);
  const target = useUpdateTarget(transport);
  const [audit, setAudit] = useState<UpdateAuditEntry[] | null>(null);
  const desktop = typeof window !== "undefined" && Boolean(window.orkestrator?.updates);
  const channel = target.snapshot?.channel;
  const revision = target.snapshot?.revision;

  useEffect(() => {
    let cancelled = false;
    void target.api
      .audit(20)
      .then((entries) => {
        if (!cancelled) setAudit(entries);
      })
      .catch(() => {
        if (!cancelled) setAudit([]);
      });
    return () => {
      cancelled = true;
    };
  }, [target.api, revision]);

  return (
    <div className="space-y-8" data-testid="updates-settings">
      <section className="space-y-3">
        <div>
          <h3 className="text-sm font-medium text-foreground">Release channel</h3>
          <p className="text-xs text-muted-foreground">
            Moving to a more conservative channel never downgrades: this machine waits until that
            channel passes the version it runs.
          </p>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="update-channel">Channel</Label>
          <Select
            value={channel}
            disabled={!channel || target.busy}
            onValueChange={(value) =>
              void target.run((api) => api.setChannel(value as ReleaseChannel))
            }
          >
            <SelectTrigger id="update-channel" className="w-64" aria-label="Release channel">
              <SelectValue placeholder="Loading…" />
            </SelectTrigger>
            <SelectContent>
              {CHANNEL_OPTIONS.map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p className="text-xs text-muted-foreground">
            {CHANNEL_OPTIONS.find((option) => option.value === channel)?.description}
          </p>
        </div>
      </section>

      <section className="space-y-3">
        <h3 className="text-sm font-medium text-foreground">This installation</h3>
        <UpdateDetails target={target} scope="local" canInstallOnQuit={desktop} />
      </section>

      <section className="space-y-2">
        <h3 className="text-sm font-medium text-foreground">Recent update activity</h3>
        {audit === null ? null : audit.length === 0 ? (
          <p className="text-xs text-muted-foreground">Nothing yet.</p>
        ) : (
          <ul className="space-y-1 text-xs text-muted-foreground" data-testid="update-audit">
            {audit.map((entry, index) => (
              <li key={`${entry.at}-${index}`}>
                <span className="text-foreground">
                  {AUDIT_LABELS[entry.action] ?? entry.action}
                </span>
                {entry.toVersion ? ` ${entry.fromVersion ?? "?"} → ${entry.toVersion}` : ""}
                {entry.action === "set-channel" && entry.channel ? ` to ${entry.channel}` : ""}
                {requesterLabel(entry)} · {new Date(entry.at).toLocaleString()}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
