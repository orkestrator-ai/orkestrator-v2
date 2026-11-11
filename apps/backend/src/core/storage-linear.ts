/**
 * Linear boards (docs/architecture/tickets.md, "Linear"): which Linear board
 * each project uses, the disconnects other machines must apply, and the
 * issues `create_linear_issue` has already created. The sign-in itself stays
 * in `KanbanRepository` (`linear-auth`).
 *
 * A board link is keyed by the project's repository (`repo:<hint>`), so the
 * same repository's project on every machine shares it and sync can carry it;
 * a project without a Git remote is keyed by its id (`project:<id>`) and stays
 * on this machine. A cleared link is kept as a tombstone so the clear syncs.
 * Nothing here holds a credential: a disconnect is recorded by the key's
 * fingerprint only.
 */
import { createLogger } from "@orkestrator/protocol/logger";
import { repositoryHint } from "@orkestrator/protocol/node-summaries";
import type { StorageContext } from "./storage-context.js";
import { isRecord, nowIso } from "./storage-shared-core.js";

const log = createLogger("linear");

export type LinearBoardLink = {
  key: string;
  repositoryHint?: string;
  projectId?: string;
  teamId?: string;
  teamKey?: string;
  teamName?: string;
  linearProjectId?: string;
  linearProjectName?: string;
  updatedAt: string;
  cleared?: boolean;
  /**
   * On a tombstone: the key of the link that kept this board when two of
   * this machine's projects were linked to it on different machines.
   */
  supersededBy?: string;
};

export type LinearRevocation = {
  keyFingerprint: string;
  revokedAt: string;
};

export type LinearIssueCreateRecord = {
  requestKey: string;
  linkKey: string;
  issueId: string;
  createdAt: string;
};

/** Board links one machine keeps, tombstones included; the oldest tombstones go first. */
export const MAX_LINEAR_BOARD_LINKS = 1_000;
/** Disconnects kept for machines that were offline; the oldest go first. */
export const MAX_LINEAR_REVOCATIONS = 50;
/** How long a disconnect is kept for a machine that has not been seen. */
export const LINEAR_REVOCATION_TTL_MS = 180 * 24 * 60 * 60 * 1_000;
/** Issue creations remembered for retries; the oldest go first. */
export const MAX_LINEAR_ISSUE_CREATES = 500;

const MAX_FIELD_LENGTH = 400;

/** The link key of a project: its repository when it has a remote, else its id. */
export function linearBoardLinkKey(project: { id: string; gitUrl?: string | null }): string {
  const hint = repositoryHint(project.gitUrl ?? undefined);
  return hint ? `repo:${hint}` : `project:${project.id}`;
}

/** Whether a key can travel to other machines (only repository keys can). */
export function isSyncableLinearLinkKey(key: string): boolean {
  return key.startsWith("repo:");
}

function boundedString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 && value.length <= MAX_FIELD_LENGTH
    ? value
    : undefined;
}

function isIsoDate(value: unknown): value is string {
  return typeof value === "string" && value.length <= 40 && !Number.isNaN(Date.parse(value));
}

/** A link read from storage or another machine, or `null` when it is not one. */
export function parseLinearBoardLink(value: unknown): LinearBoardLink | null {
  if (!isRecord(value)) return null;
  const key = boundedString(value.key);
  if (!key || !(key.startsWith("repo:") || key.startsWith("project:"))) return null;
  if (!isIsoDate(value.updatedAt)) return null;
  const cleared = value.cleared === true;
  const teamId = boundedString(value.teamId);
  if (!cleared && !teamId) return null;
  const link: LinearBoardLink = { key, updatedAt: value.updatedAt };
  const fields = [
    "repositoryHint",
    "projectId",
    "teamKey",
    "teamName",
    "linearProjectId",
    "linearProjectName",
  ] as const;
  if (!cleared) {
    link.teamId = teamId;
    for (const field of fields) {
      const text = boundedString(value[field]);
      if (text) link[field] = text;
    }
  } else {
    link.cleared = true;
    const hint = boundedString(value.repositoryHint);
    if (hint) link.repositoryHint = hint;
    const supersededBy = boundedString(value.supersededBy);
    if (supersededBy) link.supersededBy = supersededBy;
  }
  return link;
}

