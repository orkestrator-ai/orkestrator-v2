/**
 * The retirement schedule of the contract CI job (plan item 7013,
 * docs/reports/unified-federation.md §11.2 "Client adapters" and §11.4).
 *
 * The standing rule: a domain client's adapter for version `v` is deleted
 * when the support floor passes the first Stable release that advertises the
 * domain at `v + 1` or higher; adapter 0 (the legacy, pre-contract adapter)
 * when it passes the first Stable release that advertises the domain at all.
 * "Passes" means the floor is at or above that release, which happens
 * {@link SUPPORT_WINDOW_DAYS} days after it (or a later Stable release) is
 * published. From then on no peer in the window speaks `v`, so the adapter
 * is unreachable.
 *
 * Two inputs:
 *
 * - `packages/protocol/contracts/adapters.json` (generated, plan item 1009):
 *   every adapter below its domain's current version is scheduled.
 * - `packages/protocol/contracts/retirements.json` (hand-kept, this file's
 *   {@link RetirementList}): every per-domain capability command, with the
 *   domain version whose first Stable release retires it, or `null` when the
 *   command stays (it reports runtime state a version cannot say). Every
 *   command of `LEGACY_CAPABILITY_COMMANDS` must be listed, and a command
 *   with a retirement must be named by a register row.
 *
 * The job fails when an adapter or a capability command is due ("is
 * unreachable: delete it and move its register rows to Retired"), so a
 * retirement is never forgotten: the date passes, CI goes red, and the PR
 * that deletes the code moves the rows. `--retirements` prints the schedule
 * (`--json` for machines): per entry its condition, the first Stable release
 * that meets it, the earliest date and the register rows to move.
 *
 * Usage counters cannot be read here: they are local to each backend
 * (`get_compatibility_path_usage`), so "the counter is quiet" stays a manual
 * check before deleting; the report names the counter ids to read.
 */
import { LEGACY_CAPABILITY_COMMANDS } from "@orkestrator/protocol/contract/client";
import type { AdapterList } from "@orkestrator/protocol/contract/client-adapters";
import { isDomainName } from "@orkestrator/protocol/contract/domain";
import { REGISTER_DOCUMENT, rowAdapters, type RegisterDocument } from "./contract-ci-register.ts";
import { compareVersions, CONTRACTS_DIRECTORY } from "./contract-snapshots.ts";

/** The hand-kept list, relative to the repository root. */
export const RETIREMENT_LIST_PATH = `${CONTRACTS_DIRECTORY}/retirements.json`;
export const RETIREMENT_LIST_SCHEMA_VERSION = 1;
/** The schedule report's format (`--retirements --json`). */
export const RETIREMENT_SCHEDULE_SCHEMA_VERSION = 1;

/** A Stable release becomes the floor this long after it is published. */
export const SUPPORT_WINDOW_DAYS = 60;
const DAY_MS = 24 * 60 * 60 * 1000;

export interface CapabilityCommandRetirement {
  readonly domain: string;
  /**
   * The command goes when the floor passes the first Stable release that
   * advertises `domain` at this version or higher; `null` when it stays.
   */
  readonly retireAtDomainVersion: number | null;
  readonly why: string;
  /**
   * The day (`YYYY-MM-DD`) the command was deleted. The entry stays while an
   * in-window release still has the command, so the removed-command check
   * knows no in-window caller needs it (no domain bump is required).
   */
  readonly retired?: string;
}

export interface RetirementList {
  readonly schemaVersion: typeof RETIREMENT_LIST_SCHEMA_VERSION;
  readonly capabilityCommands: { readonly [command: string]: CapabilityCommandRetirement };
}

