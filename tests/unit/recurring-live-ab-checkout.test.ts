import { describe, expect, test } from "bun:test";
import os from "node:os";
import path from "node:path";
import { checkoutEnv, parseOptions, profileArguments } from "../../scripts/recurring-live-ab";
import { collectSides, compareTable, range } from "../../scripts/recurring-live-ab-compare";
import {
  deliveryReads,
  kindDelta,
  parseOptions as parseMailOptions,
  profileClaudeDirectory,
} from "../../scripts/tmux-mail-inject-live";
import { summarizeWindow, type WindowSummary } from "../../scripts/recurring-live-ab-summary";

describe("before-and-after runs from another checkout", () => {
  test("parses the checkout, label and window", () => {
    const parsed = parseOptions([
      "--checkout",
      "/work/base",
      "--label",
      "base",
      "--window",
      "launcher-default",
    ]);
    expect(parsed).toMatchObject({
      checkout: "/work/base",
      label: "base",
      window: "launcher-default",
    });
    expect(parseOptions([]).window).toBe("hidden");
    expect(() => parseOptions(["--checkout", "relative/base"])).toThrow();
    expect(() => parseOptions(["--label", "Not A Label"])).toThrow();
    expect(() => parseOptions(["--window", "minimised"])).toThrow();
  });

  test("passes the window flag a launcher of that age understands", () => {
    const window = (value: string) => profileArguments("p", parseOptions(["--window", value]));
    expect(window("hidden")).toContain("--headless");
    expect(window("visible")).toContain("--no-headless");
    const older = window("launcher-default");
    expect(older).not.toContain("--headless");
    expect(older).not.toContain("--no-headless");
  });

  test("passes --no-host-seed unless --host-seed asks for the host's seed", () => {
    const isolated = profileArguments("p", parseOptions([]));
    expect(isolated).toContain("--no-host-seed");
    expect(isolated).toContain("--no-agent-credentials");
    const seeded = profileArguments("p", parseOptions(["--host-seed"]));
    expect(seeded).not.toContain("--no-host-seed");
    expect(seeded).not.toContain("--host-seed");
  });

  test("trusts the other checkout's mise config for its own processes only", () => {
    const base = { PATH: "/bin" };
    expect(checkoutEnv(undefined, base)).toBe(base);
    expect(checkoutEnv("/work/base", base)).toEqual({
      PATH: "/bin",
      MISE_TRUSTED_CONFIG_PATHS: "/work/base",
    });
    expect(base).toEqual({ PATH: "/bin" });
  });
});

const summary = (
  kinds: Record<string, { started: number; units?: Record<string, number> }>,
  cpu: number,
): WindowSummary => ({
  windowMs: 360_000,
  samples: 13,
  kinds: Object.fromEntries(
    Object.entries(kinds).map(([kind, rates]) => [
      kind,
      {
        observedMs: 360_000,
        partial: false,
        startedPerMinute: rates.started,
        changedPerMinute: 0,
        failedPerMinute: 0,
        bytesPerMinute: 0,
        workUnitsPerMinute: rates.units ?? {},
      },
    ]),
  ),
  processes: { backend: { cpuMsPerMinute: cpu, rssKiBMedian: 204_800, rssKiBMax: 204_800 } },
});

