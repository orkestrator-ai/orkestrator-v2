import { createHash } from "node:crypto";
import {
  PERMISSION_RULE_LIMITS,
  parsePermissionRule,
  parsePermissionRuleApplication,
  type NativeAgentPermissionRule,
  type PermissionRuleApplication,
} from "@orkestrator/protocol/permission-rules";
import type { StorageDatabase } from "../storage-database.js";
import { PERMISSION_RULE_APPLICATIONS_STORE, PERMISSION_RULES_STORE } from "./layout.js";

/**
 * Orkestrator's permission rules and the record of each request a rule
 * answered, as rows of the backend database (todo 0723).
 *
 * Per machine: nothing here syncs to other nodes (decision 3). Every write is
 * one synchronous transaction, so a claim is exactly-once across sweeps,
 * projection reads and processes sharing the data directory. Reads skip a row
 * that does not parse rather than fail: an unreadable rule answers nothing,
 * which is the fail-closed direction.
 */

export class PermissionRuleCapacityError extends Error {}

/** Bound on the application record; the oldest rows go first. */
export const MAX_PERMISSION_RULE_APPLICATIONS = 1_024;

export type PermissionRuleApplicationState = "claimed" | "applied" | "failed";

interface StoredApplication extends PermissionRuleApplication {
  state: PermissionRuleApplicationState;
}

export interface PermissionRuleStoreOptions {
  /** The backend database; called per operation so a reopened connection is used. */
  database: () => StorageDatabase;
  /** Announces a committed change (resource kind `permission-rule`). */
  announce?: (id: string) => void;
}

export type PermissionRuleClaim = "claimed" | "duplicate" | "rule-gone";

/** The application row key: a digest, so no session or interaction id is a key. */
export function permissionRuleApplicationKey(
  application: Pick<
    PermissionRuleApplication,
    "environmentId" | "agent" | "logicalSessionKey" | "interactionId"
  >,
): string {
  return createHash("sha256")
    .update(application.environmentId)
    .update("\0")
    .update(application.agent)
    .update("\0")
    .update(application.logicalSessionKey)
    .update("\0")
    .update(application.interactionId)
    .digest("hex")
    .slice(0, 40);
}

function parseJson(raw: string | undefined): unknown {
  if (raw === undefined) return undefined;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return undefined;
  }
}

function parseStoredApplication(raw: unknown): StoredApplication | null {
  const application = parsePermissionRuleApplication(raw);
  const state = (raw as { state?: unknown } | null)?.state;
  if (!application || (state !== "claimed" && state !== "applied" && state !== "failed")) {
    return null;
  }
  return { ...application, state };
}

function sameRule(left: NativeAgentPermissionRule, right: NativeAgentPermissionRule): boolean {
  return (
    left.provider === right.provider &&
    left.scope === right.scope &&
    left.projectId === right.projectId &&
    left.environmentId === right.environmentId &&
    left.kind === right.kind &&
    left.pattern === right.pattern
  );
}

export class PermissionRuleStore {
  constructor(private readonly options: PermissionRuleStoreOptions) {}

  private database(): StorageDatabase {
    return this.options.database();
  }

  /** Every readable rule. Throws only when the database itself cannot be read. */
  list(): NativeAgentPermissionRule[] {
    const database = this.database();
    if (!database.hasStore(PERMISSION_RULES_STORE)) return [];
    const rules: NativeAgentPermissionRule[] = [];
    for (const entry of database.rows(PERMISSION_RULES_STORE).list({ values: true })) {
      const rule = entry.value === null ? null : parsePermissionRule(parseJson(entry.value));
      if (rule && rule.id === entry.key) rules.push(rule);
    }
    return rules.sort((left, right) => left.createdAt - right.createdAt);
  }

  /** Rules of one project, read through the owner index. */
  listForProject(projectId: string): NativeAgentPermissionRule[] {
    const database = this.database();
    if (!database.hasStore(PERMISSION_RULES_STORE)) return [];
    const rules: NativeAgentPermissionRule[] = [];
    for (const entry of database
      .rows(PERMISSION_RULES_STORE)
      .list({ values: true, owner: projectId })) {
      const rule = entry.value === null ? null : parsePermissionRule(parseJson(entry.value));
      if (rule && rule.id === entry.key && rule.projectId === projectId) rules.push(rule);
    }
    return rules.sort((left, right) => left.createdAt - right.createdAt);
  }