/** Reads the committed list, or returns why it is not one. */
export function parseRetirementList(value: unknown): RetirementList | string {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return `${RETIREMENT_LIST_PATH} is not an object.`;
  }
  const record = value as Record<string, unknown>;
  if (record.schemaVersion !== RETIREMENT_LIST_SCHEMA_VERSION) {
    return `${RETIREMENT_LIST_PATH} has schemaVersion ${JSON.stringify(record.schemaVersion)}; this job reads ${RETIREMENT_LIST_SCHEMA_VERSION}.`;
  }
  const raw = record.capabilityCommands;
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return `${RETIREMENT_LIST_PATH} has no capabilityCommands object.`;
  }
  const capabilityCommands: Record<string, CapabilityCommandRetirement> = {};
  for (const [command, entry] of Object.entries(raw)) {
    const { domain, retireAtDomainVersion, why, retired } = (entry ?? {}) as Record<
      string,
      unknown
    >;
    const version =
      retireAtDomainVersion === null ||
      (Number.isSafeInteger(retireAtDomainVersion) && (retireAtDomainVersion as number) >= 1);
    const retiredDay =
      retired === undefined ||
      (typeof retired === "string" &&
        /^\d{4}-\d{2}-\d{2}$/u.test(retired) &&
        retireAtDomainVersion !== null);
    if (
      typeof domain !== "string" ||
      !version ||
      typeof why !== "string" ||
      why === "" ||
      !retiredDay
    ) {
      return `${RETIREMENT_LIST_PATH}: ${command} needs { domain, retireAtDomainVersion (a version of at least 1, or null), why, retired? (YYYY-MM-DD, only with a version) }.`;
    }
    capabilityCommands[command] = {
      domain,
      retireAtDomainVersion: retireAtDomainVersion as number | null,
      why,
      ...(retired === undefined ? {} : { retired: retired as string }),
    };
  }
  return { schemaVersion: RETIREMENT_LIST_SCHEMA_VERSION, capabilityCommands };
}

/** A Stable release as the schedule reads it: its publication time and advertised domains. */
export interface StableRelease {
  readonly version: string;
  readonly publishedAt: string | null;
  readonly domains: { readonly [domain: string]: { readonly version: number } };
}

/**
 * - `waiting`: no Stable release meets the condition yet, or the one that does
 *   is not published, so there is no date.
 * - `scheduled`: the earliest date is known and the floor has not reached it.
 * - `due`: the floor has passed the release; the job fails until it is deleted.
 * - `kept`: a capability command that stays (no retirement).
 * - `retired`: a capability command deleted after its condition was met,
 *   listed until no in-window release has it.
 */
export type RetirementStatus = "waiting" | "scheduled" | "due" | "kept" | "retired";

export interface RetirementEntry {
  readonly kind: "adapter" | "capability-command";
  readonly domain: string;
  /** The adapter's version (`kind: "adapter"`). */
  readonly adapter?: number;
  /** The command (`kind: "capability-command"`). */
  readonly command?: string;
  /** It goes once the floor passes the first Stable release with the domain at this version; `null` when kept. */
  readonly domainVersion: number | null;
  readonly condition: string;
  /** The first Stable release that meets the condition. */
  readonly firstRelease: { readonly version: string; readonly publishedAt: string | null } | null;
  /** When the floor reaches `firstRelease` (ISO time), once a qualifying release is published. */
  readonly earliest: string | null;
  readonly status: RetirementStatus;
  /** Counter ids that show whether a peer still takes the path (local to each backend). */
  readonly counters: readonly string[];
  /** 1-based lines of the register rows that move to Retired with it. */
  readonly registerRows: readonly number[];
  /** Why a kept command stays, or why a retiring one was kept until now. */
  readonly why?: string;
  /** The day a capability command was deleted (`retirements.json`). */
  readonly retired?: string;
}

export interface RetirementSchedule {
  readonly schemaVersion: typeof RETIREMENT_SCHEDULE_SCHEMA_VERSION;
  readonly generatedBy: string;
  readonly now: string;
  readonly floor: string;
  readonly windowDays: number;
  readonly entries: readonly RetirementEntry[];
}

