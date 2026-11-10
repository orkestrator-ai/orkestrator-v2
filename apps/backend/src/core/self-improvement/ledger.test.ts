import { afterEach, describe, expect, test } from "bun:test";
import { parseBundleFiles, type BundleData } from "./bundle.js";
import {
  applyLedgerChange,
  buildDigest,
  emptyLedger,
  judge,
  type LedgerEntry,
  listDigests,
  MAX_DIGESTS,
  saveDigest,
} from "./ledger.js";
import { extractSignals, type Signal } from "./signals.js";
import {
  bundleFiles,
  DAY,
  type EssentialLine,
  type FixtureBundle,
  HOUR,
  temporaryDirectory,
} from "./testing/fixtures.js";

const NOW = Date.parse("2026-11-09T12:00:00.000Z");
const cleanups: Array<() => void> = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

function load(bundle: FixtureBundle, sha = "a"): BundleData {
  const files = new Map(bundleFiles(bundle).map((file) => [file.name, Buffer.from(file.contents)]));
  return parseBundleFiles(files, sha.repeat(64).slice(0, 64));
}

function failures(at: number, count: number, spacing = HOUR): EssentialLine[] {
  return Array.from({ length: count }, (_, index) => ({
    at: at + index * spacing,
    level: "error" as const,
    area: "storage",
    event: "snapshot.failed",
    fields: { "error.code": "EIO" },
  }));
}

function starting(at: number, version: string): EssentialLine {
  return { at, level: "info", area: "backend", event: "starting", fields: { version } };
}

const SIGNATURE = "storage:snapshot.failed:EIO";

function entry(overrides: Partial<LedgerEntry>): LedgerEntry {
  return {
    signature: SIGNATURE,
    title: "storage snapshot.failed",
    source: "essential-log",
    status: "fixed",
    createdAt: new Date(NOW).toISOString(),
    updatedAt: new Date(NOW).toISOString(),
    fixedIn: "2.31.0",
    baseline: { digestId: "d0", at: "", value: 10, unit: "per day", kind: "rate" },
    observations: [],
    ...overrides,
  };
}

function judgeBundle(ledgerEntry: LedgerEntry, bundle: FixtureBundle) {
  const extracted = extractSignals(load(bundle));
  const signal: Signal | undefined = extracted.signals.find(
    (candidate) => candidate.signature === SIGNATURE,
  );
  return judge(ledgerEntry, signal, extracted.observedHours);
}

describe("verdicts", () => {
  test("awaits a deploy until the fixed version has run", () => {
    const result = judgeBundle(entry({}), {
      createdAt: NOW,
      essential: [starting(NOW - 3 * DAY, "2.30.0"), ...failures(NOW - 2 * DAY, 20)],
    });
    expect(result.verdict).toBe("awaiting-deploy");
  });

  test("awaits evidence until the fixed version was watched for a day", () => {
    const result = judgeBundle(entry({}), {
      createdAt: NOW,
      essential: [starting(NOW - 3 * DAY, "2.30.0"), starting(NOW - 5 * HOUR, "2.31.0")],
    });
    expect(result.verdict).toBe("awaiting-evidence");
    expect(result.post?.hours).toBe(5);
  });

  test("improved when the fixed versions are quiet, judged only on those versions", () => {
    const result = judgeBundle(entry({}), {
      createdAt: NOW,
      essential: [
        starting(NOW - 4 * DAY, "2.30.0"),
        ...failures(NOW - 4 * DAY + HOUR, 30),
        starting(NOW - 2 * DAY, "2.31.0"),
      ],
    });
    expect(result.verdict).toBe("improved");
    expect(result.post).toEqual({ value: 0, hours: 48 });
  });

  test("unchanged when the rate after the fix is near the baseline", () => {
    const result = judgeBundle(entry({}), {
      createdAt: NOW,
      essential: [
        starting(NOW - 2 * DAY, "2.31.0"),
        ...failures(NOW - 2 * DAY + HOUR, 20, 2 * HOUR),
      ],
    });
    expect(result.verdict).toBe("unchanged");
    expect(result.post?.value).toBe(10);
  });

  test("partly improved between the two thresholds", () => {
    const result = judgeBundle(entry({}), {
      createdAt: NOW,
      essential: [
        starting(NOW - 2 * DAY, "2.32.0"),
        ...failures(NOW - 2 * DAY + HOUR, 10, 4 * HOUR),
      ],
    });
    expect(result.verdict).toBe("partly-improved");
  });

  test("a verified fix regresses when the signal returns above half its baseline", () => {
    const quiet = judgeBundle(entry({ status: "verified" }), {
      createdAt: NOW,
      essential: [starting(NOW - 2 * DAY, "2.31.0"), ...failures(NOW - DAY, 2)],
    });
    expect(quiet.verdict).toBe("holding");
    const loud = judgeBundle(entry({ status: "verified" }), {
      createdAt: NOW,
      essential: [
        starting(NOW - 2 * DAY, "2.31.0"),
        ...failures(NOW - 2 * DAY + HOUR, 16, 2 * HOUR),
      ],
    });
    expect(loud.verdict).toBe("regressed");
  });

  test("tracking and ignored entries are observed but not judged", () => {
    expect(judgeBundle(entry({ status: "tracking" }), { createdAt: NOW }).verdict).toBe("tracking");
    expect(judgeBundle(entry({ status: "ignored" }), { createdAt: NOW }).verdict).toBe("ignored");
  });
});

