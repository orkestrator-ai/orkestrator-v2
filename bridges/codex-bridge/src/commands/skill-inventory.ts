/**
 * The bridge-private Codex skill registry.
 *
 * Backed directly by app-server `skills/list` (generated v2 `SkillsListParams`
 * / `SkillMetadata`), never by the runtime-health projection: diagnostics
 * deliberately drop the skill path, and invocation needs exactly that path.
 *
 * Paths stay here. The public catalogue row carries an opaque id derived from
 * the path, and prompt dispatch resolves that id back to a binding from the
 * inventory of the *live* generation. Nothing a client sends can name a path.
 *
 * Lifecycle: a snapshot belongs to the child generation that answered it and
 * is withdrawn when that generation dies. `skills/changed` only marks the
 * snapshot dirty (O(1) on the notification path); a burst of notifications
 * coalesces into at most one off-loop re-read.
 */
import { isAbsolute } from "node:path";
import type { SkillScope } from "../app-server/generated/typescript/v2/index.js";
import {
  commandBindingRevision,
  truncateUtf8,
  utf8ByteLength,
} from "@orkestrator/protocol/agent-command-catalogue";
import type {
  NativeAgentCommandOrigin,
  NativeAgentSlashCommand,
} from "@orkestrator/protocol/native-agent";
import type { EngineGeneration } from "../engine/types.js";

export const SKILL_INVENTORY_LIMITS = Object.freeze({
  maxSkills: 512,
  maxDescriptionBytes: 1_000,
  /** A snapshot older than this is re-read even without `skills/changed`. */
  ttlMs: 30_000,
  /** Quiet period after `skills/changed` before the one coalesced re-read. */
  refreshDebounceMs: 250,
});

export const SKILL_ID_PREFIX = "codex-skill:";
export const SKILL_ALIAS_PREFIX = "/skill:";

const SCOPE_ORIGINS: Record<SkillScope, NativeAgentCommandOrigin> = {
  repo: "project",
  user: "user",
  system: "system",
  admin: "admin",
};

export interface SkillBinding {
  /** Public, opaque: `codex-skill:` + hash of the path. */
  id: string;
  /** Canonical skill name as app-server reported it. */
  name: string;
  /** Private: trusted absolute path from app-server. Never serialized. */
  path: string;
  enabled: boolean;
  pluginId: string | null;
  scope: SkillScope | "unknown";
  origin: NativeAgentCommandOrigin;
  description?: string;
  bindingRevision: string;
  /** Another skill shares this exact name, so `$name` cannot pick one. */
  ambiguous: boolean;
}