/** The lowest-version Stable release that advertises `domain` at `version` or higher. */
export function firstStableAdvertising(
  stable: readonly StableRelease[],
  domain: string,
  version: number,
): StableRelease | null {
  let first: StableRelease | null = null;
  for (const release of stable) {
    if ((release.domains[domain]?.version ?? 0) < version) continue;
    if (first === null || compareVersions(release.version, first.version) < 0) first = release;
  }
  return first;
}

/**
 * When the floor first stands at or above `version`: the earliest publication
 * of a Stable release at or above it, plus the window. `null` while none is
 * published.
 */
export function floorReachesOn(
  stable: readonly StableRelease[],
  version: string,
  windowDays = SUPPORT_WINDOW_DAYS,
): Date | null {
  let earliest: number | null = null;
  for (const release of stable) {
    if (release.publishedAt === null || compareVersions(release.version, version) < 0) continue;
    const published = Date.parse(release.publishedAt);
    if (!Number.isFinite(published)) continue;
    if (earliest === null || published < earliest) earliest = published;
  }
  return earliest === null ? null : new Date(earliest + windowDays * DAY_MS);
}

function day(value: Date): string {
  return value.toISOString().slice(0, 10);
}

function advertises(domain: string, version: number): string {
  return version <= 1 ? `advertises ${domain}` : `advertises ${domain} v${version}`;
}

export interface RetirementScheduleInput {
  readonly adapters: AdapterList;
  readonly list: RetirementList;
  readonly stable: readonly StableRelease[];
  /** The support floor's version on `now` (`supportFloor`). */
  readonly floor: string;
  readonly now: Date;
  readonly register: RegisterDocument;
  readonly windowDays?: number;
}

/** Every adapter below its domain's current version and every listed capability command. */
export function retirementSchedule(input: RetirementScheduleInput): RetirementSchedule {
  const windowDays = input.windowDays ?? SUPPORT_WINDOW_DAYS;
  const timing = (domain: string, domainVersion: number) => {
    const first = firstStableAdvertising(input.stable, domain, domainVersion);
    const reaches = first === null ? null : floorReachesOn(input.stable, first.version, windowDays);
    const status: RetirementStatus =
      first !== null && compareVersions(input.floor, first.version) >= 0
        ? "due"
        : reaches === null
          ? "waiting"
          : "scheduled";
    return {
      condition: `the floor passes the first Stable release that ${advertises(domain, domainVersion)}: ${windowDays} days after it is published`,
      firstRelease:
        first === null ? null : { version: first.version, publishedAt: first.publishedAt },
      earliest: reaches === null ? null : reaches.toISOString(),
      status,
    };
  };

  const entries: RetirementEntry[] = [];
  for (const [domain, client] of Object.entries(input.adapters.domains)) {
    if (client === undefined) continue;
    for (const adapter of [...client.adapters].sort((a, b) => a - b)) {
      if (adapter >= client.current) continue;
      const counters = [
        `domain-adapter.backend.${domain}.v${adapter}`,
        `domain-adapter.renderer.${domain}.v${adapter}`,
      ];
      const registerRows = input.register.register
        .filter((row) =>
          rowAdapters(row).some((named) => named.domain === domain && named.version === adapter),
        )
        .map((row) => row.line);
      entries.push({
        kind: "adapter",
        domain,
        adapter,
        domainVersion: adapter + 1,
        ...timing(domain, adapter + 1),
        counters,
        registerRows,
      });
    }
  }
  for (const [command, entry] of Object.entries(input.list.capabilityCommands)) {
    const registerRows = input.register.register
      .filter((row) => row.names.has(command))
      .map((row) => row.line);
    if (entry.retireAtDomainVersion === null) {
      entries.push({
        kind: "capability-command",
        domain: entry.domain,
        command,
        domainVersion: null,
        condition: "kept: it reports runtime state a domain version cannot say",
        firstRelease: null,
        earliest: null,
        status: "kept",
        counters: [],
        registerRows,
        why: entry.why,
      });
      continue;
    }
    const when = timing(entry.domain, entry.retireAtDomainVersion);
    entries.push({
      kind: "capability-command",
      domain: entry.domain,
      command,
      domainVersion: entry.retireAtDomainVersion,
      ...when,
      // A deletion before the condition keeps the timing's status, which the check reports.
      status: entry.retired !== undefined && when.status === "due" ? "retired" : when.status,
      counters: [],
      registerRows,
      why: entry.why,
      ...(entry.retired === undefined ? {} : { retired: entry.retired }),
    });
  }
  entries.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === "adapter" ? -1 : 1;
    if (a.domain !== b.domain) return a.domain < b.domain ? -1 : 1;
    if (a.adapter !== b.adapter) return (a.adapter ?? 0) - (b.adapter ?? 0);
    return (a.command ?? "") < (b.command ?? "") ? -1 : 1;
  });
  return {
    schemaVersion: RETIREMENT_SCHEDULE_SCHEMA_VERSION,
    generatedBy:
      "scripts/contract-ci.ts --retirements --json (mise run contract:ci -- --retirements --json)",
    now: input.now.toISOString(),
    floor: input.floor,
    windowDays,
    entries,
  };
}

