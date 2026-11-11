import { describe, expect, test } from "bun:test";
import {
  interactiveCaptures,
  parseOptions,
  perMinute,
} from "../../scripts/tmux-interactive-orphan-live";

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
});
