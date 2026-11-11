import type { DatabaseStats } from "@orkestrator/protocol/backend-diagnostics";
import { existsSync } from "node:fs";
import { backendMetricsSnapshot } from "./backend-metrics.js";
import type { ChangeTrackingService } from "./change-tracking/index.js";
import { DatabaseSummaryCache } from "./database-summary.js";
import { DiagnosticsBundles } from "./diagnostics-bundle.js";
import { HealthSummary, readHealthRows, type HealthRow } from "./health-summary.js";
import type { StorageDatabase } from "./storage-database.js";
import { storageActivityMetrics } from "./storage-activity-metrics.js";
import { leaseWaitMetrics } from "./storage-lease-metrics.js";
import { slowStorageOperations } from "./storage-slow-operations.js";
import { openBackendDatabase } from "./storage-stores.js";

/**
 * This backend's sources of health and database figures, held in one place so
 * `/metrics`, the commands and the diagnostics bundle read the same ones.
 *
 * It keeps its own connection, as the compatibility-path sink does: nothing here
 * holds a store's lease or goes through `StorageService`, and shutdown can
 * still write the last marker after the services above it have closed.
 */
export class BackendDiagnostics {
  private connection: StorageDatabase | null = null;
  private gatewayMetrics: (() => unknown) | null = null;
  readonly databaseSummary: DatabaseSummaryCache;
  readonly health: HealthSummary;
  readonly bundles = new DiagnosticsBundles();

  constructor(
    private readonly options: {
      dataDir: string;
      changeTracking: () => ChangeTrackingService | undefined | null;
    },
  ) {
    this.databaseSummary = new DatabaseSummaryCache({
      dataDir: options.dataDir,
      main: () => this.database(),
      ledger: () => options.changeTracking()?.ledgerDatabase() ?? null,
      retention: () => options.changeTracking()?.lastRetention() ?? null,
    });
    this.health = new HealthSummary({
      database: () => this.database(),
      databaseSummary: this.databaseSummary,
    });
  }

  private database(): StorageDatabase {
    if (!this.connection || this.connection.isClosed()) {
      // Never recreate a data directory that is gone.
      if (!existsSync(this.options.dataDir)) throw new Error("Data directory is missing");
      this.connection = openBackendDatabase(this.options.dataDir);
    }
    return this.connection;
  }

  /** The gateway's snapshot is richer; it registers once it exists. */
  attachGatewayMetrics(source: () => unknown): void {
    this.gatewayMetrics = source;
  }

  databaseStats(): DatabaseStats {
    return {
      ...this.databaseSummary.read(),
      leaseWaits: leaseWaitMetrics.snapshot(),
      slowOperations: slowStorageOperations.snapshot(),
      activity: storageActivityMetrics.snapshot(),
    };
  }

  /** What `/metrics` answers: without a gateway, everything but its own counters. */
  metricsSnapshot(): unknown {
    return this.gatewayMetrics?.() ?? backendMetricsSnapshot(this.databaseStats());
  }

  healthRows(): HealthRow[] {
    return readHealthRows(this.database());
  }

  /** The last marker, then the connection. Later reads reopen it. */
  close(options: { clean: boolean }): void {
    if (options.clean) this.health.recordCleanExit();
    else this.health.stop();
    this.bundles.dispose();
    this.connection?.close();
    this.connection = null;
  }
}
