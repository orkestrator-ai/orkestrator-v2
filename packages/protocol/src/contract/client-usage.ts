/**
 * Content-free usage counters for domain client adapters
 * (docs/reports/unified-federation.md §11.2 "Client adapters"; plan item 1009).
 *
 * A domain client counts every call through an adapter below its domain's
 * current version: the legacy adapter 0 for a pre-contract node, or an older
 * version for an older contract node. A count is a domain name, an adapter
 * version and a number; nothing else is recorded (no node, command, argument,
 * URL or peer version). The counts are the evidence for deleting an adapter
 * once the support floor passes the first Stable release with `v + 1`.
 *
 * - The backend's own clients (the node link, plan item 1010) count into the
 *   compatibility-path counters under {@link domainAdapterPathId}`("backend", …)`.
 * - A renderer counts into a {@link DomainAdapterUsageRing} and uploads new
 *   counts with {@link RECORD_DOMAIN_ADAPTER_USAGE_COMMAND}; its backend adds
 *   them to the same counters under `"renderer"`.
 *
 * Browser-safe: no Node or Bun imports.
 */
import * as Schema from "effect/Schema";
import { defineCommand } from "./command.js";
import { MAX_DOMAIN_VERSION, isDomainName, type DomainName } from "./domain.js";
import { systemDomain } from "./domains/system/domain.js";
import { DomainNameSchema, DomainVersionSchema } from "./envelope.js";

/** Records a renderer's new adapter counts in its backend's compatibility-path counters. */
export const RECORD_DOMAIN_ADAPTER_USAGE_COMMAND = "record_domain_adapter_usage";

/** The most (domain, version) pairs a ring keeps; the least recently used is dropped. */
export const DOMAIN_ADAPTER_USAGE_RING_SIZE = 64;

/** The most entries one upload carries. */
export const MAX_DOMAIN_ADAPTER_USAGE_BATCH = 32;

/** A count is capped here, in a ring and in an upload. */
export const MAX_DOMAIN_ADAPTER_USAGE_COUNT = 1_000_000;

/** One adapter's count: names and numbers only. */
export interface DomainAdapterUsageEntry {
  readonly domain: DomainName;
  readonly version: number;
  readonly count: number;
}

/** What the backend answers an upload: how many entries it counted and how many it did not know. */
export interface RecordDomainAdapterUsageResult {
  readonly accepted: number;
  readonly dropped: number;
}

/** Who took the adapter: the backend's own client, or a renderer's. */
export const DOMAIN_ADAPTER_USAGE_SOURCES = ["backend", "renderer"] as const;

export type DomainAdapterUsageSource = (typeof DOMAIN_ADAPTER_USAGE_SOURCES)[number];

/** A compatibility-path counter id for one adapter. */
export type DomainAdapterPathId =
  `domain-adapter.${DomainAdapterUsageSource}.${DomainName}.v${number}`;

const PATH_ID_PATTERN =
  /^domain-adapter\.(backend|renderer)\.([a-z][a-z0-9-]*)\.v(0|[1-9][0-9]{0,3})$/u;

/** Whether `version` is an adapter version: an integer 0 to the domain maximum. */
export function isAdapterVersion(value: unknown): value is number {
  return (
    Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= MAX_DOMAIN_VERSION
  );
}

/** The counter id for one adapter, for example `domain-adapter.renderer.node-mail.v0`. */
export function domainAdapterPathId(
  source: DomainAdapterUsageSource,
  domain: DomainName,
  version: number,
): DomainAdapterPathId {
  return `domain-adapter.${source}.${domain}.v${version}`;
}

/** Whether `value` is a well-formed adapter counter id naming a known domain. */
export function isDomainAdapterPathId(value: unknown): value is DomainAdapterPathId {
  if (typeof value !== "string") return false;
  const match = PATH_ID_PATTERN.exec(value);
  return match !== null && isDomainName(match[2]) && isAdapterVersion(Number(match[3]));
}

