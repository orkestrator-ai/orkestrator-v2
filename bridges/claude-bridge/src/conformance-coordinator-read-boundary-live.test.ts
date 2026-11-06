/**
 * Offline qualification of the read boundary on the pinned CLI: the real OS
 * sandbox and the real hook, a fixture data directory and a scripted model.
 * No provider turn, and nothing here reads a real credential.
 */
import { describe, expect, test } from "bun:test";
import {
  OWN_RESULT,
  qualifyReadBoundary,
  SECRET,
  type BoundaryFixture,
} from "../test-fixtures/coordinator-read-boundary-qualification.js";

const supported = process.platform === "darwin" || process.platform === "linux";
const bash = (command: string) => ({
  name: "Bash",
  input: { command, description: "Read boundary fixture" },
});
// The fixture's data directory has a space, like macOS's. The sandbox scenarios
// have no hook, so quoting is theirs to use.
const quoted = (path: string) => `cat '${path}'`;

describe("Claude read boundary: the OS sandbox alone", () => {
  // The control: this is what the rule below takes away.
  (supported ? test : test.skip)(
    "reads the fixture credentials when no boundary is set",
    async () => {
      const outcomes = await qualifyReadBoundary(
        "sandbox-without-boundary",
        (fixture: BoundaryFixture) => [bash(quoted(fixture.secrets.credentials))],
      );
      expect(outcomes[0]!.isError).toBe(false);
      expect(outcomes[0]!.output).toContain(SECRET);
    },
    60_000,
  );
  (supported ? test : test.skip)(
    "refuses a command reading the operator credentials, the database, a login or another conversation",
    async () => {
      const outcomes = await qualifyReadBoundary("sandbox-only", (fixture: BoundaryFixture) =>
        Object.values(fixture.secrets).map((path) => bash(quoted(path))),
      );
      for (const outcome of outcomes) {
        expect(outcome.isError).toBe(true);
        expect(outcome.output).not.toContain(SECRET);
      }
    },
    60_000,
  );
  (supported ? test : test.skip)(
    "lets a command read this conversation's own tool results, memory and attachments",
    async () => {
      const outcomes = await qualifyReadBoundary("sandbox-only", (fixture: BoundaryFixture) =>
        Object.values(fixture.own).map((path) => bash(quoted(path))),
      );
      for (const outcome of outcomes) {
        expect(outcome.isError).toBe(false);
        expect(outcome.output).toContain(OWN_RESULT);
      }
    },
    60_000,
  );
});

describe("Claude read boundary: the hook on the CLI's own tools", () => {
  (supported ? test : test.skip)(
    "refuses Read, Grep and Glob on the data directory, however it is named",
    async () => {
      const outcomes = await qualifyReadBoundary("hook-and-sandbox", (fixture: BoundaryFixture) => [
        { name: "Read", input: { file_path: fixture.secrets.credentials } },
        { name: "Read", input: { file_path: fixture.link } },
        { name: "Read", input: { file_path: fixture.secrets.otherRuntime } },
        { name: "Grep", input: { pattern: "CREDENTIAL", path: fixture.dataDir } },
        { name: "Glob", input: { pattern: "*.json", path: fixture.dataDir } },
      ]);
      for (const outcome of outcomes) {
        expect(outcome.isError).toBe(true);
        expect(outcome.output).toContain("data directory");
        expect(outcome.output).not.toContain(SECRET);
      }
    },
    60_000,
  );
  (supported ? test : test.skip)(
    "leaves Read and Grep working on this conversation's saved results and memory",
    async () => {
      const outcomes = await qualifyReadBoundary("hook-and-sandbox", (fixture: BoundaryFixture) => [
        { name: "Read", input: { file_path: fixture.own.toolResult } },
        { name: "Read", input: { file_path: fixture.own.memory } },
        { name: "Read", input: { file_path: fixture.own.attachment } },
        {
          name: "Grep",
          input: {
            pattern: OWN_RESULT,
            path: fixture.own.memory,
            output_mode: "content",
          },
        },
      ]);
      for (const outcome of outcomes) {
        expect(outcome.isError).toBe(false);
        expect(outcome.output).toContain(OWN_RESULT);
      }
    },
    60_000,
  );
});

describe("Claude read boundary: the hook with no sandbox behind it", () => {
  // No quoting, so a path with no space, as on Linux: the fixture's parent names it.
  test("refuses a command naming the operator credentials", async () => {
    const outcomes = await qualifyReadBoundary("hook-only", (fixture: BoundaryFixture) => [
      bash(`cat ${fixture.link}`),
    ]);
    expect(outcomes[0]!.isError).toBe(true);
    expect(outcomes[0]!.output).toContain("data directory");
    expect(outcomes[0]!.output).not.toContain(SECRET);
  }, 60_000);
});
