import { describe, expect, test } from "bun:test";
import {
  burnerSource,
  DEFAULT_BURNERS,
  parseArguments,
  UsageError,
} from "../../scripts/test-under-contention";

describe("test-under-contention argument parsing", () => {
  test("defaults to six burners on the last core with no duration", () => {
    expect(parseArguments(["--", "bun", "test", "x.test.ts"])).toEqual({
      burners: DEFAULT_BURNERS,
      command: ["bun", "test", "x.test.ts"],
    });
  });

  test("reads every option, in either spelling, before the separator", () => {
    expect(
      parseArguments(["--core", "3", "--burners=2", "--duration", "40", "--", "true"]),
    ).toEqual({ core: 3, burners: 2, durationSeconds: 40, command: ["true"] });
  });

  test("starts the command at the first non-option when Bun dropped the separator", () => {
    expect(parseArguments(["bun", "test", "--rerun-each=5"]).command).toEqual([
      "bun",
      "test",
      "--rerun-each=5",
    ]);
    // Flags after the separator belong to the command, even ones the runner knows.
    expect(parseArguments(["--burners", "1", "--", "cmd", "--core", "9"])).toEqual({
      burners: 1,
      command: ["cmd", "--core", "9"],
    });
  });

  test.each([
    [["--core", "-1", "--", "true"], /--core needs a whole number/],
    [["--burners", "two", "--", "true"], /--burners needs a whole number/],
    [["--duration", "0", "--", "true"], /--duration must be at least 1/],
    [["--duration"], /--duration needs a whole number, got nothing/],
    [["--bogus", "--", "true"], /Unknown option --bogus/],
    [["--burners", "2"], /No command given/],
    [["--"], /No command given/],
  ])("rejects %j", (argv, message) => {
    expect(() => parseArguments(argv)).toThrow(UsageError);
    expect(() => parseArguments(argv)).toThrow(message);
  });
});

describe("burner source", () => {
  test("stops on its own at the deadline or when its parent changes", () => {
    const source = burnerSource(30);
    expect(source).toContain("Date.now() + 30000");
    expect(source).toContain("process.ppid !== parent");
    // It must parse as a script; a syntax error would leave the command uncontended.
    expect(() => new Function(source)).not.toThrow();
  });
});
