/**
 * Self-improvement's memory: which signatures have tickets, which were fixed
 * in which version, and what each digest saw. It lives in the service's state
 * directory, `<data dir>/self-improvement/`.
 *
 * Holds signatures, numbers, ticket and PR references and short notes a person
 * wrote. Never log content.
 */
import { randomUUID } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { BundleData } from "./bundle.js";
import {
  compareVersions,
  type ExtractedSignals,
  type MeasureKind,
  type Signal,
  type SignalSource,
  UNKNOWN_VERSION,
} from "./signals.js";

export const LEDGER_SCHEMA_VERSION = 1;
export const DIGEST_SCHEMA_VERSION = 1;
/** Digests kept in the state directory; the oldest are removed after a save. */
export const MAX_DIGESTS = 120;
/** Observations kept per ledger entry. */
export const MAX_OBSERVATIONS = 60;
export const MAX_NOTE_CHARS = 500;
/** Hours a fixed version must have been watched before a verdict is given. */
export const MIN_VERIFY_HOURS = 24;
/** For an insight, conversations read on fixed versions before a verdict is given. */
export const MIN_VERIFY_CONVERSATIONS = 10;
/** A fixed signal is improved at or below this share of its baseline… */
export const IMPROVED_RATIO = 0.2;
/** …partly improved below this one, and unchanged at or above it. */
export const UNCHANGED_RATIO = 0.8;
/** A verified signal has regressed above this share of its baseline. */
export const REGRESSED_RATIO = 0.5;
/** A change in a signal's measure smaller than this share is reported as flat. */
export const TREND_RATIO = 0.25;

export type LedgerStatus = "tracking" | "fixed" | "verified" | "ignored";
export const LEDGER_STATUSES: readonly LedgerStatus[] = [
  "tracking",
  "fixed",
  "verified",
  "ignored",
];

export type Verdict =
  | "untracked"
  | "tracking"
  | "ignored"
  | "awaiting-deploy"
  | "awaiting-evidence"
  | "improved"
  | "partly-improved"
  | "unchanged"
  | "holding"
  | "regressed";

export interface Baseline {
  digestId: string;
  at: string;
  value: number;
  unit: string;
  kind: MeasureKind;
}

export interface Observation {
  digestId: string;
  at: string;
  /** The signal's measure in that digest; 0 when it was absent. */
  value: number;
  postFixValue: number | null;
  postFixHours: number | null;
  verdict: Verdict;
}

export interface LedgerEntry {
  signature: string;
  title: string;
  source: SignalSource;
  status: LedgerStatus;
  createdAt: string;
  updatedAt: string;
  ticket?: string;
  pr?: string;
  /** The first app version that carries the fix. */
  fixedIn?: string;
  /**
   * Set when the ticket was seen done and no one named the release: every
   * version newer than this one (the app running then) carries the fix.
   * `fixed` and `verified` need this or `fixedIn`.
   */
  fixedAfter?: string;
  note?: string;
  baseline?: Baseline;
  observations: Observation[];
}

export interface Ledger {
  schemaVersion: typeof LEDGER_SCHEMA_VERSION;
  entries: Record<string, LedgerEntry>;
}

export type Trend = "new" | "up" | "down" | "flat";

export interface DigestSignal extends Signal {
  trend: Trend;
  previousValue: number | null;
  ledger: { status: LedgerStatus; ticket?: string; verdict: Verdict } | null;
}

export interface Judgement {
  signature: string;
  title: string;
  status: LedgerStatus;
  ticket?: string;
  pr?: string;
  fixedIn?: string;
  verdict: Verdict;
  baseline: number | null;
  current: number;
  postFixValue: number | null;
  postFixHours: number | null;
  unit: string;
}

export interface DigestRecord {
  schemaVersion: typeof DIGEST_SCHEMA_VERSION;
  id: string;
  generatedAt: string;
  previousDigestId: string | null;
  bundle: {
    sha256: string;
    createdAt: string;
    appVersion: string;
    platform: string;
    arch: string;
    absent: string[];
    essentialEntries: number;
    essentialUnreadable: number;
    healthRows: number;
    hasDatabase: boolean;
  };
  window: ExtractedSignals["window"];
  observedHours: ExtractedSignals["observedHours"];
  signals: DigestSignal[];
  /** Signatures the previous digest had and this one does not. */
  gone: Array<{ signature: string; title: string; previousValue: number }>;
  /** Every ledger entry, judged against this digest. */
  judgements: Judgement[];
}

export function writeAtomic(file: string, contents: string): void {
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(temporary, contents, { mode: 0o600 });
  renameSync(temporary, file);
}

function ledgerPath(stateDir: string): string {
  return path.join(stateDir, "ledger.json");
}

