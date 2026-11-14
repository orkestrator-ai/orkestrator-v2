import { describe, expect, test } from "bun:test";
import { parseLogLevels } from "@orkestrator/protocol/node/logger-environment";
import { autoPipelineLogLevel, parseAutoPipelineArguments } from "./auto-pipeline-arguments.js";
import { SUPERVISED_FLAG } from "./owner-supervisor.js";

describe("test:agent:auto-pipeline arguments", () => {
  test("defaults to one reviewer, unsupervised", () => {
    expect(parseAutoPipelineArguments([], SUPERVISED_FLAG)).toEqual({
      supervised: false,
      reviewers: "1",
    });
  });

  test.each(["1", "2", "3", "4"])("accepts --reviewers %s", (count) => {
    expect(parseAutoPipelineArguments(["--reviewers", count], SUPERVISED_FLAG)).toEqual({
      supervised: false,
      reviewers: count,
    });
  });

  test("reads the supervised child's arguments the parent forwards", () => {
    // The parent re-runs itself as `[SUPERVISED_FLAG, "--reviewers", n]`.
    expect(
      parseAutoPipelineArguments([SUPERVISED_FLAG, "--reviewers", "4"], SUPERVISED_FLAG),
    ).toEqual({ supervised: true, reviewers: "4" });
    expect(parseAutoPipelineArguments([SUPERVISED_FLAG], SUPERVISED_FLAG)).toEqual({
      supervised: true,
      reviewers: "1",
    });
  });

  test.each([["0"], ["5"], ["two"], ["-1"], ["1.5"], ["04"], [""]])(
    "refuses --reviewers %p",
    (count) => {
      expect(() => parseAutoPipelineArguments(["--reviewers", count], SUPERVISED_FLAG)).toThrow(
        "--reviewers takes a count from 1 to 4",
      );
    },
  );

  test("refuses a missing count, other flags and arguments out of order", () => {
    expect(() => parseAutoPipelineArguments(["--reviewers"], SUPERVISED_FLAG)).toThrow(
      "--reviewers takes a count from 1 to 4",
    );
    expect(() => parseAutoPipelineArguments(["--reviewer", "2"], SUPERVISED_FLAG)).toThrow(
      "takes only --reviewers <n> (got --reviewer)",
    );
    expect(() =>
      parseAutoPipelineArguments(["--reviewers", "2", "--headless"], SUPERVISED_FLAG),
    ).toThrow("(got --headless)");
    // The supervised flag is only ever first.
    expect(() =>
      parseAutoPipelineArguments(["--reviewers", "2", SUPERVISED_FLAG], SUPERVISED_FLAG),
    ).toThrow(`(got ${SUPERVISED_FLAG})`);
  });

  test("does not change the caller's argv", () => {
    const argv = [SUPERVISED_FLAG, "--reviewers", "3"];
    parseAutoPipelineArguments(argv, SUPERVISED_FLAG);
    expect(argv).toEqual([SUPERVISED_FLAG, "--reviewers", "3"]);
  });
});

describe("test:agent:auto-pipeline log level", () => {
  test("sets build-pipeline to debug when the caller set nothing", () => {
    expect(autoPipelineLogLevel(undefined)).toBe("build-pipeline=debug");
    expect(autoPipelineLogLevel("")).toBe("build-pipeline=debug");
    expect(parseLogLevels(autoPipelineLogLevel(undefined))).toEqual({
      areaLevels: { "build-pipeline": "debug" },
      invalid: [],
    });
  });

  test("keeps the caller's levels and overrides only its build-pipeline level", () => {
    const merged = autoPipelineLogLevel("warn,build-pipeline=error,docker=trace");
    expect(merged).toBe("warn,build-pipeline=error,docker=trace,build-pipeline=debug");
    // The logger takes the last entry for an area, so the debug level holds.
    expect(parseLogLevels(merged)).toEqual({
      level: "warn",
      areaLevels: { "build-pipeline": "debug", docker: "trace" },
      invalid: [],
    });
  });
});