export function parseLinearRevocation(value: unknown): LinearRevocation | null {
  if (!isRecord(value)) return null;
  const keyFingerprint = boundedString(value.keyFingerprint);
  if (!keyFingerprint || !/^[a-f0-9]{8,64}$/.test(keyFingerprint)) return null;
  if (!isIsoDate(value.revokedAt)) return null;
  return { keyFingerprint, revokedAt: value.revokedAt };
}

/** Two live links name the same board when their teams match and either covers the other. */
export function sameLinearBoard(a: LinearBoardLink, b: LinearBoardLink): boolean {
  if (a.cleared || b.cleared || !a.teamId || a.teamId !== b.teamId) return false;
  return !a.linearProjectId || !b.linearProjectId || a.linearProjectId === b.linearProjectId;
}

function newer(a: string, b: string): boolean {
  return Date.parse(a) > Date.parse(b);
}

/** Now, or just after `after` when this machine's clock is behind it, so the change wins. */
function stampAfter(after: string): string {
  const now = Date.now();
  const floor = Date.parse(after) + 1;
  return new Date(Number.isNaN(floor) ? now : Math.max(now, floor)).toISOString();
}

/** A tombstone for a link that lost its board to `winner`. */
function supersededTombstone(link: LinearBoardLink, winner: string): LinearBoardLink {
  return {
    key: link.key,
    ...(link.repositoryHint ? { repositoryHint: link.repositoryHint } : {}),
    updatedAt: stampAfter(link.updatedAt),
    cleared: true,
    supersededBy: winner,
  };
}

function boundLinks(links: LinearBoardLink[]): void {
  if (links.length <= MAX_LINEAR_BOARD_LINKS) return;
  const tombstones = links
    .map((link, index) => ({ link, index }))
    .filter(({ link }) => link.cleared)
    .sort((a, b) => Date.parse(a.link.updatedAt) - Date.parse(b.link.updatedAt));
  const drop = new Set<number>();
  for (const { index } of tombstones) {
    if (links.length - drop.size <= MAX_LINEAR_BOARD_LINKS) break;
    drop.add(index);
  }
  const kept = links.filter((_, index) => !drop.has(index));
  links.splice(0, links.length, ...kept.slice(-MAX_LINEAR_BOARD_LINKS));
}

function boundRevocations(revocations: LinearRevocation[], now: number): LinearRevocation[] {
  const byFingerprint = new Map<string, LinearRevocation>();
  for (const revocation of revocations) {
    if (now - Date.parse(revocation.revokedAt) > LINEAR_REVOCATION_TTL_MS) continue;
    const existing = byFingerprint.get(revocation.keyFingerprint);
    if (!existing || newer(revocation.revokedAt, existing.revokedAt)) {
      byFingerprint.set(revocation.keyFingerprint, revocation);
    }
  }
  return [...byFingerprint.values()]
    .sort((a, b) => Date.parse(a.revokedAt) - Date.parse(b.revokedAt))
    .slice(-MAX_LINEAR_REVOCATIONS);
}

type LinearSyncDocument = { revocations: LinearRevocation[] };

export class LinearRepository {
  constructor(private readonly context: StorageContext) {}

  private linksFile(): string {
    return this.context.file("linear-board-links.json");
  }

  private syncFile(): string {
    return this.context.file("linear-sync.json");
  }

  private createsFile(): string {
    return this.context.file("linear-issue-creates.json");
  }

  /** Every link this machine keeps, tombstones included. */
  async listLinearBoardLinks(): Promise<LinearBoardLink[]> {
    const links = await this.context.loadJson<unknown[]>(this.linksFile(), () => []);
    return (Array.isArray(links) ? links : [])
      .map(parseLinearBoardLink)
      .filter((link): link is LinearBoardLink => link !== null);
  }