function digestsDir(stateDir: string): string {
  return path.join(stateDir, "digests");
}

export function emptyLedger(): Ledger {
  return { schemaVersion: LEDGER_SCHEMA_VERSION, entries: {} };
}

export function loadLedger(stateDir: string): Ledger {
  let text: string;
  try {
    text = readFileSync(ledgerPath(stateDir), "utf8");
  } catch {
    return emptyLedger();
  }
  const parsed = JSON.parse(text) as Partial<Ledger>;
  if (
    parsed.schemaVersion !== LEDGER_SCHEMA_VERSION ||
    typeof parsed.entries !== "object" ||
    !parsed.entries
  ) {
    throw new Error(`${ledgerPath(stateDir)} is not a version ${LEDGER_SCHEMA_VERSION} ledger.`);
  }
  return parsed as Ledger;
}

export function saveLedger(stateDir: string, ledger: Ledger): void {
  writeAtomic(ledgerPath(stateDir), `${JSON.stringify(ledger, null, 2)}\n`);
}

export function digestIdOf(data: BundleData): string {
  const created = Date.parse(data.manifest.createdAt);
  const stamp = Number.isFinite(created)
    ? new Date(created)
        .toISOString()
        .replace(/[-:]/g, "")
        .replace(/\.\d+Z$/, "Z")
    : "undated";
  return `${stamp}-${data.sha256.slice(0, 8)}`;
}

/** Saved digests, oldest first by the bundle's creation time. */
export function listDigests(stateDir: string): DigestRecord[] {
  let names: string[];
  try {
    names = readdirSync(digestsDir(stateDir)).filter((name) => name.endsWith(".json"));
  } catch {
    return [];
  }
  const digests: DigestRecord[] = [];
  for (const name of names) {
    try {
      const record = JSON.parse(
        readFileSync(path.join(digestsDir(stateDir), name), "utf8"),
      ) as DigestRecord;
      if (record.schemaVersion === DIGEST_SCHEMA_VERSION) digests.push(record);
    } catch {
      // A damaged digest is skipped; the next save replaces nothing else.
    }
  }
  return digests.sort(
    (left, right) =>
      Date.parse(left.bundle.createdAt) - Date.parse(right.bundle.createdAt) ||
      left.id.localeCompare(right.id),
  );
}

export function saveDigest(stateDir: string, digest: DigestRecord, markdown: string): void {
  const dir = digestsDir(stateDir);
  writeAtomic(path.join(dir, `${digest.id}.json`), `${JSON.stringify(digest, null, 2)}\n`);
  writeAtomic(path.join(dir, `${digest.id}.md`), markdown);
  const digests = listDigests(stateDir);
  for (const old of digests.slice(0, Math.max(0, digests.length - MAX_DIGESTS))) {
    rmSync(path.join(dir, `${old.id}.json`), { force: true });
    rmSync(path.join(dir, `${old.id}.md`), { force: true });
  }
}

function trendOf(current: number, previous: number | null): Trend {
  if (previous === null) return "new";
  if (previous === 0) return current === 0 ? "flat" : "up";
  const change = (current - previous) / previous;
  if (change > TREND_RATIO) return "up";
  if (change < -TREND_RATIO) return "down";
  return "flat";
}

/** Whether an app version carries the entry's fix, or null when no version is recorded. */
export function fixCarrier(
  entry: Pick<LedgerEntry, "fixedIn" | "fixedAfter">,
): ((version: string) => boolean) | null {
  if (entry.fixedIn) {
    const fixedIn = entry.fixedIn;
    return (version) => version !== UNKNOWN_VERSION && compareVersions(version, fixedIn) >= 0;
  }
  if (entry.fixedAfter) {
    const fixedAfter = entry.fixedAfter;
    return (version) => version !== UNKNOWN_VERSION && compareVersions(version, fixedAfter) > 0;
  }
  return null;
}

/** The signal's measure over the versions that carry the fix, and how long they were watched. */
export function postFixMeasure(
  entry: Pick<LedgerEntry, "fixedIn" | "fixedAfter" | "source">,
  signal: Signal | undefined,
  kind: MeasureKind,
  observedHours: ExtractedSignals["observedHours"],
): { value: number; hours: number } | null {
  const carries = fixCarrier(entry);
  if (!carries) return null;
  const hours = Object.entries(observedHours[entry.source] ?? {})
    .filter(([version]) => carries(version))
    .reduce((sum, [, value]) => sum + value, 0);
  const slices = Object.entries(signal?.versions ?? {}).filter(([version]) => carries(version));
  if (kind === "gauge") {
    const values = slices.map(([, slice]) => slice.value ?? 0);
    return { value: values.length > 0 ? Math.max(...values) : 0, hours };
  }
  const count = slices.reduce((sum, [, slice]) => sum + slice.count, 0);
  // An insight's "hours" are conversations read, so its value is a share of them.
  const perUnit = entry.source === "insights" ? 1 : 24;
  return { value: hours > 0 ? (count / hours) * perUnit : 0, hours };
}

