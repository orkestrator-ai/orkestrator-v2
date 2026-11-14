import type { DatabaseStats } from "@orkestrator/protocol/backend-diagnostics";
import { eventLoopDiagnostics } from "@orkestrator/protocol/event-loop-stall-monitor";
import { boundedConsoleStats } from "../bounded-console.js";
import { compatibilityPathUsage } from "./compatibility-path-usage.js";
import { coordinatorEnvironmentRefusals } from "./coordinator-environment-refusals.js";
import { recurringWorkDiagnostics } from "./recurring-diagnostics.js";

/**
 * Everything in `/__orkestrator/metrics` that is not the gateway's own, also read
 * in-process by the diagnostics bundle. Every field is additive, content-free
 * and cheap: memory only, apart from the database summary's refresh at most once
 * a minute. Compatibility-path totals come from memory, so a poll writes nothing;
 * `get_compatibility_path_usage` is the durable read a path's retirement rests on.
 */
export function backendMetricsSnapshot(database: DatabaseStats | null) {
  return {
    // Additive: bounded, content-free recurring-work counters (kinds only).
    recurringWork: recurringWorkDiagnostics(),
    // Additive: content-free mixed-version compatibility-path usage.
    compatibilityPaths: compatibilityPathUsage.peek().paths,
    // Additive: content-free counts of coordinators refused an environment
    // they did not create, by surface, node and tool (to-do 6080 task 6).
    coordinatorEnvironmentRefusals: coordinatorEnvironmentRefusals.snapshot(),
    // Additive: event-loop stalls and console lines dropped while the log
    // reader was not draining (null outside the backend entrypoint).
    eventLoop: eventLoopDiagnostics(),
    consoleOutput: boundedConsoleStats(),
    // Additive: size, free pages, backups and retention of both databases, from
    // a summary cached for a minute, lease waits per family, and commits and
    // reads per database file (`activity`).
    database,
  };
}
