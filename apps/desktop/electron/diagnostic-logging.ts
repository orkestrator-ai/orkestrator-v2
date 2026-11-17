import { createLogger } from "@orkestrator/protocol/logger";
import type {
  EventLoopStallMonitorOptions,
  EventLoopSuspensionReport,
} from "@orkestrator/protocol/event-loop-stall-monitor";
import type { ArtifactHostDiagnostics } from "./artifact-host-session.js";

const desktopLog = createLogger("desktop");
const artifactHostLog = createLogger("artifact-host");

export function reportMainThreadStall(
  {
    lagMs,
    endedAt,
    intervalMs,
    folded,
    level,
    cpuMs,
    hostSuspendedMs,
  }: Parameters<NonNullable<EventLoopStallMonitorOptions["report"]>>[0],
  describeStall: (lagMs: number) => string,
): void {
  desktopLog[level]("main-thread.stalled", {
    lagMs,
    endedAt,
    intervalMs,
    cpuMs,
    hostSuspendedMs,
    openDialog: describeStall(lagMs).replace(/^; /, "") || undefined,
    folded: folded.replace(/^; /, "") || undefined,
  });
}

/** A main-thread timer late because the machine slept: not a stall, so `info`. */
export function reportMainThreadSuspension({
  suspendedMs,
  lagMs,
  endedAt,
  intervalMs,
  suppressed,
}: EventLoopSuspensionReport): void {
  desktopLog.info("main-thread.host-suspended", {
    suspendedMs,
    lagMs,
    endedAt,
    intervalMs,
    suppressed: suppressed || undefined,
  });
}

/** Counts by content-free reason, each as its own scalar field. */
export function artifactHostDiagnosticFields(
  diagnostics: ArtifactHostDiagnostics,
): Record<string, number> {
  return Object.fromEntries(
    (["blocked", "rejected"] as const).flatMap((kind) =>
      Object.entries(diagnostics[kind]).map(([reason, count]) => [`${kind}.${reason}`, count]),
    ),
  );
}

export function reportArtifactHostDiagnostics(diagnostics: ArtifactHostDiagnostics): void {
  artifactHostLog.info("host.ended", artifactHostDiagnosticFields(diagnostics));
}