export function judge(
  entry: LedgerEntry,
  signal: Signal | undefined,
  observedHours: ExtractedSignals["observedHours"],
): { verdict: Verdict; post: { value: number; hours: number } | null } {
  if (entry.status === "ignored") return { verdict: "ignored", post: null };
  if (entry.status === "tracking") return { verdict: "tracking", post: null };
  const kind = entry.baseline?.kind ?? signal?.measure.kind ?? "rate";
  const post = postFixMeasure(entry, signal, kind, observedHours);
  if (!post || post.hours === 0) return { verdict: "awaiting-deploy", post };
  const minimum = entry.source === "insights" ? MIN_VERIFY_CONVERSATIONS : MIN_VERIFY_HOURS;
  if (post.hours < minimum) return { verdict: "awaiting-evidence", post };
  const baseline = entry.baseline?.value ?? null;
  if (entry.status === "verified") {
    const regressed = baseline === null ? post.value > 0 : post.value > baseline * REGRESSED_RATIO;
    return { verdict: regressed ? "regressed" : "holding", post };
  }
  if (baseline === null || baseline === 0) {
    return { verdict: post.value === 0 ? "improved" : "unchanged", post };
  }
  if (post.value <= baseline * IMPROVED_RATIO) return { verdict: "improved", post };
  if (post.value < baseline * UNCHANGED_RATIO) return { verdict: "partly-improved", post };
  return { verdict: "unchanged", post };
}

/**
 * Builds the digest for one bundle and records each ledger entry's observation.
 * Statuses never change here: a person or the coordinator changes them with
 * `ledger`, after reading the verdict.
 */
export function buildDigest(
  data: BundleData,
  extracted: ExtractedSignals,
  previous: DigestRecord | null,
  ledger: Ledger,
  now: Date = new Date(),
): DigestRecord {
  const id = digestIdOf(data);
  const previousValues = new Map(
    previous?.signals.map((signal) => [signal.signature, signal]) ?? [],
  );
  const bySignature = new Map(extracted.signals.map((signal) => [signal.signature, signal]));

  const judgements: Judgement[] = [];
  const verdicts = new Map<string, Verdict>();
  for (const entry of Object.values(ledger.entries)) {
    const signal = bySignature.get(entry.signature);
    const { verdict, post } = judge(entry, signal, extracted.observedHours);
    verdicts.set(entry.signature, verdict);
    const current = signal?.measure.value ?? 0;
    judgements.push({
      signature: entry.signature,
      title: entry.title,
      status: entry.status,
      ticket: entry.ticket,
      pr: entry.pr,
      fixedIn: entry.fixedIn ?? (entry.fixedAfter ? `after ${entry.fixedAfter}` : undefined),
      verdict,
      baseline: entry.baseline?.value ?? null,
      current,
      postFixValue: post ? round(post.value) : null,
      postFixHours: post ? round(post.hours) : null,
      unit: entry.baseline?.unit ?? signal?.measure.unit ?? "",
    });
    const observation: Observation = {
      digestId: id,
      at: data.manifest.createdAt || now.toISOString(),
      value: current,
      postFixValue: post ? round(post.value) : null,
      postFixHours: post ? round(post.hours) : null,
      verdict,
    };
    entry.observations = [
      ...entry.observations.filter((existing) => existing.digestId !== id),
      observation,
    ].slice(-MAX_OBSERVATIONS);
  }

  const signals: DigestSignal[] = extracted.signals.map((signal) => {
    const before = previousValues.get(signal.signature);
    const entry = ledger.entries[signal.signature];
    return {
      ...signal,
      trend: trendOf(signal.measure.value, before?.measure.value ?? null),
      previousValue: before?.measure.value ?? null,
      ledger: entry
        ? { status: entry.status, ticket: entry.ticket, verdict: verdicts.get(signal.signature)! }
        : null,
    };
  });
  const gone = (previous?.signals ?? [])
    .filter((signal) => !bySignature.has(signal.signature))
    .map((signal) => ({
      signature: signal.signature,
      title: signal.title,
      previousValue: signal.measure.value,
    }));

  const verdictOrder: Verdict[] = [
    "regressed",
    "unchanged",
    "partly-improved",
    "improved",
    "awaiting-evidence",
    "awaiting-deploy",
    "holding",
    "tracking",
    "ignored",
    "untracked",
  ];
  judgements.sort(
    (left, right) =>
      verdictOrder.indexOf(left.verdict) - verdictOrder.indexOf(right.verdict) ||
      left.signature.localeCompare(right.signature),
  );

  return {
    schemaVersion: DIGEST_SCHEMA_VERSION,
    id,
    generatedAt: now.toISOString(),
    previousDigestId: previous?.id ?? null,
    bundle: {
      sha256: data.sha256,
      createdAt: data.manifest.createdAt,
      appVersion: data.manifest.appVersion,
      platform: data.manifest.platform,
      arch: data.manifest.arch,
      absent: data.manifest.absent.map((item) => item.name),
      essentialEntries: data.essential.length,
      essentialUnreadable: data.essentialUnreadable,
      healthRows: data.health.length,
      hasDatabase: data.database !== null,
    },
    window: extracted.window,
    observedHours: extracted.observedHours,
    signals,
    gone,
    judgements,
  };
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}

