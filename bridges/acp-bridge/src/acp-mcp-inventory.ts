/**
 * What this bridge can honestly say about Grok's MCP servers.
 *
 * Grok loads MCP servers from its own configuration (`$GROK_HOME/config.toml`,
 * the workspace's `.grok/config.toml`, and compatibility imports) when a child
 * process starts, and announces the resulting list in a vendor
 * `*\/mcp/servers_updated` notification. That notification carries names and
 * launch settings, not health, and it is not correlated to one session: every
 * child of this bridge writes the same shared inventory. So:
 *
 * - a listed server is `unknown` unless the entry itself states a status;
 * - the inventory is labelled process-level, never exact per-session truth;
 * - the configuration a child loaded is fingerprinted when it spawns, so a
 *   status read can say whether the saved files changed since then.
 *
 * Pure apart from the file reads, and independent of `acp-context.ts`, so it
 * can be tested without a bridge.
 */
import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { NativeAgentMcpServer } from "@orkestrator/protocol/native-agent";

type JsonObject = Record<string, unknown>;

/** Most servers retained from one vendor listing. */
export const MAX_VENDOR_MCP_SERVERS = 64;

const VENDOR_STATUSES = new Set<NativeAgentMcpServer["status"]>([
  "connected",
  "connecting",
  "failed",
  "needs-auth",
  "disabled",
]);

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * A status the vendor entry itself asserts, or `unknown`. Being listed is
 * evidence that Grok read the server's configuration, not that it connected.
 */
function vendorStatus(candidate: JsonObject): NativeAgentMcpServer["status"] {
  for (const key of ["status", "state"]) {
    const value = candidate[key];
    if (typeof value !== "string") continue;
    const normalized = value.trim().toLowerCase();
    if (VENDOR_STATUSES.has(normalized as NativeAgentMcpServer["status"])) {
      return normalized as NativeAgentMcpServer["status"];
    }
  }
  return "unknown";
}

/** Transport inferred from the launch shape. Never copies the command or URL. */
function vendorTransport(candidate: JsonObject): NativeAgentMcpServer["transport"] | undefined {
  const type = typeof candidate.type === "string" ? candidate.type.trim().toLowerCase() : "";
  if (type === "stdio" || type === "http" || type === "sse") return type;
  if (typeof candidate.command === "string") return "stdio";
  if (typeof candidate.url === "string") return "http";
  return undefined;
}

/**
 * Normalize a vendor `servers_updated` listing, or undefined when the params
 * are not one. Names are bounded; launch arguments, env and headers — which
 * can hold credentials — are never copied.
 */
export function vendorMcpInventory(params: JsonObject): NativeAgentMcpServer[] | undefined {
  if (!Array.isArray(params.mcpServers)) return undefined;
  return params.mcpServers.slice(0, MAX_VENDOR_MCP_SERVERS).flatMap((candidate, index) => {
    if (!isObject(candidate)) return [];
    const name =
      typeof candidate.name === "string" && candidate.name.trim()
        ? candidate.name.trim().slice(0, 128)
        : `server-${index + 1}`;
    const transport = vendorTransport(candidate);
    return [
      {
        id: name,
        name,
        status: vendorStatus(candidate),
        ...(name === "orkestrator" ? { scope: "orkestrator" as const } : {}),
        ...(transport ? { transport } : {}),
        actions: [],
      },
    ];
  });
}

/** The native Grok configuration files a child reads at startup. */
export function grokMcpConfigFiles(
  options: { env?: NodeJS.ProcessEnv; cwd: string; home?: string } = { cwd: process.cwd() },
): { user: string; project: string } {
  const env = options.env ?? process.env;
  const home = options.home ?? homedir();
  const configured = env.GROK_HOME?.trim();
  const grokHome = configured
    ? resolve(configured === "~" ? home : configured.replace(/^~(?=\/)/, home))
    : join(home, ".grok");
  return {
    user: join(grokHome, "config.toml"),
    project: join(options.cwd, ".grok", "config.toml"),
  };
}

