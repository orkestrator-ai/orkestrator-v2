/**
 * Bounded discovery of prompt-template files.
 *
 * Two compatibility roots, in precedence order: the project's
 * `<cwd>/.codex/prompts` and the user's `$CODEX_HOME/prompts`. Neither is a
 * Codex runtime feature; Orkestrator expands these files itself.
 *
 * Every dimension of the scan is bounded (see {@link TEMPLATE_LIMITS}), and
 * the catalogue keeps metadata only: a fingerprint of each file, never its
 * body. The body is loaded again at invocation and must still match the
 * fingerprint that was listed, so an edit between listing and dispatch is a
 * visible stale selection rather than a silent change of meaning.
 *
 * Nothing here logs a template body or an absolute path.
 */
import { createHash } from "node:crypto";
import { open, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import {
  commandBindingRevision,
  utf8ByteLength,
} from "@orkestrator/protocol/agent-command-catalogue";
import { getCodexHomeDir } from "../history/rollout.js";
import {
  extractFrontmatter,
  SHELL_TEMPLATE_MESSAGE,
  templateMetadata,
  templateRequiresShell,
} from "./template-format.js";

export const TEMPLATE_LIMITS = Object.freeze({
  maxTemplates: 512,
  maxVisitedEntries: 2_048,
  maxDepth: 8,
  maxTemplateBytes: 256 * 1024,
  maxScanBytes: 8 * 1024 * 1024,
  maxExpandedBytes: 1024 * 1024,
  readConcurrency: 8,
});
export type TemplateLimits = typeof TEMPLATE_LIMITS;

export type TemplateOrigin = "project" | "user";

/**
 * Names the bridge reserves for its own built-ins and Orkestrator's session
 * actions. A template may not occupy one: dispatch always handles these
 * first, so advertising the template would promise something that never runs.
 */
export const RESERVED_TEMPLATE_NAMES: ReadonlySet<string> = new Set([
  "/help",
  "/models",
  "/steer",
  "/compact",
]);
/** Namespaces used for skill aliases and reserved-template display names. */
const RESERVED_TEMPLATE_PREFIXES = ["/skill:", "/prompts:"];

export const TEMPLATE_ID_PREFIX = "codex-template:";

export type TemplateProblemReason = "requires-shell-execution" | "reserved-name" | "unsupported";

export interface TemplateEntry {
  /** Natural command name derived from the relative path, e.g. `/nested/review`. */
  name: string;
  /**
   * Name the catalogue shows. Equal to {@link name} except for a reserved
   * collision, which is listed under `/prompts:<name>` so it neither collides
   * with the built-in nor hides an Orkestrator session action.
   */
  displayName: string;
  origin: TemplateOrigin;
  /** POSIX path relative to the root, including the `.md` suffix. */
  relativePath: string;
  /** Private: never serialized. */
  absolutePath: string;
  id: string;
  bindingRevision: string;
  description?: string;
  argumentHint?: string;
  /** SHA-256 prefix of the bytes that were listed; null when never read. */
  fingerprint: string | null;
  problem?: { reason: TemplateProblemReason; message: string };
}

export interface TemplateScan {
  /** One entry per case-folded name, project before user. */
  effective: TemplateEntry[];
  /** Lower-precedence entries with the same name. Private; never listed. */
  shadowed: TemplateEntry[];
  /** A limit stopped discovery, or entries were skipped. */
  truncated: boolean;
  /** Entries skipped for depth, symlinks, oversize or unusable names. */
  skipped: number;
}

export function templateRoots(
  cwd: string,
  codexHome: string = getCodexHomeDir(),
): Array<{ origin: TemplateOrigin; dir: string }> {
  return [
    { origin: "project", dir: join(cwd, ".codex", "prompts") },
    { origin: "user", dir: join(codexHome, "prompts") },
  ];
}

export function templateCommandId(origin: TemplateOrigin, relativePath: string): string {
  return `${TEMPLATE_ID_PREFIX}${commandBindingRevision([origin, relativePath])}`;
}

export function templateBindingRevision(origin: TemplateOrigin, relativePath: string): string {
  return commandBindingRevision(["template", origin, relativePath]);
}

function fingerprintOf(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex").slice(0, 32);
}

function nameFromRelativePath(relativePath: string): string {
  return `/${relativePath.replace(/\.md$/i, "")}`;
}

function usableName(name: string): boolean {
  return name.length > 1 && !/\s/.test(name) && utf8ByteLength(`/prompts:${name}`) <= 255;
}

function isReservedName(name: string): boolean {
  const folded = name.toLowerCase();
  return (
    RESERVED_TEMPLATE_NAMES.has(folded) ||
    RESERVED_TEMPLATE_PREFIXES.some((prefix) => folded.startsWith(prefix))
  );
}

interface Candidate {
  origin: TemplateOrigin;
  relativePath: string;
  absolutePath: string;
  size: number;
  statKey: string;
}

interface CachedMetadata {
  statKey: string;
  fingerprint: string;
  description?: string;
  argumentHint?: string;
  problem?: TemplateEntry["problem"];
}

/**
 * Metadata keyed by path and validated by device, inode, size and mtime, so a
 * catalogue poll re-reads only files that changed. Bounded; cleared wholesale
 * when full rather than tracking recency.
 */
const metadataCache = new Map<string, CachedMetadata>();
const METADATA_CACHE_MAX = 1_024;

export function clearTemplateMetadataCacheForTesting(): void {
  metadataCache.clear();
}

async function readBounded(
  absolutePath: string,
  maxBytes: number,
): Promise<{ bytes: Uint8Array; oversized: boolean }> {
  // One handle for the stat and the read: an atomic replacement between them
  // cannot pair one file's size with another file's bytes.
  const handle = await open(absolutePath, "r");
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw new Error("not a regular file");
    if (info.size > maxBytes) return { bytes: new Uint8Array(), oversized: true };
    const buffer = Buffer.alloc(Math.min(info.size, maxBytes) + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    if (offset > maxBytes) return { bytes: new Uint8Array(), oversized: true };
    return { bytes: buffer.subarray(0, offset), oversized: false };
  } finally {
    await handle.close();
  }
}

function describe(
  bytes: Uint8Array,
  candidate: Pick<Candidate, "relativePath">,
): Omit<CachedMetadata, "statKey" | "fingerprint"> {
  const content = new TextDecoder("utf-8").decode(bytes);
  const parsed = extractFrontmatter(content);
  const base = candidate.relativePath.replace(/\.md$/i, "").split("/").at(-1) ?? "template";
  if (parsed.error) {
    return {
      description: `Run ${base} prompt`,
      problem: { reason: "unsupported", message: parsed.error },
    };
  }
  const metadata = templateMetadata(parsed, base);
  return {
    ...metadata,
    ...(templateRequiresShell(parsed.body)
      ? {
          problem: { reason: "requires-shell-execution" as const, message: SHELL_TEMPLATE_MESSAGE },
        }
      : {}),
  };
}

async function mapConcurrent<T, R>(
  items: readonly T[],
  limit: number,
  work: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = Array.from<R>({ length: items.length });
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await work(items[index]!);
    }
  });
  await Promise.all(workers);
  return results;
}