  get(id: string): NativeAgentPermissionRule | null {
    const database = this.database();
    if (!database.hasStore(PERMISSION_RULES_STORE)) return null;
    const rule = parsePermissionRule(parseJson(database.rows(PERMISSION_RULES_STORE).get(id)));
    return rule?.id === id ? rule : null;
  }

  /**
   * Saves `rule`, or returns the identical rule already saved (same provider,
   * scope, project, environment, kind and pattern) with the new expiry. The
   * rule must already be validated; it is checked again here.
   */
  create(rule: NativeAgentPermissionRule): NativeAgentPermissionRule {
    const checked = parsePermissionRule(rule);
    if (!checked) throw new Error("Invalid permission rule");
    const database = this.database();
    const saved = database.transaction(() => {
      const rows = database.rows(PERMISSION_RULES_STORE);
      const entries = rows.list({ values: true, owner: checked.projectId });
      for (const entry of entries) {
        const existing = entry.value === null ? null : parsePermissionRule(parseJson(entry.value));
        if (!existing || !sameRule(existing, checked)) continue;
        const { expiresAt: _previous, ...rest } = existing;
        const updated: NativeAgentPermissionRule = {
          ...rest,
          ...(checked.expiresAt === undefined ? {} : { expiresAt: checked.expiresAt }),
        };
        rows.put(existing.id, JSON.stringify(updated));
        return updated;
      }
      if (rows.list({ values: false }).length >= PERMISSION_RULE_LIMITS.maxRules) {
        throw new PermissionRuleCapacityError(
          `At most ${PERMISSION_RULE_LIMITS.maxRules} permission rules can exist; remove some first`,
        );
      }
      if (rows.has(checked.id)) throw new Error("Permission rule id already exists");
      rows.put(checked.id, JSON.stringify(checked));
      return checked;
    });
    this.options.announce?.(saved.id);
    return saved;
  }

  /** Removes one rule. Its past applications stay, with the pattern they used. */
  delete(id: string): boolean {
    const database = this.database();
    if (!database.hasStore(PERMISSION_RULES_STORE)) return false;
    const deleted = database.transaction(() => database.rows(PERMISSION_RULES_STORE).delete(id));
    if (deleted) this.options.announce?.(id);
    return deleted;
  }

  /** Removes every rule of a project; returns the removed ids. */
  deleteForProject(projectId: string): string[] {
    const ids = this.listForProject(projectId).map((rule) => rule.id);
    const database = this.database();
    if (ids.length === 0 || !database.hasStore(PERMISSION_RULES_STORE)) return [];
    database.transaction(() => {
      const rows = database.rows(PERMISSION_RULES_STORE);
      for (const id of ids) rows.delete(id);
    });
    for (const id of ids) this.options.announce?.(id);
    return ids;
  }

  /**
   * An environment is being deleted: its environment-scoped rules and its
   * application record go with it. Project rules stay.
   */
  environmentDeleted(environmentId: string): void {
    const database = this.database();
    const removed: string[] = [];
    database.transaction(() => {
      if (database.hasStore(PERMISSION_RULES_STORE)) {
        const rows = database.rows(PERMISSION_RULES_STORE);
        for (const entry of rows.list({ values: true })) {
          const rule = entry.value === null ? null : parsePermissionRule(parseJson(entry.value));
          if (rule?.scope === "environment" && rule.environmentId === environmentId) {
            rows.delete(entry.key);
            removed.push(entry.key);
          }
        }
      }
      if (database.hasStore(PERMISSION_RULE_APPLICATIONS_STORE)) {
        database.rows(PERMISSION_RULE_APPLICATIONS_STORE).deleteWhere({ owner: environmentId });
      }
    });
    for (const id of removed) this.options.announce?.(id);
  }