export interface LedgerChange {
  status?: LedgerStatus;
  ticket?: string;
  pr?: string;
  fixedIn?: string;
  fixedAfter?: string;
  /** Clears `fixedIn` and `fixedAfter`, for a fix that did not work. */
  clearFix?: boolean;
  note?: string;
  /** Overrides the baseline taken from the latest digest. */
  baseline?: number;
}

/**
 * Creates or updates one entry. A new entry takes its title, source and
 * baseline from the newest digest that saw the signature. `fixed` needs the
 * version that carries the fix, since every later verdict depends on it.
 */
export function applyLedgerChange(
  ledger: Ledger,
  signature: string,
  change: LedgerChange,
  digests: readonly DigestRecord[],
  now: Date = new Date(),
): LedgerEntry {
  if (change.status && !LEDGER_STATUSES.includes(change.status)) {
    throw new Error(`Unknown status ${change.status}; use one of ${LEDGER_STATUSES.join(", ")}.`);
  }
  if (change.note && change.note.length > MAX_NOTE_CHARS) {
    throw new Error(`A note is at most ${MAX_NOTE_CHARS} characters.`);
  }
  const latest = [...digests]
    .reverse()
    .map((digest) => ({
      digest,
      signal: digest.signals.find((signal) => signal.signature === signature),
    }))
    .find((found) => found.signal !== undefined);
  const existing = ledger.entries[signature];
  if (!existing && !latest) {
    throw new Error(
      `No saved digest has seen ${signature}; run a digest first, or check the signature.`,
    );
  }
  const nextStatus = change.status ?? existing?.status ?? "tracking";
  const keepsFix = !change.clearFix;
  if (
    (nextStatus === "fixed" || nextStatus === "verified") &&
    !(
      change.fixedIn ??
      change.fixedAfter ??
      (keepsFix ? (existing?.fixedIn ?? existing?.fixedAfter) : undefined)
    )
  ) {
    throw new Error(
      `Status ${nextStatus} needs --fixed-in <version>: the first app version that carries the fix.`,
    );
  }
  if (change.baseline !== undefined && (!Number.isFinite(change.baseline) || change.baseline < 0)) {
    throw new Error("A baseline is a number of at least 0.");
  }
  const timestamp = now.toISOString();
  const entry: LedgerEntry = existing ?? {
    signature,
    title: latest!.signal!.title,
    source: latest!.signal!.source,
    status: "tracking",
    createdAt: timestamp,
    updatedAt: timestamp,
    observations: [],
  };
  if (!entry.baseline && latest?.signal) {
    entry.baseline = {
      digestId: latest.digest.id,
      at: latest.digest.bundle.createdAt,
      value: latest.signal.measure.value,
      unit: latest.signal.measure.unit,
      kind: latest.signal.measure.kind,
    };
  }
  if (change.baseline !== undefined) {
    entry.baseline = {
      digestId: entry.baseline?.digestId ?? "manual",
      at: timestamp,
      value: change.baseline,
      unit: entry.baseline?.unit ?? latest?.signal?.measure.unit ?? "",
      kind: entry.baseline?.kind ?? latest?.signal?.measure.kind ?? "rate",
    };
  }
  if (change.ticket !== undefined) entry.ticket = change.ticket;
  if (change.pr !== undefined) entry.pr = change.pr;
  if (change.clearFix) {
    delete entry.fixedIn;
    delete entry.fixedAfter;
  }
  if (change.fixedIn !== undefined) entry.fixedIn = change.fixedIn.replace(/^v/, "");
  if (change.fixedAfter !== undefined) entry.fixedAfter = change.fixedAfter.replace(/^v/, "");
  if (change.note !== undefined) entry.note = change.note;
  entry.status = nextStatus;
  entry.updatedAt = timestamp;
  ledger.entries[signature] = entry;
  return entry;
}
