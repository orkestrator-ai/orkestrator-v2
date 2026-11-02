import type { Duplex } from "node:stream";

import type { AuthenticatedPreviewAccess } from "./core/preview-access.js";
import type { ResolvedPreviewTarget } from "./core/preview-service-registry.js";

export interface PreviewUpstreamPoolLimits {
  /** Idle connections kept per access (one browser session for one service). */
  perAccess: number;
  /** Idle connections kept across every access. */
  total: number;
  /**
   * How long a connection may sit idle. Below the 5 s keep-alive timeout of
   * Node's HTTP server (which Vite uses), so the application rarely closes a
   * connection the pool is about to hand out.
   */
  idleMs: number;
}

export const DEFAULT_PREVIEW_UPSTREAM_POOL_LIMITS: PreviewUpstreamPoolLimits = {
  perAccess: 8,
  total: 64,
  idleMs: 2_000,
};

/** The access service's resource tracking, which closes resources on revocation. */
export interface PreviewUpstreamPoolAccess {
  track(access: AuthenticatedPreviewAccess, resource: { close(): void }): () => void;
}

interface Idle {
  socket: Duplex;
  timer: ReturnType<typeof setTimeout>;
  detach: () => void;
}

interface Group {
  serviceId: string;
  generation: number;
  targetKey: string;
  idle: Idle[];
  /** Releases the group's registration with the access service. */
  untrack: () => void;
}

/** Everything that decides where a connection goes; a change means a new pool. */
export function previewTargetKey(target: ResolvedPreviewTarget): string {
  return JSON.stringify([
    target.transportKind,
    target.host,
    target.port,
    target.addressFamily,
    target.containerId,
    target.bindingKey,
    target.tls?.servername ?? null,
    target.relay ? [target.relay.environmentId, target.relay.containerId, target.relay.port] : null,
  ]);
}

/**
 * Idle upstream connections for the private-origin proxy, kept per access
 * (attachment) and endpoint generation so a connection is only ever reused by
 * the browser session, generation and target it was opened for.
 *
 * Each access's pool is registered with the access service, so revoking or
 * expiring the access, or moving the service to a new endpoint generation
 * (which revokes the old generation's access), closes its idle connections at
 * once. `dropService` covers registry revocations directly as well. Every
 * request still re-checks access and target before it takes a connection.
 */
export class PreviewUpstreamPool {
  private readonly groups = new Map<string, Group>();
  private size = 0;
  private disposed = false;
  private readonly counters = { pooled: 0, reused: 0, dropped: 0 };

  constructor(
    private readonly access: PreviewUpstreamPoolAccess,
    private readonly limits: PreviewUpstreamPoolLimits = DEFAULT_PREVIEW_UPSTREAM_POOL_LIMITS,
  ) {}

  stats() {
    return { idle: this.size, accesses: this.groups.size, ...this.counters };
  }

  /** An idle connection for this access, generation and target, or null. */
  take(access: AuthenticatedPreviewAccess, target: ResolvedPreviewTarget): Duplex | null {
    const group = this.groups.get(access.attachmentId);
    if (!group) return null;
    if (
      group.serviceId !== access.serviceId ||
      group.generation !== access.generation ||
      group.targetKey !== previewTargetKey(target)
    ) {
      this.dropGroup(access.attachmentId);
      return null;
    }
    while (group.idle.length) {
      // Most recently returned first: the least likely to have been closed.
      const entry = group.idle.pop()!;
      this.size -= 1;
      clearTimeout(entry.timer);
      entry.detach();
      if (usable(entry.socket)) {
        if (!group.idle.length) this.forget(access.attachmentId, group);
        this.counters.reused += 1;
        // Returned paused: the HTTP client resumes it once its readers are attached.
        return entry.socket;
      }
      entry.socket.destroy();
    }
    this.forget(access.attachmentId, group);
    return null;
  }

  /** Keep a cleanly finished connection for reuse, or close it when full. */
  put(access: AuthenticatedPreviewAccess, target: ResolvedPreviewTarget, socket: Duplex): void {
    if (this.disposed || !usable(socket) || this.size >= this.limits.total) {
      socket.destroy();
      return;
    }
    const targetKey = previewTargetKey(target);
    let group = this.groups.get(access.attachmentId);
    if (
      group &&
      (group.serviceId !== access.serviceId ||
        group.generation !== access.generation ||
        group.targetKey !== targetKey)
    ) {
      this.dropGroup(access.attachmentId);
      group = undefined;
    }
    if (!group) {
      let untrack: () => void;
      try {
        // Throws once the access is no longer usable: nothing to keep then.
        untrack = this.access.track(access, {
          close: () => this.dropGroup(access.attachmentId),
        });
      } catch {
        socket.destroy();
        return;
      }
      group = {
        serviceId: access.serviceId,
        generation: access.generation,
        targetKey,
        idle: [],
        untrack,
      };
      this.groups.set(access.attachmentId, group);
    }
    if (group.idle.length >= this.limits.perAccess) {
      socket.destroy();
      return;
    }
    const owner = group;
    const remove = () => {
      const index = owner.idle.indexOf(entry);
      if (index < 0) return;
      owner.idle.splice(index, 1);
      this.size -= 1;
      clearTimeout(entry.timer);
      entry.detach();
      socket.destroy();
      if (!owner.idle.length) this.forget(access.attachmentId, owner);
    };
    // An idle connection must not send anything; data or EOF means the
    // application closed it or broke framing, so it is never handed out.
    const onData = () => remove();
    socket.on("data", onData);
    socket.once("end", remove);
    socket.once("close", remove);
    const entry: Idle = {
      socket,
      timer: setTimeout(remove, this.limits.idleMs),
      detach: () => {
        socket.off("data", onData);
        socket.off("end", remove);
        socket.off("close", remove);
        socket.pause();
      },
    };
    entry.timer.unref?.();
    owner.idle.push(entry);
    this.size += 1;
    this.counters.pooled += 1;
    // Flowing, so a close from the application is noticed while idle.
    socket.resume();
  }

  /** Close every idle connection for a service (registry revocation). */
  dropService(serviceId: string): void {
    for (const [attachmentId, group] of Array.from(this.groups)) {
      if (group.serviceId === serviceId) this.dropGroup(attachmentId);
    }
  }

  dispose(): void {
    this.disposed = true;
    for (const attachmentId of Array.from(this.groups.keys())) this.dropGroup(attachmentId);
  }

  private dropGroup(attachmentId: string): void {
    const group = this.groups.get(attachmentId);
    if (!group) return;
    this.forget(attachmentId, group);
    for (const entry of group.idle.splice(0)) {
      this.size -= 1;
      this.counters.dropped += 1;
      clearTimeout(entry.timer);
      entry.detach();
      entry.socket.destroy();
    }
  }

  private forget(attachmentId: string, group: Group): void {
    if (this.groups.get(attachmentId) !== group) return;
    this.groups.delete(attachmentId);
    group.untrack();
  }
}

function usable(socket: Duplex): boolean {
  return !socket.destroyed && socket.readable && socket.writable;
}
