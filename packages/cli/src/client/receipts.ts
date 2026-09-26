import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import {
  isPublicNamespace,
  isPublicRequestId,
  type PublicActionName,
  type PublicReceipt,
} from "@orkestrator/protocol/public-api";
import { writePrivateFile } from "./config.js";

/**
 * Private client-side receipts. One is written *before* a mutation is sent,
 * so a lost response or a killed CLI never loses the request key needed to
 * query the backend. A local receipt records intent, not acceptance: it is
 * proof of nothing, is never resubmitted automatically, and never contains a
 * prompt, patch, or credential — only IDs and a digest of the intent.
 */

export const MAX_LOCAL_RECEIPTS_PER_INSTALLATION = 1_000;
const MAX_RECEIPT_BYTES = 8 * 1024;

export interface LocalReceipt {
  version: 1;
  installationId: string;
  connection: string;
  action: PublicActionName;
  requestId: string;
  namespace: string;
  /** SHA-256 of the canonical intent the client sent. */
  intentDigest: string;
  createdAt: string;
  updatedAt: string;
  operationId?: string;
  state?: PublicReceipt["state"];
  resources?: PublicReceipt["resources"];
}

function receiptKey(action: string, requestId: string): string {
  return createHash("sha256").update(action).update("\0").update(requestId).digest("hex");
}

function safeSegment(value: string): string {
  return /^[A-Za-z0-9._-]{1,200}$/.test(value)
    ? value
    : createHash("sha256").update(value).digest("hex");
}

export class LocalReceiptStore {
  constructor(private readonly root: string) {}

  private directory(installationId: string): string {
    return path.join(this.root, safeSegment(installationId));
  }

  private file(installationId: string, action: string, requestId: string): string {
    return path.join(this.directory(installationId), `${receiptKey(action, requestId)}.json`);
  }

  async find(
    installationId: string,
    action: string,
    requestId: string,
  ): Promise<LocalReceipt | null> {
    return this.readFile(this.file(installationId, action, requestId));
  }

  async save(receipt: LocalReceipt): Promise<void> {
    const text = `${JSON.stringify(receipt)}\n`;
    if (Buffer.byteLength(text) > MAX_RECEIPT_BYTES) return;
    await writePrivateFile(
      this.file(receipt.installationId, receipt.action, receipt.requestId),
      text,
    );
    await this.prune(receipt.installationId);
  }

  async update(receipt: LocalReceipt, remote: PublicReceipt): Promise<void> {
    await this.save({
      ...receipt,
      namespace: remote.namespace,
      operationId: remote.operationId,
      state: remote.state,
      resources: remote.resources,
      updatedAt: new Date().toISOString(),
    });
  }

  async list(installationId?: string, limit = 50): Promise<LocalReceipt[]> {
    const directories = installationId
      ? [this.directory(installationId)]
      : (await fs.readdir(this.root).catch(() => [])).map((name) => path.join(this.root, name));
    const receipts: LocalReceipt[] = [];
    for (const directory of directories) {
      const names = await fs.readdir(directory).catch(() => [] as string[]);
      for (const name of names) {
        if (!name.endsWith(".json")) continue;
        const receipt = await this.readFile(path.join(directory, name));
        if (receipt) receipts.push(receipt);
      }
    }
    receipts.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    return receipts.slice(0, limit);
  }

  private async readFile(file: string): Promise<LocalReceipt | null> {
    try {
      const stat = await fs.lstat(file);
      if (!stat.isFile() || stat.size > MAX_RECEIPT_BYTES) return null;
      const value = JSON.parse(await fs.readFile(file, "utf8")) as Partial<LocalReceipt>;
      if (
        value.version !== 1 ||
        typeof value.installationId !== "string" ||
        typeof value.action !== "string" ||
        !isPublicRequestId(value.requestId) ||
        !isPublicNamespace(value.namespace) ||
        typeof value.intentDigest !== "string" ||
        typeof value.createdAt !== "string" ||
        typeof value.updatedAt !== "string"
      ) {
        return null;
      }
      return value as LocalReceipt;
    } catch {
      return null;
    }
  }

  /** Keep the newest receipts per installation; older ones are only a cache. */
  private async prune(installationId: string): Promise<void> {
    const directory = this.directory(installationId);
    const names = (await fs.readdir(directory).catch(() => [] as string[])).filter((name) =>
      name.endsWith(".json"),
    );
    if (names.length <= MAX_LOCAL_RECEIPTS_PER_INSTALLATION) return;
    const entries = await Promise.all(
      names.map(async (name) => {
        const file = path.join(directory, name);
        const stat = await fs.stat(file).catch(() => null);
        return { file, mtime: stat?.mtimeMs ?? 0 };
      }),
    );
    entries.sort((a, b) => a.mtime - b.mtime);
    for (const entry of entries.slice(0, entries.length - MAX_LOCAL_RECEIPTS_PER_INSTALLATION)) {
      await fs.rm(entry.file, { force: true }).catch(() => undefined);
    }
  }
}