function rowsText(lines: readonly number[]): string {
  if (lines.length === 0) return "no register row names it";
  return `register rows ${lines.map((line) => `${REGISTER_DOCUMENT}:${line}`).join(", ")}`;
}

/** The job's failures: every entry whose release the floor has passed. */
export function checkRetirements(schedule: RetirementSchedule): string[] {
  const problems: string[] = [];
  for (const entry of schedule.entries) {
    if (entry.retired !== undefined && entry.status !== "retired") {
      problems.push(
        `capability command ${entry.command} is marked retired on ${entry.retired} in ${RETIREMENT_LIST_PATH}, but the floor v${schedule.floor} has not passed the first Stable release that ${advertises(entry.domain, entry.domainVersion!)}: an in-window renderer may still call it; register it again.`,
      );
      continue;
    }
    if (entry.status !== "due") continue;
    const since = `the floor v${schedule.floor} has passed v${entry.firstRelease!.version}, the first Stable release that ${advertises(entry.domain, entry.domainVersion!)}`;
    if (entry.kind === "adapter") {
      problems.push(
        `adapter ${entry.domain} v${entry.adapter} is unreachable: delete it and move its register rows to Retired (${since}; ${rowsText(entry.registerRows)}). Check its counters first: ${entry.counters.map((id) => `\`${id}\``).join(", ")}.`,
      );
    } else {
      problems.push(
        `capability command ${entry.command} is unreachable: delete it, mark it \`"retired": "<date>"\` in ${RETIREMENT_LIST_PATH} and move its register rows to Retired (${since}; ${rowsText(entry.registerRows)}).`,
      );
    }
  }
  return problems;
}

/**
 * The list agrees with the code: every `LEGACY_CAPABILITY_COMMANDS` command is
 * listed under its domain, every listed command is registered in that domain,
 * and a command with a retirement has a register row.
 */