export interface SkillSnapshot {
  generation: EngineGeneration;
  cwd: string;
  bindings: readonly SkillBinding[];
  byId: ReadonlyMap<string, SkillBinding>;
  /** app-server reported discovery errors for the cwd: the list is incomplete. */
  partial: boolean;
  /** Rows were dropped for the count bound or unusable identity. */
  truncated: boolean;
  fetchedAt: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function nonEmpty(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

export function skillCommandId(path: string): string {
  return `${SKILL_ID_PREFIX}${commandBindingRevision([path])}`;
}

export function skillBindingRevision(name: string, path: string): string {
  return commandBindingRevision(["skill", name, path]);
}

/** A name that can be typed as `$name` and `/skill:name` within the row limits. */
function usableSkillName(name: string): boolean {
  return !/\s/.test(name) && utf8ByteLength(`${SKILL_ALIAS_PREFIX}${name}`) <= 255;
}

/**
 * Normalize an untrusted `skills/list` response into bounded bindings.
 *
 * Duplicate paths keep the first row. Duplicate *names* are never resolved by
 * array position: every row sharing an exact name is marked ambiguous, because
 * `$name` text cannot say which one the user meant.
 */
export function normalizeSkillsList(
  raw: unknown,
  context: { generation: EngineGeneration; cwd: string; now: number },
): SkillSnapshot {
  const data = isRecord(raw) && Array.isArray(raw.data) ? raw.data : [];
  const byPath = new Map<string, SkillBinding>();
  let partial = !isRecord(raw) || !Array.isArray(raw.data);
  let truncated = false;
  for (const entry of data) {
    if (!isRecord(entry)) {
      partial = true;
      continue;
    }
    if (Array.isArray(entry.errors) && entry.errors.length > 0) partial = true;
    const skills = Array.isArray(entry.skills) ? entry.skills : [];
    for (const candidate of skills) {
      if (!isRecord(candidate)) {
        truncated = true;
        continue;
      }
      const name = nonEmpty(candidate.name);
      const path = typeof candidate.path === "string" ? candidate.path : undefined;
      if (!name || !usableSkillName(name) || !path || !isAbsolute(path)) {
        truncated = true;
        continue;
      }
      if (byPath.has(path)) continue;
      if (byPath.size >= SKILL_INVENTORY_LIMITS.maxSkills) {
        truncated = true;
        continue;
      }
      const scope =
        typeof candidate.scope === "string" && candidate.scope in SCOPE_ORIGINS
          ? (candidate.scope as SkillScope)
          : "unknown";
      const pluginId = nonEmpty(candidate.pluginId) ?? null;
      const skillInterface = isRecord(candidate.interface) ? candidate.interface : {};
      const description =
        nonEmpty(skillInterface.shortDescription) ??
        nonEmpty(candidate.shortDescription) ??
        nonEmpty(candidate.description);
      byPath.set(path, {
        id: skillCommandId(path),
        name,
        path,
        // A row that does not say it is enabled is not trusted to be.
        enabled: candidate.enabled === true,
        pluginId,
        scope,
        origin: pluginId ? "plugin" : scope === "unknown" ? "unknown" : SCOPE_ORIGINS[scope],
        ...(description
          ? { description: truncateUtf8(description, SKILL_INVENTORY_LIMITS.maxDescriptionBytes) }
          : {}),
        bindingRevision: skillBindingRevision(name, path),
        ambiguous: false,
      });
    }
  }
  const nameCounts = new Map<string, number>();
  for (const binding of byPath.values()) {
    nameCounts.set(binding.name, (nameCounts.get(binding.name) ?? 0) + 1);
  }
  const bindings = [...byPath.values()].map((binding) =>
    (nameCounts.get(binding.name) ?? 0) > 1 ? { ...binding, ambiguous: true } : binding,
  );
  return {
    generation: context.generation,
    cwd: context.cwd,
    bindings,
    byId: new Map(bindings.map((binding) => [binding.id, binding])),
    partial,
    truncated,
    fetchedAt: context.now,
  };
}

/** Why a listed skill cannot run, or undefined when it can. */
export function skillUnavailability(
  binding: SkillBinding,
): { reason: "disabled" | "ambiguous"; message: string } | undefined {
  if (!binding.enabled) {
    return {
      reason: "disabled",
      message: `The ${binding.name} skill is disabled in Codex. Enable it to use it here.`,
    };
  }
  if (binding.ambiguous) {
    return {
      reason: "ambiguous",
      message: `More than one Codex skill is named ${binding.name}. Rename one so $${binding.name} is unambiguous.`,
    };
  }
  return undefined;
}

/** Public descriptor. Carries no path and nothing that could name one. */
export function skillCommandRow(binding: SkillBinding): NativeAgentSlashCommand {
  const unavailable = skillUnavailability(binding);
  return {
    name: `$${binding.name}`,
    insertText: `$${binding.name}`,
    // Compatibility spelling for the same binding; never unhandled slash text.
    aliases: [`${SKILL_ALIAS_PREFIX}${binding.name}`],
    id: binding.id,
    executionKind: "structured-skill",
    source: "skill",
    origin: binding.origin,
    scope: binding.origin === "project" ? "session" : "global",
    ...(binding.description ? { description: binding.description } : {}),
    bindingRevision: binding.bindingRevision,
    inputPolicy: { arguments: "optional", attachments: "images", busy: "queue" },
    ...(unavailable ? { availability: { state: "unavailable", ...unavailable } } : {}),
  };
}

export interface SkillInventoryDeps {
  list(options: { cwd: string; forceReload?: boolean }): Promise<{
    result: unknown;
    generation: EngineGeneration;
  }>;
  generation(): EngineGeneration;
  cwd: string;
  now(): number;
  ttlMs?: number;
  refreshDebounceMs?: number;
  /** Called after every re-read, successful or not, including coalesced ones. */
  onRefreshed?: (read: SkillInventoryRead) => void;
}

export interface SkillInventoryRead {
  /** The live generation's snapshot, possibly retained from an earlier read. */
  snapshot: SkillSnapshot | null;
  /** True when this read is authoritative and complete for the live child. */
  fresh: boolean;
  /** Bounded, content-free reason the inventory could not be refreshed. */
  error?: string;
}

export class SkillInventory {
  private snapshot: SkillSnapshot | null = null;
  private dirty = false;
  /** Bumped by every invalidation, so a read racing one stays dirty. */
  private invalidationSerial = 0;
  private inflight: { forced: boolean; promise: Promise<SkillInventoryRead> } | null = null;
  private refreshTimer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;
  /** Counters for tests and diagnostics; never names or paths. */
  readonly stats = { invalidations: 0, reads: 0, scheduledRefreshes: 0 };

  constructor(private readonly deps: SkillInventoryDeps) {}

  /**
   * `skills/changed`. Constant time: marks the snapshot dirty and arms at most
   * one refresh timer. Only an inventory someone has already read is kept
   * warm; a cold one is discovered on its first read anyway.
   */
  markChanged(): void {
    this.stats.invalidations += 1;
    this.invalidationSerial += 1;
    this.dirty = true;
    if (!this.snapshot || this.refreshTimer || this.disposed) return;
    this.stats.scheduledRefreshes += 1;
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = null;
      void this.read().catch(() => undefined);
    }, this.deps.refreshDebounceMs ?? SKILL_INVENTORY_LIMITS.refreshDebounceMs);
    this.refreshTimer.unref?.();
  }