describe("digests", () => {
  test("reports trends against the previous digest and what has gone", () => {
    const ledger = emptyLedger();
    const firstData = load(
      {
        createdAt: NOW - DAY,
        essential: [
          ...failures(NOW - 3 * DAY, 4, 12 * HOUR),
          {
            at: NOW - 2 * DAY,
            level: "warn",
            area: "docker",
            event: "writer-lease.lost",
            fields: { reason: "expired" },
          },
        ],
      },
      "a",
    );
    const first = buildDigest(firstData, extractSignals(firstData), null, ledger);
    expect(first.signals.every((signal) => signal.trend === "new")).toBe(true);

    const secondData = load(
      { createdAt: NOW, essential: failures(NOW - 3 * DAY, 12, 6 * HOUR) },
      "b",
    );
    const second = buildDigest(secondData, extractSignals(secondData), first, ledger);
    const failed = second.signals.find((signal) => signal.signature === SIGNATURE)!;
    expect(failed.trend).toBe("up");
    expect(second.gone.map((gone) => gone.signature)).toEqual(["docker:writer-lease.lost:expired"]);
    expect(second.previousDigestId).toBe(first.id);
  });

  test("records one observation per digest on each ledger entry, replacing a re-run", () => {
    const ledger = emptyLedger();
    ledger.entries[SIGNATURE] = entry({ status: "tracking" });
    const data = load({ createdAt: NOW, essential: failures(NOW - DAY, 3) });
    buildDigest(data, extractSignals(data), null, ledger);
    buildDigest(data, extractSignals(data), null, ledger);
    expect(ledger.entries[SIGNATURE]!.observations).toHaveLength(1);
    expect(ledger.entries[SIGNATURE]!.observations[0]!.verdict).toBe("tracking");
  });

  test("keeps at most the newest digests in the state directory", () => {
    const { dir, remove } = temporaryDirectory("improvement-digests-");
    cleanups.push(remove);
    const ledger = emptyLedger();
    for (let index = 0; index < MAX_DIGESTS + 2; index += 1) {
      const data = load(
        { createdAt: NOW - (MAX_DIGESTS + 2 - index) * HOUR },
        index.toString(16).padStart(2, "0"),
      );
      const digest = buildDigest(data, extractSignals(data), null, ledger);
      saveDigest(dir, digest, "# digest\n");
    }
    const digests = listDigests(dir);
    expect(digests).toHaveLength(MAX_DIGESTS);
    expect(Date.parse(digests[0]!.bundle.createdAt)).toBe(NOW - MAX_DIGESTS * HOUR);
  });
});

describe("ledger changes", () => {
  function savedDigest() {
    const data = load({ createdAt: NOW, essential: failures(NOW - 2 * DAY, 8, 6 * HOUR) });
    return buildDigest(data, extractSignals(data), null, emptyLedger());
  }

  test("a new entry takes its title, source and baseline from the newest digest that saw it", () => {
    const ledger = emptyLedger();
    const digest = savedDigest();
    const created = applyLedgerChange(ledger, SIGNATURE, { ticket: "412" }, [digest]);
    expect(created.status).toBe("tracking");
    expect(created.ticket).toBe("412");
    expect(created.source).toBe("essential-log");
    expect(created.baseline).toMatchObject({
      digestId: digest.id,
      value: 4,
      unit: "per day",
      kind: "rate",
    });
  });

  test("refuses a signature no digest has seen, and fixed without a version", () => {
    const ledger = emptyLedger();
    expect(() => applyLedgerChange(ledger, "nope:never", {}, [savedDigest()])).toThrow(
      /No saved digest/,
    );
    expect(() =>
      applyLedgerChange(ledger, SIGNATURE, { status: "fixed" }, [savedDigest()]),
    ).toThrow(/--fixed-in/);
    const fixed = applyLedgerChange(
      ledger,
      SIGNATURE,
      { status: "fixed", fixedIn: "v2.31.0", pr: "2050" },
      [savedDigest()],
    );
    expect(fixed.fixedIn).toBe("2.31.0");
  });

  test("refuses an unknown status and an overlong note", () => {
    const ledger = emptyLedger();
    expect(() =>
      applyLedgerChange(ledger, SIGNATURE, { status: "done" as never }, [savedDigest()]),
    ).toThrow(/Unknown status/);
    expect(() =>
      applyLedgerChange(ledger, SIGNATURE, { note: "x".repeat(501) }, [savedDigest()]),
    ).toThrow(/at most/);
  });
});
