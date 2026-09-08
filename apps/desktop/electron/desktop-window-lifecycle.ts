import { createHash } from "node:crypto";

export class DesktopWindowSlotAllocator {
  private readonly used = new Set<number>();

  constructor(private readonly maximum: number) {
    if (!Number.isInteger(maximum) || maximum <= 0) {
      throw new Error("Maximum desktop windows must be a positive integer.");
    }
  }

  allocate(): number {
    for (let slot = 1; slot <= this.maximum; slot += 1) {
      if (this.used.has(slot)) continue;
      this.used.add(slot);
      return slot;
    }
    throw new Error(`Orkestrator supports up to ${this.maximum} open windows.`);
  }

  release(slot: number): void {
    this.used.delete(slot);
  }
}

export class DesktopWindowRequestGate {
  private ready = false;
  private pending = 0;

  request(): boolean {
    if (this.ready) return true;
    this.pending += 1;
    return false;
  }

  markReady(): number {
    this.ready = true;
    const pending = this.pending;
    this.pending = 0;
    return pending;
  }
}

function connectionPartitionKey(connectionId: string): string {
  return createHash("sha256").update(connectionId).digest("hex").slice(0, 16);
}

export function rendererPartitionForWindow(
  slot: number,
  connectionId: string,
  useLegacyDefaultSession: boolean,
): string | undefined {
  if (useLegacyDefaultSession) return undefined;
  return `persist:orkestrator-renderer-${slot}-${connectionPartitionKey(connectionId)}`;
}

export function browserPreviewPartitionForWindow(slot: number, connectionId: string): string {
  return `persist:orkestrator-browser-previews-${slot}-${connectionPartitionKey(connectionId)}`;
}

type DestroyableWindow = {
  isDestroyed(): boolean;
  destroy(): void;
};

export function cleanupFailedDesktopWindow(options: {
  window: DestroyableWindow | null;
  registered: boolean;
  releaseScope(): void;
  releaseSlot(): void;
}): void {
  if (options.window && !options.window.isDestroyed()) options.window.destroy();
  if (!options.registered) {
    options.releaseScope();
    options.releaseSlot();
  }
}