describe("comparing labelled artifacts", () => {
  test("groups runs by label, skips failed runs and shows each side's range", () => {
    const sides = collectSides([
      {
        commit: "aaa",
        label: "base",
        results: [
          {
            arm: "candidate",
            summary: summary({ "diff-scan": { started: 0.5, units: { "git-spawn": 4 } } }, 240),
          },
        ],
      },
      {
        commit: "aaa",
        label: "base",
        results: [
          {
            arm: "candidate",
            summary: summary({ "diff-scan": { started: 0.5, units: { "git-spawn": 3.5 } } }, 260),
          },
          { arm: "candidate", summary: null, error: "profile did not become ready in time" },
        ],
      },
      {
        commit: "bbb",
        results: [{ arm: "candidate", summary: summary({ "tab-cleanup": { started: 2 } }, 250) }],
      },
    ]);
    expect(sides.map((side) => [side.label, side.runs.length])).toEqual([
      ["base", 2],
      ["bbb", 1],
    ]);
    const table = compareTable(sides);
    expect(table).toContain("| diff-scan | git-spawn | 3.5–4 | 0 |");
    expect(table).toContain("| tab-cleanup | starts | 0 | 2 |");
    expect(table).toContain("| process | backend CPU ms/min | 240–260 | 250 |");
    expect(table).toContain("| process | backend RSS MiB, median | 200 | 200 |");
  });

  test("separates every arm and refuses missing arms or reused labels across commits", () => {
    const results = ["candidate", "rollback", "metrics-off"].map((arm, index) => ({
      arm,
      summary: summary({ scan: { started: index + 1 } }, 10),
    }));
    const sides = collectSides([{ label: "base", commit: "a", results }]);
    expect(sides.map((side) => side.arm)).toEqual(["candidate", "rollback", "metrics-off"]);
    expect(compareTable(sides)).toContain("base/candidate");
    expect(compareTable(sides)).toContain("| scan | starts | 1 | 2 | — |");
    expect(() => collectSides([{ results: [{ summary: summary({}, 10) }] }])).toThrow(
      "Missing experiment arm",
    );
    expect(() =>
      collectSides([
        { label: "base", commit: "a" },
        { label: "base", commit: "b" },
      ]),
    ).toThrow("Conflicting commits");
  });

  test("serialized resets, single observations and unmeasured windows never become zero", () => {
    const counters = (started: number) => ({
      started,
      changed: 0,
      failed: 0,
      bytes: 0,
      workUnits: { read: started },
    });
    const invalid = summarizeWindow([
      { atMs: 0, kinds: { reset: counters(4), once: counters(1) }, processes: {} },
      { atMs: 60_000, kinds: { reset: counters(2) }, processes: {} },
    ]);
    const unmeasured = summarizeWindow([{ atMs: 0, kinds: null, processes: {} }]);
    const table = compareTable(
      collectSides(
        JSON.parse(
          JSON.stringify([
            { commit: "a", results: [{ arm: "candidate", summary: invalid }] },
            { commit: "b", results: [{ arm: "candidate", summary: unmeasured }] },
          ]),
        ),
      ),
    );
    expect(table).toContain("| reset | starts | — | — |");
    expect(table).toContain("| reset | read | — | — |");
    expect(table).toContain("| once | starts | — | — |");
    expect(range([1, null])).toBe("—");
    expect(range([Number.NaN])).toBe("—");
  });

  test("prints a dash for no values", () => {
    expect(range([])).toBe("—");
    expect(range([1.234, 1.234])).toBe("1.23");
  });
});

describe("mail into a real claude-tmux tab", () => {
  test("needs a profile and positive counts", () => {
    expect(parseMailOptions(["--profile", "bg15", "--deliveries", "3"])).toMatchObject({
      profile: "bg15",
      deliveries: 3,
    });
    expect(() => parseMailOptions([])).toThrow();
    expect(() => parseMailOptions(["--profile", "bg15", "--deliveries", "0"])).toThrow();
    expect(() => parseMailOptions(["--profile", "bg15", "--checkout", "relative"])).toThrow();
  });

  test("charges every pass in a delivery window the idle pass's reads", () => {
    const delta = kindDelta(
      {
        "mail-injection": {
          started: 10,
          changed: 0,
          failed: 0,
          bytes: 0,
          workUnits: { "storage-read": 11 },
        },
      },
      {
        "mail-injection": {
          started: 13,
          changed: 0,
          failed: 0,
          bytes: 1_358,
          workUnits: { "storage-read": 36 },
        },
        "tmux-queue-drain": { started: 2, changed: 0, failed: 0, bytes: 0, workUnits: {} },
      },
    );
    expect(delta).toEqual({
      "mail-injection": { started: 3, storageReads: 25, bytes: 1_358 },
      "tmux-queue-drain": { started: 2, storageReads: 0, bytes: 0 },
    });
    expect(deliveryReads(delta["mail-injection"], 1.0667)).toBe(21.8);
    expect(() => deliveryReads(undefined, 1)).toThrow();
    expect(() => deliveryReads({ started: 0, storageReads: 4 }, 1)).toThrow();
  });

  test("writes only the profile's own Claude directory", () => {
    const dataDir = path.join("/dev-root", "profiles", "bg15", "data");
    expect(profileClaudeDirectory(dataDir, "bg15")).toBe(
      path.join(dataDir, "agent-credentials", "claude"),
    );
    expect(() => profileClaudeDirectory(dataDir, "other")).toThrow();
    expect(() => profileClaudeDirectory(os.homedir(), "bg15")).toThrow();
    expect(() =>
      profileClaudeDirectory(path.join("/Library", "orkestrator-v2", "data"), "bg15"),
    ).toThrow();
  });
});
