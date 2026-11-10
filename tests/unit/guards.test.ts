import { describe, expect, test } from "bun:test";
import { REPOSITORY_GUARDS, runGuards, type RepositoryGuard } from "../../scripts/guards";

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
