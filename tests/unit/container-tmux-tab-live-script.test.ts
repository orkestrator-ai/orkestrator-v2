import { expect, test } from "bun:test";
import {
  dockerExecPerMinute,
  execLabel,
  parseOptions,
  windowRates,
} from "../../scripts/container-tmux-tab-live";
import {
  busyEnvironments,
  parseOptions as parseItemCountOptions,
} from "../../scripts/busy-item-counts-live";
import type { KindCounters } from "../../scripts/recurring-live-ab-summary";

const counters = (
  started: number,
  units: Record<string, number> = {},
  extra: Partial<KindCounters> = {},
): KindCounters => ({ started, changed: 0, failed: 0, bytes: 0, workUnits: units, ...extra });

test("window rates scale every moved counter to a minute and drop kinds that did not move", () => {
  const rates = windowRates(
    {
      "tmux-poll": counters(10, { "docker-exec": 10 }),
      "mail-presence": counters(5, { "storage-read": 5 }),
    },
    {
      "tmux-poll": counters(70, { "docker-exec": 130 }, { failed: 2 }),
      "mail-presence": counters(5, { "storage-read": 5 }),
      "diff-scan": counters(1, { "docker-exec": 1, git: 3 }, { bytes: 120 }),
    },
    120_000,
  );
  expect(rates).toEqual({
    "tmux-poll": { started: 30, failed: 1, bytes: 0, units: { "docker-exec": 60 } },
    "diff-scan": { started: 0.5, failed: 0, bytes: 60, units: { "docker-exec": 0.5, git: 1.5 } },
  });
  expect(dockerExecPerMinute(rates)).toBe(60.5);
});

test("a counter that went backwards fails the window instead of reporting a negative rate", () => {
  expect(() =>
    windowRates({ "tmux-poll": counters(10) }, { "tmux-poll": counters(3) }, 60_000),
  ).toThrow("Measurement counters reset or invalid: tmux-poll");
  expect(() =>
    windowRates(
      { "tmux-poll": counters(1, { "docker-exec": 9 }) },
      { "tmux-poll": counters(2, { "docker-exec": 4 }) },
      60_000,
    ),
  ).toThrow("reset or invalid");
  expect(() => windowRates({}, {}, 0)).toThrow("positive duration");
});

test("the container driver's options need a profile and validate every value", () => {
  expect(parseOptions(["--profile", "ctab", "--turns", "2", "--out", "x.json"])).toMatchObject({
    profile: "ctab",
    turns: 2,
    windowMs: 120_000,
    stoppedMs: 60_000,
    out: "x.json",
  });
  expect(() => parseOptions([])).toThrow("--profile is required");
  expect(() => parseOptions(["--profile", "Bad Name"])).toThrow("profile name");
  expect(() => parseOptions(["--profile", "p", "--checkout", "relative"])).toThrow("absolute");
  expect(() => parseOptions(["--profile", "p", "--turns", "0"])).toThrow("positive integer");
  expect(() => parseOptions(["--profile", "p", "--bogus", "1"])).toThrow("Unknown option");
});

test("the item-count driver stops only the busy driver's local environments", () => {
  expect(
    busyEnvironments([
      { name: "fixture-local", environmentType: "local" },
      { name: "busy-ask", environmentType: "local" },
      { name: "busy-3", environmentType: "local" },
      { name: "busy-container", environmentType: "containerized" },
      { environmentType: "local" },
    ]).map((environment) => environment.name),
  ).toEqual(["busy-ask", "busy-3"]);
  expect(parseItemCountOptions(["--profile", "q", "--window-ms", "1000"])).toMatchObject({
    profile: "q",
    windowMs: 1000,
  });
  expect(() => parseItemCountOptions(["--profile", "q", "--window-ms", "-1"])).toThrow(
    "positive integer",
  );
});

test("exec labels name the program without recording what it ran", () => {
  expect(execLabel("exec_start: tmux list-sessions -F #{session_name}")).toBe("tmux list-sessions");
  expect(execLabel("exec_start: sh -c if [ -f /tmp/x ]; then head -c 256 /tmp/x; fi")).toBe(
    "sh -c if",
  );
  expect(execLabel("exec_start: bash -lc \n set -e\n secret")).toBe("bash -c");
  expect(execLabel("exec_start: /usr/bin/test -f /tmp/orkestrator/settings.json")).toBe("test");
  expect(execLabel("exec_start: ps -A -o pid=,comm=")).toBe("ps");
});
