import { useEffect, useMemo, useState } from "react";
import { ArrowUpCircle } from "lucide-react";
import type { ConnectionSummary } from "@orkestrator/protocol/connections";
import type { GatewayStatusPayload } from "@orkestrator/protocol/updates";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { BUNDLED_APP_VERSION } from "@/lib/app-version";
import {
  connectionUpdateTransport,
  remoteConnectionStatus,
} from "@/lib/updates/remote-update-client";
import { UpdateDetails } from "./UpdateDetails";
import { channelLabel, PHASE_LABELS } from "./update-text";
import { useUpdateTarget } from "./useUpdateTarget";

const HOST_LABELS: Record<string, string> = {
  desktop: "desktop app",
  supervisor: "supervised backend",
  none: "backend without an installer",
};

function RemoteUpdateDialog({
  connection,
  open,
  onOpenChange,
}: {
  connection: ConnectionSummary;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const transport = useMemo(() => connectionUpdateTransport(connection.id), [connection.id]);
  const target = useUpdateTarget(transport, { watch: open });
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="max-h-[85vh] overflow-y-auto sm:max-w-lg"
        data-testid="remote-update-dialog"
      >
        <DialogHeader>
          <DialogTitle>Update {connection.name}</DialogTitle>
          <DialogDescription>
            You approve this machine&apos;s changes on its behalf. The update and your approval are
            recorded in its audit log.
          </DialogDescription>
        </DialogHeader>
        <UpdateDetails
          target={target}
          scope="remote"
          machineName={connection.name}
          clientVersion={BUNDLED_APP_VERSION}
        />
      </DialogContent>
    </Dialog>
  );
}

/**
 * One saved remote's version, channel and update state, from its `/status`
 * handshake, with the single **Update remote** action for both a desktop app
 * and a headless backend.
 */
export function RemoteUpdateSummary({ connection }: { connection: ConnectionSummary }) {
  const [status, setStatus] = useState<GatewayStatusPayload | null | undefined>(undefined);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void remoteConnectionStatus(connection.id).then((payload) => {
      if (!cancelled) setStatus(payload);
    });
    return () => {
      cancelled = true;
    };
  }, [connection.id, open]);

  if (status === undefined) return null;
  if (status === null || !status.appVersion) {
    return (
      <p className="mt-1 text-[11px] text-zinc-600" data-testid="remote-update-summary">
        {status === null
          ? "Version unknown (unreachable)"
          : "Version unknown: this backend predates in-app updates; update it by hand."}
      </p>
    );
  }
  const host = status.host;
  const updates = status.updates;
  return (
    <div
      className="mt-1 flex flex-wrap items-center gap-2 text-[11px] text-zinc-500"
      data-testid="remote-update-summary"
    >
      <span>
        <span className="font-mono text-zinc-300">{status.appVersion}</span>
        {updates ? ` · ${channelLabel(updates.channel)}` : ""}
        {host ? ` · ${HOST_LABELS[host.kind] ?? host.kind}` : ""}
      </span>
      {updates?.jobPhase ? (
        <span className="rounded-full border border-cyan-500/25 bg-cyan-500/10 px-2 py-0.5 text-cyan-300">
          {PHASE_LABELS[updates.jobPhase]}
        </span>
      ) : updates?.available ? (
        <span className="rounded-full border border-cyan-500/25 bg-cyan-500/10 px-2 py-0.5 text-cyan-300">
          {updates.available} available
        </span>
      ) : null}
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="h-6 gap-1 px-2 text-[11px] text-zinc-400 hover:text-zinc-100"
        onClick={() => setOpen(true)}
        aria-label={`Updates for ${connection.name}`}
      >
        <ArrowUpCircle className="h-3 w-3" />
        {updates?.available && host?.canInstall ? "Update remote" : "Updates"}
      </Button>
      {open ? (
        <RemoteUpdateDialog connection={connection} open={open} onOpenChange={setOpen} />
      ) : null}
    </div>
  );
}
