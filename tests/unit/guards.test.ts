import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  REPOSITORY_GUARDS,
  runGuards,
  runRegisterTests,
  type RepositoryGuard,
} from "../../scripts/guards";

// `mise run guards` itself is the check of the real repository; these tests
// cover the runner with stand-in guards.
describe("the guard stage runner", () => {
  const guard = (id: string, run: RepositoryGuard["run"]): RepositoryGuard => ({
    id,
    description: id,
    advice: `advice for ${id}`,
    run,
  });

  test("passes when every guard passes, sharing one listing", async () => {
    const lines: string[] = [];
    const listings = new Set<unknown>();
    const status = await runGuards({
      guards: [
        guard("a", ({ index }) => {
          listings.add(index);
          return index.files.includes("package.json") ? [] : ["no package.json"];
        }),
        guard("b", ({ index }) => {
          listings.add(index);
          return [];
        }),
      ],
      registerTests: false,
      log: (line) => lines.push(line),
    });
    expect(status).toBe(0);
    expect(listings.size).toBe(1);
    expect(lines.join("\n")).toContain("All 2 guards passed");
  });

  test("fails with every failing guard's problems and advice, and a throwing guard fails", async () => {
    const lines: string[] = [];
    const status = await runGuards({
      guards: [
        guard("passes", () => []),
        guard("finds", () => ["first problem", "second problem"]),
        guard("throws", () => {
          throw new Error("does not parse");
        }),
      ],
      registerTests: false,
      log: (line) => lines.push(line),
    });
    const output = lines.join("\n");
    expect(status).toBe(1);
    expect(output).toContain("PASS passes");
    expect(output).toContain("FAIL finds");
    expect(output).toContain("first problem\nsecond problem");
    expect(output).toContain("What to do: advice for finds");
    expect(output).toContain("the guard threw: does not parse");
    expect(output).toContain("Guards failed: finds, throws");
  });

  test("every guard says what it holds and what to do", () => {
    const ids = REPOSITORY_GUARDS.map((entry) => entry.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const entry of REPOSITORY_GUARDS) {
      expect(entry.description.length).toBeGreaterThan(10);
      expect(entry.advice.length).toBeGreaterThan(40);
    }
  });
});

// The register tests run as a real Bun child; these cover that subprocess
// path with fixtures, since the runner tests above leave it out.
describe("the documentation register subprocess", () => {
  const directories: string[] = [];
  afterEach(() => {
    for (const directory of directories.splice(0))
      rmSync(directory, { recursive: true, force: true });
  });
  const fixtureDirectory = () => {
    const directory = mkdtempSync(path.join(tmpdir(), "guards-register-"));
    directories.push(directory);
    return directory;
  };

  test("a failing register test file fails the outcome with its report", async () => {
    const directory = fixtureDirectory();
    writeFileSync(
      path.join(directory, "register.test.ts"),
      'import { expect, test } from "bun:test";\n' +
        'test("register row", () => { expect("stale row").toBe("current row"); });\n',
    );
    const outcome = await runRegisterTests(directory, {
      args: ["test", "./register.test.ts", "--only-failures"],
    });
    expect(outcome.id).toBe("doc-registers");
    expect(outcome.problems).toHaveLength(1);
    expect(outcome.problems[0]).toContain("register row");
  });

  test("a passing register run has no problems", async () => {
    const directory = fixtureDirectory();
    writeFileSync(
      path.join(directory, "register.test.ts"),
      'import { expect, test } from "bun:test";\ntest("ok", () => { expect(1).toBe(1); });\n',
    );
    const outcome = await runRegisterTests(directory, { args: ["test", "./register.test.ts"] });
    expect(outcome.problems).toEqual([]);
  });

  test("a command that cannot be spawned fails rather than passing", async () => {
    const directory = fixtureDirectory();
    const outcome = await runRegisterTests(directory, {
      command: path.join(directory, "missing-bun"),
      args: ["test"],
    });
    expect(outcome.problems).toHaveLength(1);
    expect(outcome.problems[0]).toMatch(/ENOENT|no such file/i);
  });

  test("a child that outlives the deadline is killed and fails the outcome", async () => {
    const directory = fixtureDirectory();
    // The child never exits by itself, so only the deadline can end it.
    const outcome = await runRegisterTests(directory, {
      args: ["-e", "setInterval(() => {}, 1_000)"],
      timeoutMs: 100,
    });
    expect(outcome.problems).toEqual(["bun test did not finish within 100 ms"]);
  });

  test("a failing register child fails the whole guard stage", async () => {
    const lines: string[] = [];
    const status = await runGuards({
      guards: [],
      registerTests: { args: ["-e", "console.log('stale register row'); process.exit(1)"] },
      log: (line) => lines.push(line),
    });
    const output = lines.join("\n");
    expect(status).toBe(1);
    expect(output).toContain("FAIL doc-registers");
    expect(output).toContain("stale register row");
    expect(output).toContain("Guards failed: doc-registers");
  });
});
