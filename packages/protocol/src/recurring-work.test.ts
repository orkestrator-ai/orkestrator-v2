import { describe, expect, test } from "bun:test";
import {
  RECURRING_DURATION_BUCKETS_MS,
  RECURRING_ERROR_CATEGORIES,
  RECURRING_IN_FLIGHT_POLICIES,
  RECURRING_JOB_CATALOGUE,
  RECURRING_JOB_KINDS,
  RECURRING_PRIORITY_CLASSES,
  RECURRING_RECOVERY_CONTRACTS,
  RECURRING_TRIGGERS,
  RECURRING_WORK_OWNERS,
  RECURRING_WORK_UNITS,
  isRecurringJobKind,
  isRecurringPriorityClass,
  isRecurringWorkUnit,
  recurringPriorityRank,
} from "./recurring-work";

describe("recurring-work vocabulary", () => {
  test("every kind has exactly one catalogue entry drawn from the fixed vocabularies", () => {
    expect(new Set(RECURRING_JOB_KINDS).size).toBe(RECURRING_JOB_KINDS.length);
    expect(Object.keys(RECURRING_JOB_CATALOGUE).toSorted()).toEqual(
      [...RECURRING_JOB_KINDS].toSorted(),
    );
    for (const kind of RECURRING_JOB_KINDS) {
      const entry = RECURRING_JOB_CATALOGUE[kind];
      expect(RECURRING_WORK_OWNERS).toContain(entry.owner);
      expect(RECURRING_TRIGGERS).toContain(entry.trigger);
      expect(RECURRING_PRIORITY_CLASSES).toContain(entry.priority);
      expect(RECURRING_IN_FLIGHT_POLICIES).toContain(entry.inFlight);
      expect(RECURRING_RECOVERY_CONTRACTS).toContain(entry.recovery);
      expect(entry.inventory).toMatch(/^[BCLF]\d{2}(,[BCLF]\d{2})*$/);
      if (entry.nominalCadenceMs !== null) expect(entry.nominalCadenceMs).toBeGreaterThan(0);
      // Only the backend records in-process today.
      if (entry.owner !== "backend") expect(entry.instrumented).toBe(false);
    }
  });

  test("labels are short, lowercase and free of separators that could smuggle content", () => {
    for (const label of [
      ...RECURRING_JOB_KINDS,
      ...RECURRING_WORK_UNITS,
      ...RECURRING_ERROR_CATEGORIES,
      ...RECURRING_PRIORITY_CLASSES,
    ]) {
      expect(label).toMatch(/^[a-z][a-z0-9-]{1,40}$/);
    }
  });

  test("guards accept only vocabulary members", () => {
    expect(isRecurringJobKind("diff-scan")).toBe(true);
    expect(isRecurringJobKind("diff-scan/../../etc")).toBe(false);
    expect(isRecurringJobKind(undefined)).toBe(false);
    expect(isRecurringWorkUnit("git-spawn")).toBe(true);
    expect(isRecurringWorkUnit("git")).toBe(false);
    expect(isRecurringPriorityClass("critical")).toBe(true);
    expect(isRecurringPriorityClass("urgent")).toBe(false);
  });

  test("priority ranks put critical first and maintenance last; buckets ascend", () => {
    expect(recurringPriorityRank("critical")).toBe(0);
    expect(recurringPriorityRank("interactive")).toBeLessThan(recurringPriorityRank("discovery"));
    expect(recurringPriorityRank("maintenance")).toBe(RECURRING_PRIORITY_CLASSES.length - 1);
    expect([...RECURRING_DURATION_BUCKETS_MS]).toEqual(
      [...RECURRING_DURATION_BUCKETS_MS].toSorted((left, right) => left - right),
    );
  });
});
