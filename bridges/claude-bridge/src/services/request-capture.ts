/** Explicitly opted-in content storage, separate from application logging. */
import { constants } from "node:fs";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile, readdir, lstat, unlink, chmod, open } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";

const MAX_FILE = 16 * 1024 * 1024;
const MAX_TOTAL = 128 * 1024 * 1024;
const MAX_FILES = 200;
const BODY_NAME = /^[a-zA-Z0-9_-]+\.(request|response)\.json$/;

export class RequestCapture {
  private queue: Promise<unknown> = Promise.resolve();
  constructor(readonly directory: string) {}
  private serialize<T>(fn: () => Promise<T>): Promise<T> {
    const pending = this.queue.then(fn);
    this.queue = pending.catch(() => undefined);
    return pending;
  }
  async enabled(): Promise<boolean> {
    return (await readFile(path.join(this.directory, "enabled"), "utf8").catch(() => "")) === "1";
  }
  async setEnabled(enabled: boolean): Promise<void> {
    await this.serialize(async () => {
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
      await chmod(this.directory, 0o700);
      await writeFile(path.join(this.directory, "enabled"), enabled ? "1" : "0", { mode: 0o600 });
    });
  }
  async environment(env: NodeJS.ProcessEnv): Promise<NodeJS.ProcessEnv> {
    // Do not leak opt-in content to inherited telemetry exporters. File mode
    // writes bodies locally even with event export disabled.
    const snapshot = { ...env };
    delete snapshot.OTEL_LOG_RAW_API_BODIES;
    if (!(await this.enabled())) return snapshot;
    await this.list().catch(() => undefined);
    return {
      ...snapshot,
      OTEL_LOG_RAW_API_BODIES: `file:${this.directory}`,
      OTEL_LOGS_EXPORTER: "none",
      OTEL_TRACES_EXPORTER: "none",
      OTEL_METRICS_EXPORTER: "none",
    };
  }
  async list() {
    return this.serialize(async () => {
      const names = await readdir(this.directory).catch(() => [] as string[]);
      const files = [];
      for (const name of names) {
        if (!BODY_NAME.test(name) && name !== "index.jsonl") continue;
        const info = await lstat(path.join(this.directory, name)).catch(() => null);
        if (!info?.isFile()) continue;
        files.push({ name, bytes: info.size, timestamp: info.mtime.toISOString() });
      }
      files.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
      let bytes = 0;
      let count = 0;
      const retained = [];
      for (const file of files) {
        if (file.bytes > MAX_FILE || count >= MAX_FILES || bytes + file.bytes > MAX_TOTAL) {
          await unlink(path.join(this.directory, file.name)).catch(() => undefined);
          continue;
        }
        bytes += file.bytes;
        count++;
        await chmod(path.join(this.directory, file.name), 0o600).catch(() => undefined);
        if (file.name !== "index.jsonl") retained.push(file);
      }
      return retained;
    });
  }
  async index(): Promise<
    Record<
      string,
      { requestId?: string; messageId?: string; sessionId?: string; pairedFile?: string }
    >
  > {
    const text = await this.detail("index.jsonl").catch(() => "");
    const result: Record<
      string,
      { requestId?: string; messageId?: string; sessionId?: string; pairedFile?: string }
    > = {};
    for (const line of text.split("\n").slice(-MAX_FILES * 2)) {
      try {
        const row = JSON.parse(line);
        for (const [name, paired] of [
          [row.request_file, row.response_file],
          [row.response_file, row.request_file],
        ]) {
          if (typeof name !== "string" || !BODY_NAME.test(name)) continue;
          result[name] = {
            ...(typeof row.request_id === "string"
              ? { requestId: row.request_id.slice(0, 200) }
              : {}),
            ...(typeof row.message_id === "string"
              ? { messageId: row.message_id.slice(0, 200) }
              : {}),
            ...(typeof row.session_id === "string"
              ? { sessionId: row.session_id.slice(0, 200) }
              : {}),
            ...(typeof paired === "string" && BODY_NAME.test(paired) ? { pairedFile: paired } : {}),
          };
        }
      } catch {
        /* A concurrent append can leave an incomplete final line. */
      }
    }
    return result;
  }
  async detail(name: string): Promise<string> {
    if (!BODY_NAME.test(name) && name !== "index.jsonl") throw new Error("Invalid capture file");
    // Refuse symlinks and bound the actual read, including a racing append.
    const filename = path.join(this.directory, name);
    const info = await lstat(filename);
    if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_FILE)
      throw new Error("Capture unavailable or too large");
    const file = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const opened = await file.stat();
      if (!opened.isFile() || opened.nlink !== 1) throw new Error("Invalid capture file");
      const buffer = Buffer.alloc(MAX_FILE + 1);
      const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
      if (bytesRead > MAX_FILE) throw new Error("Capture too large");
      return buffer.toString("utf8", 0, bytesRead);
    } finally {
      await file.close();
    }
  }
}

const workspace = process.env.CWD || process.cwd();
export const requestCapture = new RequestCapture(
  path.join(
    process.env.NODE_ENV === "test"
      ? path.join(tmpdir(), `orkestrator-capture-test-${process.pid}`)
      : process.env.CLAUDE_CONFIG_DIR || path.join(homedir(), ".claude"),
    "orkestrator-request-captures",
    createHash("sha256").update(workspace).digest("hex").slice(0, 24),
  ),
);
// SDK owns the file writes. Sweep independently of mounted tabs and reads.
const sweep = setInterval(() => {
  void requestCapture.list().catch(() => undefined);
}, 5_000);
sweep.unref();
