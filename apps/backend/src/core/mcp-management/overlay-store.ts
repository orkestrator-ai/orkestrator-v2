/**
 * Durable storage for environment overlays: one private JSON record per
 * environment and container source.
 *
 * Records live under the `mcp-environment-overlays` environment state root
 * (`environment-state-paths.ts`), keyed by environment id — never by
 * container or runtime generation, so a preserving rebuild, a stop and start
 * or a backend restart all find the same record. Environment deletion and the
 * orphan reconciler remove that root with the rest of the environment's
 * state. Nothing else reads it: it is not part of a container, a rebuild
 * recovery copy or any export, and entries can carry literal credentials, so
 * files are owner-only and written atomically.
 */

import { constants as fsConstants } from "node:fs";
import * as fs from "node:fs/promises";
import path from "node:path";

import { isAgentPlatform } from "@orkestrator/protocol/agent-platforms";
import { MCP_MANAGEMENT_LIMITS, mcpFailure } from "@orkestrator/protocol/mcp-management";

import { environmentStateDirectory } from "../environment-state-paths.js";
import { OVERLAY_SCHEMA_VERSION, type OverlayChange, type OverlayRecord } from "./overlay.js";

export type OverlayRead =
  | { state: "absent" }
  | { state: "ok"; record: OverlayRecord }
  /** Present but unreadable: writes are refused rather than starting over. */
  | { state: "corrupt" };

const RECORD_SUFFIX = ".json";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isEntryMap(value: unknown): value is Record<string, Record<string, unknown>> {
  return isRecord(value) && Object.values(value).every(isRecord);
}

function isChange(value: unknown): value is OverlayChange {
  if (!isRecord(value)) return false;
  if (value.kind === "set")
    return isRecord(value.entry) && (value.base === null || typeof value.base === "string");
  return value.kind === "remove" && typeof value.base === "string";
}

const nullableString = (value: unknown) => value === null || typeof value === "string";

/** Structural check of a stored record; anything else is `corrupt`. */
export function parseOverlayRecord(value: unknown): OverlayRecord | null {
  if (!isRecord(value) || value.schemaVersion !== OVERLAY_SCHEMA_VERSION) return null;
  if (
    typeof value.environmentId !== "string" ||
    !isAgentPlatform(value.provider) ||
    typeof value.sourceId !== "string" ||
    typeof value.revision !== "number" ||
    !Number.isSafeInteger(value.revision) ||
    !isRecord(value.changes) ||
    !Object.values(value.changes).every(isChange) ||
    !isRecord(value.conflicts) ||
    !Object.values(value.conflicts).every((reason) => typeof reason === "string") ||
    !isEntryMap(value.baseline) ||
    typeof value.baselineFingerprint !== "string" ||
    !nullableString(value.materialisedFingerprint) ||
    !nullableString(value.materialisedBootId) ||
    !nullableString(value.materialisedAt) ||
    typeof value.updatedAt !== "string"
  )
    return null;
  return value as unknown as OverlayRecord;
}

export class McpOverlayStore {
  constructor(private readonly dataDir: string) {}

  directory(environmentId: string): string {
    return environmentStateDirectory(this.dataDir, "mcp-environment-overlays", environmentId);
  }

  /** The record's path; also the lock identity for every write to that source. */
  recordPath(environmentId: string, sourceId: string): string {
    return path.join(
      this.directory(environmentId),
      `${Buffer.from(sourceId, "utf8").toString("base64url")}${RECORD_SUFFIX}`,
    );
  }

  async read(environmentId: string, sourceId: string): Promise<OverlayRead> {
    const file = this.recordPath(environmentId, sourceId);
    let handle: fs.FileHandle;
    try {
      handle = await fs.open(file, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "ENOENT"
        ? { state: "absent" }
        : { state: "corrupt" };
    }
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size > MCP_MANAGEMENT_LIMITS.overlayRecordMaxBytes)
        return { state: "corrupt" };
      const record = parseOverlayRecord(JSON.parse((await handle.readFile()).toString("utf8")));
      if (!record || record.environmentId !== environmentId || record.sourceId !== sourceId)
        return { state: "corrupt" };
      return { state: "ok", record };
    } catch {
      return { state: "corrupt" };
    } finally {
      await handle.close();
    }
  }

  /** Whether the environment has any overlay record, without reading one. */
  async hasAny(environmentId: string): Promise<boolean> {
    const names = await fs.readdir(this.directory(environmentId)).catch(() => [] as string[]);
    return names.some((name) => name.endsWith(RECORD_SUFFIX));
  }

  /** Source ids with a record, from the record names alone. */
  async sourceIds(environmentId: string): Promise<string[]> {
    const names = await fs.readdir(this.directory(environmentId)).catch(() => [] as string[]);
    return names
      .filter((name) => name.endsWith(RECORD_SUFFIX))
      .map((name) =>
        Buffer.from(name.slice(0, -RECORD_SUFFIX.length), "base64url").toString("utf8"),
      );
  }

  async write(record: OverlayRecord): Promise<void> {
    const text = `${JSON.stringify(record)}\n`;
    if (Buffer.byteLength(text, "utf8") > MCP_MANAGEMENT_LIMITS.overlayRecordMaxBytes) {
      throw mcpFailure("oversized-source", {
        message:
          "This environment's MCP changes for this file would be too large to keep; nothing was changed.",
      });
    }
    const directory = this.directory(record.environmentId);
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    const info = await fs.lstat(directory);
    if (!info.isDirectory() || info.isSymbolicLink())
      throw mcpFailure("internal", { message: "The overlay directory is not a directory." });
    const file = this.recordPath(record.environmentId, record.sourceId);
    const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
    const handle = await fs.open(
      temporary,
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW,
      0o600,
    );
    try {
      await handle.writeFile(text, "utf8");
      await handle.sync();
    } catch (error) {
      await handle.close().catch(() => undefined);
      await fs.rm(temporary, { force: true });
      throw error;
    }
    await handle.close();
    try {
      await fs.rename(temporary, file);
    } catch (error) {
      await fs.rm(temporary, { force: true });
      throw error;
    }
    const dir = await fs.open(directory, fsConstants.O_RDONLY).catch(() => null);
    if (dir)
      await dir
        .sync()
        .catch(() => undefined)
        .finally(() => dir.close());
  }

  async remove(environmentId: string, sourceId: string): Promise<void> {
    await fs.rm(this.recordPath(environmentId, sourceId), { force: true });
  }
}
