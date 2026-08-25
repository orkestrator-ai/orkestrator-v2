import { appendFile, mkdir, readdir, rm, stat } from "node:fs/promises";
import { readFileSync } from "node:fs";
import path from "node:path";
import { formatWithOptions } from "node:util";

import { normalizeDebugLogRetentionDays } from "@orkestrator/protocol/debug-logging";

const LOG_FILE_PREFIX = "orkestrator-ai-";
const LOG_CLEANUP_INTERVAL_MS = 6 * 60 * 60 * 1000;
const MAX_PENDING_LOG_BYTES = 4 * 1024 * 1024;
const MAX_LOG_ENTRY_BYTES = 64 * 1024;

export type ApplicationLogSettings = {
  enabled: boolean;
  retentionDays: number;
};

export type InstalledApplicationLogging = {
  logDirectory: string;
  retentionDays: number;
  flush(): Promise<void>;
  stop(): Promise<void>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function readApplicationLogSettings(dataDir: string): ApplicationLogSettings {
  try {
    const parsed = JSON.parse(readFileSync(path.join(dataDir, "config.json"), "utf8")) as unknown;
    const global = isRecord(parsed) && isRecord(parsed.global) ? parsed.global : {};
    return {
      enabled: global.debugLogging === true,
      retentionDays: normalizeDebugLogRetentionDays(global.debugLogRetentionDays),
    };
  } catch {
    return {
      enabled: false,
      retentionDays: normalizeDebugLogRetentionDays(undefined),
    };
  }
}

async function removeExpiredEntries(
  directory: string,
  cutoff: number,
  root = directory,
): Promise<void> {
  const entries = await readdir(directory, { withFileTypes: true }).catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return [];
      throw error;
    },
  );
  for (const entry of entries) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      await removeExpiredEntries(entryPath, cutoff, root);
      if (entryPath !== root) {
        await readdir(entryPath)
          .then((children) => (children.length === 0 ? rm(entryPath, { recursive: false }) : null))
          .catch((error: NodeJS.ErrnoException) => {
            if (error.code !== "ENOENT" && error.code !== "ENOTEMPTY") throw error;
          });
      }
      continue;
    }
    if (!entry.isFile()) continue;
    const metadata = await stat(entryPath).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (metadata && metadata.mtimeMs < cutoff) await rm(entryPath, { force: true });
  }
}

export async function pruneExpiredApplicationLogs(
  logDirectory: string,
  retentionDays: number,
  now = Date.now(),
): Promise<void> {
  const normalizedDays = normalizeDebugLogRetentionDays(retentionDays);
  await removeExpiredEntries(logDirectory, now - normalizedDays * 24 * 60 * 60 * 1000);
}

function dailyLogPath(logDirectory: string, now: Date): string {
  return path.join(logDirectory, `${LOG_FILE_PREFIX}${now.toISOString().slice(0, 10)}.log`);
}

function boundedEntry(value: string): Buffer {
  const encoded = Buffer.from(value);
  if (encoded.byteLength <= MAX_LOG_ENTRY_BYTES) return encoded;
  const suffix = Buffer.from("\n[log entry truncated]\n");
  return Buffer.concat([encoded.subarray(0, MAX_LOG_ENTRY_BYTES - suffix.byteLength), suffix]);
}

export function installProductionApplicationLogging(options: {
  dataDir: string;
  now?: () => Date;
  cleanupIntervalMs?: number;
}): InstalledApplicationLogging | null {
  const settings = readApplicationLogSettings(options.dataDir);
  if (!settings.enabled) return null;

  const logDirectory = path.join(options.dataDir, "logs");
  const now = options.now ?? (() => new Date());
  const originalMethods = {
    debug: console.debug,
    error: console.error,
    info: console.info,
    log: console.log,
    warn: console.warn,
  };
  let pending = Promise.resolve();
  let pendingBytes = 0;
  let stopped = false;

  const reportWriteFailure = (error: unknown) => {
    originalMethods.error.call(console, "[ApplicationLogging] Failed to write log:", error);
  };
  const enqueue = (level: string, args: unknown[]) => {
    if (stopped) return;
    const timestamp = now().toISOString();
    const formatted = formatWithOptions(
      { colors: false, depth: 5, maxArrayLength: 100, maxStringLength: 10_000 },
      ...args,
    );
    const entry = boundedEntry(`${timestamp} ${level.toUpperCase()} ${formatted}\n`);
    if (pendingBytes + entry.byteLength > MAX_PENDING_LOG_BYTES) return;
    pendingBytes += entry.byteLength;
    pending = pending
      .then(async () => {
        await mkdir(logDirectory, { recursive: true, mode: 0o700 });
        await appendFile(dailyLogPath(logDirectory, now()), entry, { mode: 0o600 });
      })
      .catch(reportWriteFailure)
      .finally(() => {
        pendingBytes -= entry.byteLength;
      });
  };

  for (const level of Object.keys(originalMethods) as Array<keyof typeof originalMethods>) {
    console[level] = (...args: unknown[]) => {
      originalMethods[level].apply(console, args);
      enqueue(level, args);
    };
  }

  const prune = () =>
    pruneExpiredApplicationLogs(logDirectory, settings.retentionDays).catch((error) => {
      originalMethods.error.call(console, "[ApplicationLogging] Failed to prune logs:", error);
    });
  void prune();
  const cleanupTimer = setInterval(prune, options.cleanupIntervalMs ?? LOG_CLEANUP_INTERVAL_MS);
  cleanupTimer.unref();
  console.info(
    `[ApplicationLogging] Saving logs to ${logDirectory}; retaining ${settings.retentionDays} day(s).`,
  );

  return {
    logDirectory,
    retentionDays: settings.retentionDays,
    flush: () => pending,
    async stop() {
      if (!stopped) {
        stopped = true;
        clearInterval(cleanupTimer);
        for (const level of Object.keys(originalMethods) as Array<keyof typeof originalMethods>) {
          console[level] = originalMethods[level];
        }
      }
      await pending;
    },
  };
}