export function checkRetirementList(
  list: RetirementList,
  commands: { readonly [command: string]: { readonly domain: string } },
  register: RegisterDocument,
  legacy: Readonly<Partial<Record<string, readonly string[]>>> = LEGACY_CAPABILITY_COMMANDS,
): string[] {
  const problems: string[] = [];
  for (const [domain, names] of Object.entries(legacy)) {
    for (const command of names ?? []) {
      const entry = list.capabilityCommands[command];
      if (entry === undefined) {
        problems.push(
          `${command} is a legacy capability command of ${domain} (LEGACY_CAPABILITY_COMMANDS) but not in ${RETIREMENT_LIST_PATH}: add it with the domain version that retires it, or null with why it stays.`,
        );
      } else if (entry.domain !== domain) {
        problems.push(
          `${RETIREMENT_LIST_PATH} lists ${command} under ${entry.domain}; LEGACY_CAPABILITY_COMMANDS has it under ${domain}.`,
        );
      }
    }
  }
  for (const [command, entry] of Object.entries(list.capabilityCommands)) {
    if (!isDomainName(entry.domain)) {
      problems.push(`${RETIREMENT_LIST_PATH}: ${command} names ${entry.domain}, not a domain.`);
      continue;
    }
    const registered = commands[command];
    if (entry.retired !== undefined) {
      if (registered !== undefined) {
        problems.push(
          `${RETIREMENT_LIST_PATH} marks ${command} retired on ${entry.retired}, but it is still registered: delete it, or drop \`retired\`.`,
        );
      }
      continue;
    }
    if (registered === undefined) {
      problems.push(
        `${RETIREMENT_LIST_PATH} lists ${command}, which is no longer registered: mark it \`"retired": "<date>"\` (once its condition is met), and move its register rows to Retired.`,
      );
    } else if (registered.domain !== entry.domain) {
      problems.push(
        `${RETIREMENT_LIST_PATH} lists ${command} under ${entry.domain}; the manifest has it in ${registered.domain}.`,
      );
    }
    if (
      entry.retireAtDomainVersion !== null &&
      !register.register.some((row) => row.names.has(command))
    ) {
      problems.push(
        `${RETIREMENT_LIST_PATH} retires ${command} with ${entry.domain} v${entry.retireAtDomainVersion}, but no register row in ${REGISTER_DOCUMENT} names \`${command}\`: add one.`,
      );
    }
  }
  return problems;
}

/**
 * Capability commands deleted after their condition was met: no in-window
 * release's renderer calls them, so their removal needs no domain bump.
 */
export function retiredCommands(schedule: RetirementSchedule): ReadonlySet<string> {
  return new Set(
    schedule.entries
      .filter((entry) => entry.status === "retired" && entry.command !== undefined)
      .map((entry) => entry.command!),
  );
}

/** The schedule as text, one line per entry, grouped by status. */
export function formatRetirementSchedule(schedule: RetirementSchedule): string[] {
  const lines = [
    `Retirement schedule on ${schedule.now.slice(0, 10)} (floor v${schedule.floor}, window ${schedule.windowDays} days). Rule: adapter v goes when the floor passes the first Stable release that advertises the domain at v + 1 (adapter 0: that advertises the domain); a capability command goes with its domain's adapter 0 unless it is kept.`,
  ];
  const order: RetirementStatus[] = ["due", "scheduled", "waiting", "kept", "retired"];
  const titles: Record<RetirementStatus, string> = {
    due: "Due (the job fails until deleted)",
    scheduled: "Scheduled",
    waiting: "Waiting (no qualifying Stable release published yet)",
    kept: "Kept capability commands (no retirement)",
    retired: "Retired capability commands (listed while an in-window release has them)",
  };
  for (const status of order) {
    const entries = schedule.entries.filter((entry) => entry.status === status);
    if (entries.length === 0) continue;
    lines.push(`${titles[status]}: ${entries.length}`);
    for (const entry of entries) {
      const name =
        entry.kind === "adapter"
          ? `adapter ${entry.domain} v${entry.adapter}`
          : `capability command ${entry.command} (${entry.domain})`;
      if (status === "kept" || status === "retired") {
        lines.push(
          `  - ${name}: ${status === "retired" ? `deleted on ${entry.retired}` : entry.why}`,
        );
        continue;
      }
      const when =
        entry.earliest !== null
          ? `earliest ${day(new Date(entry.earliest))} (v${entry.firstRelease!.version}, published ${entry.firstRelease!.publishedAt ?? "not yet"})`
          : entry.firstRelease !== null
            ? `v${entry.firstRelease.version} is the first such Stable release, not yet published`
            : `${schedule.windowDays} days after the first Stable release that ${advertises(entry.domain, entry.domainVersion!)}; not yet shipped as of ${schedule.now.slice(0, 10)}`;
      const rows =
        entry.registerRows.length === 0
          ? ""
          : `; rows ${entry.registerRows.map((line) => `:${line}`).join(", ")}`;
      lines.push(`  - ${name}: ${when}${rows}`);
    }
  }
  return lines;
}