async function fileDigest(file: string): Promise<string> {
  try {
    return `sha256:${createHash("sha256")
      .update(await readFile(file))
      .digest("base64url")}`;
  } catch {
    return "absent";
  }
}

/**
 * sha256 of the native Grok configuration files, one digest per file.
 *
 * Compatibility imports (`~/.claude.json`, `.mcp.json`, `.cursor/mcp.json`)
 * are deliberately excluded: `~/.claude.json` is rewritten with project
 * history on every Claude session, so including it would report a change
 * almost constantly and teach the reader to ignore the signal.
 */
export async function grokMcpConfigFingerprint(files: {
  user: string;
  project: string;
}): Promise<GrokMcpConfigFingerprint> {
  const [user, project] = await Promise.all([fileDigest(files.user), fileDigest(files.project)]);
  return {
    fingerprint: createHash("sha256")
      .update(`user=${user}\u0000project=${project}`)
      .digest("base64url"),
    sources: { user, project },
  };
}

export interface GrokMcpConfigFingerprint {
  fingerprint: string;
  sources: { user: string; project: string };
}

/** Public, content-free description of the process-level MCP inventory. */
export interface GrokMcpConfigStatus {
  /**
   * Always `process`: the inventory comes from whichever Grok child reported
   * last and is shared by every session on this bridge.
   */
  inventoryScope: "process";
  /** What the reporting child loaded; absent until a child reports. */
  loaded?: GrokMcpConfigFingerprint & { observedAt: string };
  /** The saved files now. */
  current?: GrokMcpConfigFingerprint;
  /**
   * True when the saved files differ from what the reporting child loaded:
   * Grok applies MCP configuration at process start, so this means a restart
   * is still required. Absent when either side is unknown.
   */
  changedSinceLoad?: boolean;
}

/**
 * Cache of the current fingerprint, validated by each file's identity and
 * mtime. `/runtime-health` is swept by the backend for every session, so a
 * read must cost at most two stats when nothing changed.
 */
export class GrokMcpConfigWatcher {
  #key: string | undefined;
  #value: GrokMcpConfigFingerprint | undefined;
  #pending: { key: string; value: Promise<GrokMcpConfigFingerprint> } | undefined;

  constructor(
    private readonly files: () => { user: string; project: string },
    private readonly fingerprint: typeof grokMcpConfigFingerprint = grokMcpConfigFingerprint,
  ) {}

  async current(): Promise<GrokMcpConfigFingerprint> {
    const files = this.files();
    const key = await statKey(files);
    if (this.#value && this.#key === key) return this.#value;
    // Concurrent misses share one read.
    if (this.#pending?.key !== key) {
      const pending = { key, value: this.fingerprint(files) };
      this.#pending = pending;
    }
    const pending = this.#pending;
    try {
      const value = await pending.value;
      if (this.#pending === pending && (await statKey(files)) === key) {
        this.#key = key;
        this.#value = value;
      }
      return value;
    } finally {
      if (this.#pending === pending) this.#pending = undefined;
    }
  }
}

async function statKey(files: { user: string; project: string }): Promise<string> {
  const parts = await Promise.all(
    [files.user, files.project].map(async (file) => {
      try {
        const info = await stat(file);
        return `${file}:${info.dev}:${info.ino}:${info.size}:${info.mtimeMs}`;
      } catch {
        return `${file}:absent`;
      }
    }),
  );
  return parts.join("|");
}

export function grokMcpConfigStatus(
  loaded: (GrokMcpConfigFingerprint & { observedAt: string }) | undefined,
  current: GrokMcpConfigFingerprint | undefined,
): GrokMcpConfigStatus {
  return {
    inventoryScope: "process",
    ...(loaded ? { loaded: structuredClone(loaded) } : {}),
    ...(current ? { current: structuredClone(current) } : {}),
    ...(loaded && current ? { changedSinceLoad: loaded.fingerprint !== current.fingerprint } : {}),
  };
}