/**
 * Walk the roots, precedence first, and return bounded metadata.
 *
 * Deterministic: directory entries are visited in name order and the budgets
 * are charged from `stat` sizes before any concurrent read, so the same tree
 * always produces the same list and the same truncation point.
 */
export async function scanPromptTemplates(
  roots: ReadonlyArray<{ origin: TemplateOrigin; dir: string }>,
  limits: TemplateLimits = TEMPLATE_LIMITS,
): Promise<TemplateScan> {
  let visited = 0;
  let skipped = 0;
  let truncated = false;
  let scanBytes = 0;
  const candidates: Candidate[] = [];
  /** A global budget ran out: stop walking every root, not just this one. */
  let halted = false;
  const halt = () => {
    halted = true;
    truncated = true;
  };

  async function walk(
    origin: TemplateOrigin,
    dir: string,
    relative: string,
    depth: number,
  ): Promise<void> {
    let entries: Array<{
      name: string;
      isDirectory(): boolean;
      isFile(): boolean;
      isSymbolicLink(): boolean;
    }>;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
    for (const entry of entries) {
      if (halted) return;
      if (visited >= limits.maxVisitedEntries) {
        halt();
        return;
      }
      visited += 1;
      const absolutePath = join(dir, entry.name);
      const relativePath = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (depth + 1 > limits.maxDepth) {
          skipped += 1;
          truncated = true;
          continue;
        }
        await walk(origin, absolutePath, relativePath, depth + 1);
        continue;
      }
      if (!entry.name.toLowerCase().endsWith(".md")) continue;
      if (!entry.isFile() && !entry.isSymbolicLink()) continue;
      let info;
      try {
        // Follows a file symlink; a symlink to a directory is never walked.
        info = await stat(absolutePath);
      } catch {
        skipped += 1;
        continue;
      }
      if (!info.isFile()) {
        skipped += 1;
        continue;
      }
      if (!usableName(nameFromRelativePath(relativePath))) {
        skipped += 1;
        truncated = true;
        continue;
      }
      if (candidates.length >= limits.maxTemplates) {
        halt();
        return;
      }
      const charged = Math.min(info.size, limits.maxTemplateBytes);
      if (scanBytes + charged > limits.maxScanBytes) {
        halt();
        return;
      }
      scanBytes += charged;
      candidates.push({
        origin,
        relativePath,
        absolutePath,
        size: info.size,
        statKey: `${info.dev}:${info.ino}:${info.size}:${info.mtimeMs}`,
      });
    }
  }

  for (const root of roots) {
    if (halted) break;
    await walk(root.origin, root.dir, "", 0);
  }

  const described = await mapConcurrent(candidates, limits.readConcurrency, async (candidate) => {
    const cached = metadataCache.get(candidate.absolutePath);
    if (cached && cached.statKey === candidate.statKey) return cached;
    if (candidate.size > limits.maxTemplateBytes) return null;
    try {
      const { bytes, oversized } = await readBounded(
        candidate.absolutePath,
        limits.maxTemplateBytes,
      );
      if (oversized) return null;
      // An empty file has nothing to run; it was never listed before either.
      if (bytes.length === 0) return undefined;
      const metadata: CachedMetadata = {
        statKey: candidate.statKey,
        fingerprint: fingerprintOf(bytes),
        ...describe(bytes, candidate),
      };
      if (metadataCache.size >= METADATA_CACHE_MAX) metadataCache.clear();
      metadataCache.set(candidate.absolutePath, metadata);
      return metadata;
    } catch {
      return undefined;
    }
  });

  const effective = new Map<string, TemplateEntry>();
  const shadowed: TemplateEntry[] = [];
  candidates.forEach((candidate, index) => {
    const metadata = described[index];
    if (metadata === undefined) {
      // Empty, or vanished/unreadable between the walk and the read.
      skipped += 1;
      return;
    }
    const name = nameFromRelativePath(candidate.relativePath);
    const reserved = isReservedName(name);
    const tooLarge = metadata === null;
    if (tooLarge) truncated = true;
    const entry: TemplateEntry = {
      name,
      displayName: reserved ? `/prompts:${name.slice(1)}` : name,
      origin: candidate.origin,
      relativePath: candidate.relativePath,
      absolutePath: candidate.absolutePath,
      id: templateCommandId(candidate.origin, candidate.relativePath),
      bindingRevision: templateBindingRevision(candidate.origin, candidate.relativePath),
      fingerprint: tooLarge ? null : metadata.fingerprint,
      ...(tooLarge
        ? {
            description: `Run ${name.slice(1)} prompt`,
            problem: {
              reason: "unsupported" as const,
              message: `This prompt file is larger than ${Math.floor(limits.maxTemplateBytes / 1024)} KiB.`,
            },
          }
        : {
            ...(metadata.description ? { description: metadata.description } : {}),
            ...(metadata.argumentHint ? { argumentHint: metadata.argumentHint } : {}),
            ...(metadata.problem ? { problem: metadata.problem } : {}),
          }),
    };
    if (reserved) {
      // Reserved wins over every other problem: the name is the thing to fix.
      entry.problem = {
        reason: "reserved-name",
        message: `${name} is reserved by Orkestrator, so this ${candidate.origin} prompt cannot run under that name. Rename the prompt file to use it.`,
      };
    }
    const key = name.toLowerCase();
    if (effective.has(key)) shadowed.push(entry);
    else effective.set(key, entry);
  });

  return { effective: [...effective.values()], shadowed, truncated, skipped };
}