  /** The live link under `key`, or `null` (none, or cleared). */
  async getLinearBoardLink(key: string): Promise<LinearBoardLink | null> {
    const link = (await this.listLinearBoardLinks()).find((entry) => entry.key === key);
    return link && !link.cleared ? link : null;
  }

  /**
   * Links a project's board. Refused when a live link of one of `localKeys`
   * (this machine's other projects) already names that board.
   */
  saveLinearBoardLink(
    input: Omit<LinearBoardLink, "updatedAt" | "cleared">,
    localKeys: ReadonlySet<string>,
    describe: (key: string) => string = (key) => key,
  ): LinearBoardLink {
    const link = parseLinearBoardLink({ ...input, updatedAt: nowIso() });
    if (!link) throw new Error("Expected a Linear team for the board link.");
    return this.context.updateStore(
      this.linksFile(),
      (): LinearBoardLink[] => [],
      (links) => {
        const conflict = links
          .map(parseLinearBoardLink)
          .find(
            (other) =>
              other !== null &&
              other.key !== link.key &&
              localKeys.has(other.key) &&
              sameLinearBoard(other, link),
          );
        if (conflict) {
          throw new Error(
            `That Linear board is already linked to ${describe(conflict.key)}. A board belongs to one project.`,
          );
        }
        const index = links.findIndex((entry) => isRecord(entry) && entry.key === link.key);
        if (index >= 0) links[index] = link;
        else links.push(link);
        boundLinks(links);
        return link;
      },
    );
  }

  /** Clears a link, leaving a tombstone so the clear reaches other machines. */
  clearLinearBoardLink(key: string): boolean {
    return this.context.updateStore(
      this.linksFile(),
      (): LinearBoardLink[] => [],
      (links) => {
        const index = links.findIndex((entry) => isRecord(entry) && entry.key === key);
        const existing = index >= 0 ? parseLinearBoardLink(links[index]) : null;
        if (!existing || existing.cleared) return false;
        links[index] = {
          key,
          ...(existing.repositoryHint ? { repositoryHint: existing.repositoryHint } : {}),
          updatedAt: nowIso(),
          cleared: true,
        };
        return true;
      },
    );
  }

  /**
   * Applies links from another machine: for each key, the side that changed it
   * last wins. Only repository keys travel. Returns how many changed here.
   *
   * A board belongs to one project here too: when an incoming link names the
   * board a live link of another of `localKeys` (this machine's projects)
   * already has, the link changed last keeps it and the other is replaced by
   * a tombstone naming the winner (`supersededBy`), stamped now so the clear
   * reaches every machine and they all settle on the same owner. Two
   * machines that each linked a different repository to one board therefore
   * converge instead of leaving two projects on it.
   */
  mergeLinearBoardLinks(
    incoming: readonly unknown[],
    localKeys: ReadonlySet<string> = new Set(),
  ): number {
    const parsed = incoming
      .slice(0, MAX_LINEAR_BOARD_LINKS)
      .map(parseLinearBoardLink)
      .filter(
        (link): link is LinearBoardLink => link !== null && isSyncableLinearLinkKey(link.key),
      );
    if (parsed.length === 0) return 0;
    return this.context.updateStore(
      this.linksFile(),
      (): LinearBoardLink[] => [],
      (links) => {
        let changed = 0;
        const put = (link: LinearBoardLink) => {
          const index = links.findIndex((entry) => isRecord(entry) && entry.key === link.key);
          if (index >= 0) links[index] = link;
          else links.push(link);
          changed += 1;
        };
        for (const link of parsed) {
          const index = links.findIndex((entry) => isRecord(entry) && entry.key === link.key);
          const existing = index >= 0 ? parseLinearBoardLink(links[index]) : null;
          if (existing && !newer(link.updatedAt, existing.updatedAt)) continue;
          // A synced link names no project of this machine.
          const { projectId: _projectId, ...portable } = link;
          const rivals = localKeys.has(portable.key)
            ? links
                .map(parseLinearBoardLink)
                .filter(
                  (other): other is LinearBoardLink =>
                    other !== null &&
                    other.key !== portable.key &&
                    localKeys.has(other.key) &&
                    sameLinearBoard(other, portable),
                )
            : [];
          const winner = [portable, ...rivals].reduce((best, candidate) =>
            newer(candidate.updatedAt, best.updatedAt) ||
            (candidate.updatedAt === best.updatedAt && candidate.key < best.key)
              ? candidate
              : best,
          );
          for (const loser of [portable, ...rivals]) {
            if (loser === winner) continue;
            log.warn("board-link.conflict", { kept: winner.key, cleared: loser.key });
            put(supersededTombstone(loser, winner.key));
          }
          if (winner === portable) put(portable);
        }
        if (changed > 0) boundLinks(links);
        return changed;
      },
    );
  }