  /**
   * Claims the right to answer one request with `application.ruleId`. Only the
   * first claim of a request wins (`duplicate` afterwards, whatever became of
   * it), and only while the rule still exists, in the same transaction, so a
   * rule removed a moment ago answers nothing.
   */
  claimApplication(application: PermissionRuleApplication, now: number): PermissionRuleClaim {
    const key = permissionRuleApplicationKey(application);
    const database = this.database();
    return database.transaction(() => {
      const applications = database.rows(PERMISSION_RULE_APPLICATIONS_STORE);
      if (applications.has(key)) return "duplicate";
      const rule = database.hasStore(PERMISSION_RULES_STORE)
        ? parsePermissionRule(
            parseJson(database.rows(PERMISSION_RULES_STORE).get(application.ruleId)),
          )
        : null;
      if (!rule || rule.id !== application.ruleId || (rule.expiresAt ?? Infinity) <= now) {
        return "rule-gone";
      }
      const entries = applications.list({ values: true });
      if (entries.length >= MAX_PERMISSION_RULE_APPLICATIONS) {
        const oldest = entries
          .map((entry) => ({
            key: entry.key,
            at: parseStoredApplication(parseJson(entry.value ?? undefined))?.appliedAt ?? 0,
          }))
          .sort((left, right) => left.at - right.at)
          .slice(0, entries.length - MAX_PERMISSION_RULE_APPLICATIONS + 1);
        for (const entry of oldest) applications.delete(entry.key);
      }
      const stored: StoredApplication = { ...application, state: "claimed" };
      applications.put(key, JSON.stringify(stored));
      return "claimed";
    });
  }

  /**
   * Records how a claimed answer went. An applied one also counts as a use of
   * its rule, if the rule still exists.
   */
  finishApplication(application: PermissionRuleApplication, applied: boolean, now: number): void {
    const key = permissionRuleApplicationKey(application);
    const database = this.database();
    database.transaction(() => {
      const applications = database.rows(PERMISSION_RULE_APPLICATIONS_STORE);
      const current = parseStoredApplication(parseJson(applications.get(key)));
      if (!current || current.state !== "claimed") return;
      applications.put(
        key,
        JSON.stringify({
          ...current,
          state: applied ? "applied" : "failed",
        } satisfies StoredApplication),
      );
      if (!applied || !database.hasStore(PERMISSION_RULES_STORE)) return;
      const rules = database.rows(PERMISSION_RULES_STORE);
      const rule = parsePermissionRule(parseJson(rules.get(application.ruleId)));
      if (!rule) return;
      rules.put(
        rule.id,
        JSON.stringify({
          ...rule,
          lastUsedAt: Math.max(now, rule.lastUsedAt ?? 0),
          useCount: Math.min(Number.MAX_SAFE_INTEGER, rule.useCount + 1),
        } satisfies NativeAgentPermissionRule),
      );
    });
    this.options.announce?.(application.ruleId);
  }

  /** Requests rules answered, oldest first, optionally of one environment or session. */
  listApplications(
    filter: { environmentId?: string; agent?: string; logicalSessionKey?: string } = {},
  ): PermissionRuleApplication[] {
    const database = this.database();
    if (!database.hasStore(PERMISSION_RULE_APPLICATIONS_STORE)) return [];
    const entries = database
      .rows(PERMISSION_RULE_APPLICATIONS_STORE)
      .list({ values: true, ...(filter.environmentId ? { owner: filter.environmentId } : {}) });
    const applications: PermissionRuleApplication[] = [];
    for (const entry of entries) {
      const stored = parseStoredApplication(parseJson(entry.value ?? undefined));
      if (!stored || stored.state !== "applied") continue;
      if (filter.environmentId && stored.environmentId !== filter.environmentId) continue;
      if (filter.agent && stored.agent !== filter.agent) continue;
      if (filter.logicalSessionKey && stored.logicalSessionKey !== filter.logicalSessionKey) {
        continue;
      }
      const { state: _state, ...application } = stored;
      applications.push(application);
    }
    return applications.sort((left, right) => left.appliedAt - right.appliedAt);
  }
}