export type TemplateBodyLoad = { ok: true; body: string } | { ok: false; message: string };

/**
 * Load the body of a listed template, refusing if it is not the file that was
 * listed. Invocation is the only place a full body is held.
 */
export async function loadTemplateBody(
  entry: TemplateEntry,
  limits: TemplateLimits = TEMPLATE_LIMITS,
): Promise<TemplateBodyLoad> {
  if (entry.problem) return { ok: false, message: entry.problem.message };
  if (!entry.fingerprint) {
    return {
      ok: false,
      message: `${entry.name} could not be read. Choose it again from the menu.`,
    };
  }
  let loaded;
  try {
    loaded = await readBounded(entry.absolutePath, limits.maxTemplateBytes);
  } catch {
    return {
      ok: false,
      message: `${entry.name} no longer exists. Choose a command again from the menu.`,
    };
  }
  if (loaded.oversized) {
    return {
      ok: false,
      message: `${entry.name} is now larger than ${Math.floor(limits.maxTemplateBytes / 1024)} KiB.`,
    };
  }
  if (fingerprintOf(loaded.bytes) !== entry.fingerprint) {
    return {
      ok: false,
      message: `${entry.name} changed after it was listed. Choose it again from the menu.`,
    };
  }
  const parsed = extractFrontmatter(new TextDecoder("utf-8").decode(loaded.bytes));
  if (parsed.error) return { ok: false, message: parsed.error };
  if (templateRequiresShell(parsed.body)) return { ok: false, message: SHELL_TEMPLATE_MESSAGE };
  return { ok: true, body: parsed.body };
}