  async listLinearRevocations(): Promise<LinearRevocation[]> {
    const document = await this.context.loadJson<LinearSyncDocument | null>(
      this.syncFile(),
      () => null,
    );
    const list =
      isRecord(document) && Array.isArray(document.revocations) ? document.revocations : [];
    return list
      .map(parseLinearRevocation)
      .filter((revocation): revocation is LinearRevocation => revocation !== null);
  }

  /** Records disconnects (this machine's, or another's); returns how many were new or newer. */
  mergeLinearRevocations(incoming: readonly unknown[]): number {
    const parsed = incoming
      .slice(0, MAX_LINEAR_REVOCATIONS * 2)
      .map(parseLinearRevocation)
      .filter((revocation): revocation is LinearRevocation => revocation !== null);
    if (parsed.length === 0) return 0;
    return this.context.updateStore(
      this.syncFile(),
      (): LinearSyncDocument => ({ revocations: [] }),
      (document) => {
        const current = (Array.isArray(document.revocations) ? document.revocations : [])
          .map(parseLinearRevocation)
          .filter((revocation): revocation is LinearRevocation => revocation !== null);
        let changed = 0;
        for (const revocation of parsed) {
          const existing = current.find(
            (entry) => entry.keyFingerprint === revocation.keyFingerprint,
          );
          if (!existing || newer(revocation.revokedAt, existing.revokedAt)) changed += 1;
        }
        document.revocations = boundRevocations([...current, ...parsed], Date.now());
        return changed;
      },
    );
  }

  /** The issue an earlier `create_linear_issue` with this request key created, if any. */
  async findLinearIssueCreate(requestKey: string): Promise<LinearIssueCreateRecord | null> {
    const records = await this.context.loadJson<unknown[]>(this.createsFile(), () => []);
    const found = (Array.isArray(records) ? records : []).find(
      (record) => isRecord(record) && record.requestKey === requestKey,
    );
    return isRecord(found) &&
      typeof found.issueId === "string" &&
      typeof found.linkKey === "string" &&
      typeof found.createdAt === "string"
      ? {
          requestKey,
          linkKey: found.linkKey,
          issueId: found.issueId,
          createdAt: found.createdAt,
        }
      : null;
  }

  recordLinearIssueCreate(record: Omit<LinearIssueCreateRecord, "createdAt">): void {
    this.context.updateStore(
      this.createsFile(),
      (): LinearIssueCreateRecord[] => [],
      (records) => {
        const next = { ...record, createdAt: nowIso() };
        const index = records.findIndex(
          (entry) => isRecord(entry) && entry.requestKey === record.requestKey,
        );
        if (index >= 0) records[index] = next;
        else records.push(next);
        if (records.length > MAX_LINEAR_ISSUE_CREATES) {
          records.splice(0, records.length - MAX_LINEAR_ISSUE_CREATES);
        }
      },
    );
  }
}

/** What callers outside the storage files reach as `storage.linear`. */
export type LinearStorage = Pick<
  LinearRepository,
  | "listLinearBoardLinks"
  | "getLinearBoardLink"
  | "saveLinearBoardLink"
  | "clearLinearBoardLink"
  | "mergeLinearBoardLinks"
  | "listLinearRevocations"
  | "mergeLinearRevocations"
  | "findLinearIssueCreate"
  | "recordLinearIssueCreate"
>;
