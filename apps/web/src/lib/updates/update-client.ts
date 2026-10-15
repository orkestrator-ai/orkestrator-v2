/**
 * The renderer side of the update protocol. A transport names which backend
 * the commands go to:
 *
 * - `localUpdateTransport` is this app's own update. In the desktop app it is
 *   always the local backend, through Electron IPC, even when the window is
 *   bound to a remote; in a browser it is the backend that served the page.
 * - Remote connections get their own transport (see `remote-update-client.ts`).
 */
import {
  LOCAL_UPDATE_RESYNC_EVENT,
  LOCAL_UPDATE_STATUS_EVENT,
  UPDATE_STATUS_EVENT,
  type UpdateAuditEntry,
  type UpdateClientCommand,
  type UpdateClientInfo,
  type UpdateOffer,
  type UpdateStatusSnapshot,
} from "@orkestrator/protocol/updates";
import type { ReleaseChannel } from "@orkestrator/protocol/release-channels";
import { BUNDLED_APP_VERSION } from "@/lib/app-version";
import { invoke } from "@/lib/native/backend";
import { NATIVE_EVENT_STREAM_CONNECTED_EVENT, listen } from "@/lib/native/events";
import { versionClientKind } from "@/lib/version-reminder";

export type UpdateStatusEvent = { revision: number; snapshot: UpdateStatusSnapshot };

export type UpdateTransport = {
  /** Stable key for stores keyed by target ("local" or a connection id). */
  readonly key: string;
  invoke<T>(command: UpdateClientCommand, args?: Record<string, unknown>): Promise<T>;
  /**
   * Live snapshots plus a signal that events may have been missed (a stream
   * reconnect), on which the caller re-reads the authoritative status.
   */
  subscribe(
    onStatus: (event: UpdateStatusEvent) => void,
    onResync: () => void,
  ): Promise<() => void>;
};

/** How this client describes itself in the remote machine's audit log. */
export function updateClientInfo(): UpdateClientInfo {
  return {
    kind: versionClientKind() === "desktop" ? "desktop" : "web",
    version: BUNDLED_APP_VERSION,
    name: null,
  };
}

export function localUpdateTransport(): UpdateTransport {
  const desktop = typeof window !== "undefined" ? window.orkestrator?.updates : undefined;
  return {
    key: "local",
    invoke: (command, args = {}) =>
      desktop ? desktop.invoke(command, args) : invoke(command, args),
    async subscribe(onStatus, onResync) {
      const stops = await Promise.all([
        listen<UpdateStatusEvent>(
          desktop ? LOCAL_UPDATE_STATUS_EVENT : UPDATE_STATUS_EVENT,
          (event) => onStatus(event.payload),
        ),
        listen(NATIVE_EVENT_STREAM_CONNECTED_EVENT, () => onResync()),
        // In the desktop app the local backend's stream is main's, not the
        // window's, which may be bound to a remote.
        ...(desktop ? [listen(LOCAL_UPDATE_RESYNC_EVENT, () => onResync())] : []),
      ]);
      return () => {
        for (const stop of stops) stop();
      };
    },
  };
}

/** `UpdateError:<code>: <message>` from the backend, or a transport failure. */
export function parseUpdateError(error: unknown): { code: string; message: string } {
  const text = error instanceof Error ? error.message : String(error);
  const match = /UpdateError:([a-z-]+):\s*(.*)$/s.exec(text);
  if (match) return { code: match[1]!, message: match[2]! };
  if (/Unknown backend command: update_/.test(text)) {
    return {
      code: "unsupported",
      message: "This backend predates in-app updates; update it by hand.",
    };
  }
  return { code: "unexpected", message: text };
}

export function updatesApi(transport: UpdateTransport) {
  return {
    status: () => transport.invoke<UpdateStatusSnapshot>("update_get_status"),
    check: () => transport.invoke<UpdateStatusSnapshot>("update_check"),
    setChannel: (channel: ReleaseChannel) =>
      transport.invoke<UpdateStatusSnapshot>("update_set_channel", {
        channel,
        client: updateClientInfo(),
      }),
    start: (
      offer: UpdateOffer,
      approvedConsentIds: string[],
      restartPolicy: "immediate" | "manual",
    ) =>
      transport.invoke<UpdateStatusSnapshot>("update_start", {
        targetVersion: offer.version,
        requirementsSha256: offer.requirementsSha256,
        approvedConsentIds,
        restartPolicy,
        ...(offer.downgrade ? { allowDowngrade: true } : {}),
        client: updateClientInfo(),
      }),
    installNow: (jobId: string) =>
      transport.invoke<UpdateStatusSnapshot>("update_install_now", {
        jobId,
        client: updateClientInfo(),
      }),
    installOnQuit: (jobId: string) =>
      transport.invoke<UpdateStatusSnapshot>("update_install_on_quit", {
        jobId,
        client: updateClientInfo(),
      }),
    cancel: (jobId: string) =>
      transport.invoke<UpdateStatusSnapshot>("update_cancel", {
        jobId,
        client: updateClientInfo(),
      }),
    acknowledge: (noticeId: string) =>
      transport.invoke<UpdateStatusSnapshot>("update_acknowledge_notice", { noticeId }),
    audit: (limit = 20) => transport.invoke<UpdateAuditEntry[]>("update_get_audit", { limit }),
  };
}

export type UpdatesApi = ReturnType<typeof updatesApi>;