  /** The child that answered is gone: its bindings are no longer trusted. */
  withdrawGeneration(current: EngineGeneration): void {
    if (this.snapshot && this.snapshot.generation !== current) this.snapshot = null;
    this.dirty = true;
  }

  /** The live generation's snapshot without any I/O, or null. */
  current(): SkillSnapshot | null {
    const snapshot = this.snapshot;
    return snapshot && snapshot.generation === this.deps.generation() ? snapshot : null;
  }

  async read(options: { forceReload?: boolean } = {}): Promise<SkillInventoryRead> {
    const snapshot = this.current();
    const ttl = this.deps.ttlMs ?? SKILL_INVENTORY_LIMITS.ttlMs;
    if (
      !options.forceReload &&
      snapshot &&
      !this.dirty &&
      this.deps.now() - snapshot.fetchedAt < ttl
    ) {
      return { snapshot, fresh: !snapshot.partial };
    }
    if (this.inflight && (this.inflight.forced || !options.forceReload)) {
      return this.inflight.promise;
    }
    const forced = options.forceReload === true;
    const promise = this.refresh(forced).finally(() => {
      if (this.inflight?.promise === promise) this.inflight = null;
    });
    this.inflight = { forced, promise };
    return promise;
  }

  private async refresh(forceReload: boolean): Promise<SkillInventoryRead> {
    const read = await this.fetch(forceReload);
    this.deps.onRefreshed?.(read);
    return read;
  }

  private async fetch(forceReload: boolean): Promise<SkillInventoryRead> {
    this.stats.reads += 1;
    const serial = this.invalidationSerial;
    try {
      const { result, generation } = await this.deps.list({
        cwd: this.deps.cwd,
        ...(forceReload ? { forceReload: true } : {}),
      });
      const next = normalizeSkillsList(result, {
        generation,
        cwd: this.deps.cwd,
        now: this.deps.now(),
      });
      this.snapshot = next;
      // An invalidation that landed while the request was in flight may not be
      // reflected in this answer.
      this.dirty = this.invalidationSerial !== serial;
      const live = this.current();
      if (!live)
        return { snapshot: null, fresh: false, error: "Codex restarted while listing skills" };
      return { snapshot: live, fresh: !live.partial };
    } catch {
      this.dirty = true;
      return { snapshot: this.current(), fresh: false, error: "Codex skills could not be listed" };
    }
  }

  dispose(): void {
    this.disposed = true;
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    this.refreshTimer = null;
  }
}
