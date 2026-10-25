import { randomUUID } from "node:crypto";

import { NODE_FILE_CHUNK_BYTES, type NodeFileScope } from "./node-files.js";

/**
 * The command node's file-transfer framework: copies files between nodes
 * (including this one), in bounded chunks, verified by size and SHA-256 at
 * the destination, which writes atomically and never shows a partial file.
 *
 * Content travels backend to backend only. It is never put in a log, a
 * receipt, an event or a model's context; a receipt records which files
 * moved, their sizes and hashes, who asked, and how it ended.
 */

export const MAX_TRANSFER_FILES = 1_000;
export const MAX_TRANSFER_BYTES = 256 * 1024 * 1024;
const MAX_RECEIPTS = 200;

export interface TransferEndpoint {
  nodeId: string;
  scope: NodeFileScope;
}

export interface TransferReceipt {
  transferId: string;
  from: TransferEndpoint;
  to: TransferEndpoint;
  files: Array<{ path: string; destination: string; bytes: number; sha256: string }>;
  /** Files left alone because the destination already had them (`skipExisting`). */
  skipped?: string[];
  bytes: number;
  actor: string;
  startedAt: string;
  finishedAt?: string;
  status: "running" | "completed" | "failed";
  error?: { code: string; message: string };
}

/** A destination refusing to replace a file (locally the code; through a node link, the text). */
function isExistsError(error: unknown): boolean {
  return (
    (error as { code?: unknown } | null)?.code === "exists" ||
    (error instanceof Error && error.message.endsWith("already exists there."))
  );
}

/** Runs one file command on a node (this one locally, others through the node link). */
export type NodeFileInvoker = (
  nodeId: string,
) => <T>(command: string, args: Record<string, unknown>) => Promise<T>;

export class NodeFileTransfer {
  private receipts: TransferReceipt[] = [];
  private loaded = false;

  constructor(
    private readonly options: {
      invokerFor: NodeFileInvoker;
      load?(): Promise<unknown>;
      save?(receipts: TransferReceipt[]): Promise<void>;
      now?: () => number;
    },
  ) {}

  private iso(): string {
    return new Date((this.options.now ?? Date.now)()).toISOString();
  }

  private async ensureLoaded(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    const raw = await this.options.load?.().catch(() => null);
    if (Array.isArray(raw)) this.receipts = (raw as TransferReceipt[]).slice(-MAX_RECEIPTS);
  }

  async list(): Promise<TransferReceipt[]> {
    await this.ensureLoaded();
    return structuredClone(this.receipts);
  }

  /**
   * Copy files. `files` are paths in the source scope; each lands at the
   * same relative path under `to` (or under `toDirectory`). Stops at the
   * first failure; files already copied stay copied and are listed.
   */
  async transfer(input: {
    from: TransferEndpoint;
    to: TransferEndpoint;
    files: string[];
    toDirectory?: string;
    overwrite: boolean;
    /** With `overwrite` off: leave a file the destination already has and go on. */
    skipExisting?: boolean;
    actor: string;
    /** Called after each file is copied or skipped, for progress. */
    onFile?: (file: { path: string; bytes: number; skipped: boolean }) => void;
  }): Promise<TransferReceipt> {
    await this.ensureLoaded();
    if (input.files.length === 0) throw new Error("Name at least one file to transfer.");
    if (input.files.length > MAX_TRANSFER_FILES)
      throw new Error("At most 1,000 files per transfer.");
    const receipt: TransferReceipt = {
      transferId: randomUUID(),
      from: structuredClone(input.from),
      to: structuredClone(input.to),
      files: [],
      bytes: 0,
      actor: input.actor.slice(0, 200),
      startedAt: this.iso(),
      status: "running",
    };
    const source = this.options.invokerFor(input.from.nodeId);
    const destination = this.options.invokerFor(input.to.nodeId);
    try {
      for (const path of input.files) {
        const target = input.toDirectory
          ? `${input.toDirectory.replace(/\/+$/, "")}/${path}`
          : path;
        const stat = await source<{ exists: boolean; size?: number; sha256?: string }>(
          "stat_node_file",
          {
            scope: input.from.scope,
            path,
          },
        );
        if (!stat.exists || stat.size === undefined || !stat.sha256) {
          throw Object.assign(new Error(`${path} does not exist at the source.`), {
            code: "not-found",
          });
        }
        if (receipt.bytes + stat.size > MAX_TRANSFER_BYTES) {
          throw Object.assign(new Error("A transfer is at most 256 MiB."), { code: "too-large" });
        }
        let uploadId: string;
        try {
          ({ uploadId } = await destination<{ uploadId: string }>("begin_node_file_write", {
            scope: input.to.scope,
            path: target,
            size: stat.size,
            sha256: stat.sha256,
            overwrite: input.overwrite,
          }));
        } catch (error) {
          if (!input.overwrite && input.skipExisting && isExistsError(error)) {
            (receipt.skipped ??= []).push(path);
            input.onFile?.({ path, bytes: stat.size, skipped: true });
            continue;
          }
          throw error;
        }
        try {
          let offset = 0;
          while (offset < stat.size) {
            const chunk = await source<{ contentBase64: string; eof: boolean }>("read_node_file", {
              scope: input.from.scope,
              path,
              offset,
              length: NODE_FILE_CHUNK_BYTES,
            });
            const bytes = Buffer.byteLength(chunk.contentBase64, "base64");
            if (bytes === 0) break;
            await destination("append_node_file_write", {
              uploadId,
              contentBase64: chunk.contentBase64,
            });
            offset += bytes;
          }
          const committed = await destination<{ bytes: number; sha256: string }>(
            "commit_node_file_write",
            {
              uploadId,
            },
          );
          receipt.files.push({
            path,
            destination: target,
            bytes: committed.bytes,
            sha256: committed.sha256,
          });
          receipt.bytes += committed.bytes;
          input.onFile?.({ path, bytes: committed.bytes, skipped: false });
        } catch (error) {
          await destination("abort_node_file_write", { uploadId }).catch(() => undefined);
          throw error;
        }
      }
      receipt.status = "completed";
    } catch (error) {
      receipt.status = "failed";
      receipt.error = {
        code:
          typeof (error as { code?: unknown }).code === "string"
            ? (error as { code: string }).code
            : "failed",
        // Messages here name paths and limits only; never file content.
        message: (error instanceof Error ? error.message : String(error)).slice(0, 300),
      };
    }
    receipt.finishedAt = this.iso();
    this.receipts = [...this.receipts, receipt].slice(-MAX_RECEIPTS);
    await this.options.save?.(this.receipts).catch(() => undefined);
    return structuredClone(receipt);
  }
}