/** One uploaded entry. Unknown keys are dropped (tolerant reader); the backend drops unknown pairs. */
export const DomainAdapterUsageEntrySchema = Schema.Struct({
  domain: DomainNameSchema,
  version: DomainVersionSchema,
  count: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER })),
});

/**
 * `record_domain_adapter_usage` (the `system` domain): a renderer's new
 * adapter counts, at most one batch. `admin` access: the counters are the
 * machine's own, so a workspace client never writes them.
 */
export const recordDomainAdapterUsageCommand = defineCommand({
  domain: systemDomain,
  name: RECORD_DOMAIN_ADAPTER_USAGE_COMMAND,
  since: 1,
  access: "admin",
  read: false,
  args: Schema.Struct({
    entries: Schema.Array(DomainAdapterUsageEntrySchema).check(
      Schema.isMinLength(1),
      Schema.isMaxLength(MAX_DOMAIN_ADAPTER_USAGE_BATCH),
    ),
  }),
  result: Schema.Struct({
    accepted: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
    dropped: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  }),
  critical: [],
});

interface Slot {
  readonly domain: DomainName;
  readonly version: number;
  total: number;
  unsent: number;
}

function cap(count: number): number {
  return Math.min(count, MAX_DOMAIN_ADAPTER_USAGE_COUNT);
}

function keyOf(domain: string, version: number): string {
  return `${domain}@${version}`;
}

/**
 * A bounded ring of adapter counts, for a renderer (or any client without the
 * backend's counters). At most `capacity` pairs, each count capped; recording
 * an invalid pair is ignored. `record` never throws and does no I/O, so a
 * domain client calls it inline.
 */
export class DomainAdapterUsageRing {
  /** In order of last use, oldest first, so eviction drops the least recent. */
  private readonly slots = new Map<string, Slot>();
  private readonly listeners = new Set<() => void>();

  constructor(private readonly capacity = DOMAIN_ADAPTER_USAGE_RING_SIZE) {}

  /** Counts one call through `domain`'s adapter `version`. */
  record(domain: DomainName, version: number): void {
    if (!isDomainName(domain) || !isAdapterVersion(version)) return;
    const key = keyOf(domain, version);
    const slot = this.slots.get(key);
    this.slots.delete(key);
    this.slots.set(key, {
      domain,
      version,
      total: cap((slot?.total ?? 0) + 1),
      unsent: cap((slot?.unsent ?? 0) + 1),
    });
    while (this.slots.size > this.capacity) {
      const oldest = this.slots.keys().next().value;
      if (oldest === undefined) break;
      this.slots.delete(oldest);
    }
    for (const listener of this.listeners) {
      try {
        listener();
      } catch {
        // A listener never fails the call being counted.
      }
    }
  }

  /** Called after every record. */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Every pair with its total count, least recently used first. */
  entries(): DomainAdapterUsageEntry[] {
    return Array.from(this.slots.values(), ({ domain, version, total }) => ({
      domain,
      version,
      count: total,
    }));
  }

  /** New counts to send, at most one batch; they count as sent. */
  takeUnsent(max = MAX_DOMAIN_ADAPTER_USAGE_BATCH): DomainAdapterUsageEntry[] {
    const batch: DomainAdapterUsageEntry[] = [];
    for (const slot of this.slots.values()) {
      if (batch.length >= max) break;
      if (slot.unsent === 0) continue;
      batch.push({ domain: slot.domain, version: slot.version, count: slot.unsent });
      slot.unsent = 0;
    }
    return batch;
  }

  /** Puts back counts a send did not deliver. A pair evicted meanwhile stays lost. */
  restore(batch: readonly DomainAdapterUsageEntry[]): void {
    for (const sent of batch) {
      const slot = this.slots.get(keyOf(sent.domain, sent.version));
      if (slot) slot.unsent = cap(slot.unsent + sent.count);
    }
  }

  hasUnsent(): boolean {
    for (const slot of this.slots.values()) if (slot.unsent > 0) return true;
    return false;
  }
}
