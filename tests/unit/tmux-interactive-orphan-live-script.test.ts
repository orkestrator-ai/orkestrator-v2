import { describe, expect, test } from "bun:test";
import {
  interactiveCaptures,
  orphanFailures,
  parseOptions,
  perMinute,
  type OrphanWindow,
} from "../../scripts/tmux-interactive-orphan-live";

function orphanWindow(name: string, interactiveCapturesPerMinute: number): OrphanWindow {
  return {
    name,
    elapsedMs: 120_000,
    execsPerMinute: {},
    totalExecsPerMinute: 33 + interactiveCapturesPerMinute,
    interactiveCapturesPerMinute,
    interactiveDockerExecPerMinute: interactiveCapturesPerMinute,
    terminals: [],
    note: "",
  };
}

const measured = (leasedOrphan: number, unleased = 57.5, renewed = 56.5) => [
  orphanWindow("tab-only", 0),
  orphanWindow("unleased-orphan", unleased),
  orphanWindow("leased-renewed", renewed),
  orphanWindow("leased-orphan", leasedOrphan),
];

describe("tmux interactive orphan live script (to-do 7745, retired)", () => {
  test("parses its options and refuses impossible ones", () => {
    expect(
      parseOptions(["--profile", "orphan", "--window-ms", "60000", "--out", "x.json"]),
    ).toEqual({ profile: "orphan", windowMs: 60_000, out: "x.json" });
    expect(parseOptions(["--profile", "orphan"]).windowMs).toBe(120_000);
    expect(() => parseOptions([])).toThrow("--profile is required");
    expect(() => parseOptions(["--profile", "Bad Name"])).toThrow();
    expect(() => parseOptions(["--profile", "p", "--window-ms", "500"])).toThrow();
    expect(() => parseOptions(["--profile", "p", "--turns", "3"])).toThrow("Unknown option");
    expect(() => parseOptions(["--profile"])).toThrow("Missing value");
  });

  test("scales exec counts to a minute", () => {
    expect(perMinute({ "tmux capture-pane": 30, sh: 3 }, 30_000)).toEqual({
      "tmux capture-pane": 60,
      sh: 6,
    });
  });

  test("reads the interactive loop's attempts and their docker execs", () => {
    expect(
      interactiveCaptures({
        "tmux-interactive-capture": {
          started: 58.5,
          failed: 0,
          bytes: 0,
          units: { "docker-exec": 58.5 },
        },
      }),
    ).toEqual({ started: 58.5, dockerExec: 58.5 });
    expect(interactiveCaptures({})).toEqual({ started: 0, dockerExec: 0 });
  });

  test("passes only when the leased orphan stopped and the other windows captured", () => {
    const ok = { lapsedWhileRenewed: false, orphanRenewAfterLapse: false };
    expect(orphanFailures(measured(0), ok)).toEqual([]);
    // renew() detaches a lapsed terminal itself, so a late renewal answers
    // false even when the capture tick never reaped the orphan: its window
    // has to show the captures stopped.
    expect(orphanFailures(measured(57.5), ok)).toEqual([
      "leased orphan kept capturing after its lease",
    ]);
    expect(orphanFailures(measured(0, 0, 0), ok)).toEqual([
      "unleased-orphan window counted no captures",
      "leased-renewed window counted no captures",
    ]);
    expect(orphanFailures(measured(0).slice(0, 3), ok)).toEqual(["leased-orphan window missing"]);
    expect(
      orphanFailures(measured(0), { lapsedWhileRenewed: true, orphanRenewAfterLapse: true }),
    ).toEqual(["a renewed lease lapsed", "late renewal of the orphan was not refused"]);
    expect(
      orphanFailures(measured(0), { lapsedWhileRenewed: false, orphanRenewAfterLapse: undefined }),
    ).toEqual(["late renewal of the orphan was not refused"]);
  });
});
