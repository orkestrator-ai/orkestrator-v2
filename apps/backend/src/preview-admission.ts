/**
 * Per-service and backend-wide admission slots for preview transports.
 *
 * Admission is acquired before connecting upstream and held until the
 * exchange ends, so requests waiting for upstream headers count. Each
 * resource kind has its own instance: an outer desktop tunnel and an HTTP
 * request on the published origin are distinct resources and never consume
 * the same named slot twice.
 */
export interface PreviewSlot {
  release(): void;
}

export class PreviewAdmission {
  private readonly perService = new Map<string, number>();
  private total = 0;
  private rejected = 0;
  private admitted = 0;

  constructor(
    readonly kind: "http" | "upgrade" | "tunnel",
    private readonly limits: { perService: number; perBackend: number },
  ) {}

  tryAcquire(serviceId: string): PreviewSlot | null {
    const current = this.perService.get(serviceId) ?? 0;
    if (current >= this.limits.perService || this.total >= this.limits.perBackend) {
      this.rejected += 1;
      return null;
    }
    this.perService.set(serviceId, current + 1);
    this.total += 1;
    this.admitted += 1;
    let released = false;
    return {
      release: () => {
        if (released) return;
        released = true;
        this.total -= 1;
        const remaining = (this.perService.get(serviceId) ?? 1) - 1;
        if (remaining <= 0) this.perService.delete(serviceId);
        else this.perService.set(serviceId, remaining);
      },
    };
  }

  stats() {
    return {
      kind: this.kind,
      active: this.total,
      services: this.perService.size,
      admitted: this.admitted,
      rejected: this.rejected,
    };
  }
}
