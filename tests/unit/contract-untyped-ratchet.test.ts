/**
 * The shrink-only ratchet on untyped backend commands (plan item 1011,
 * `scripts/contract-check.ts`): the committed manifest and baseline agree, a
 * new string-registered command fails `contract:check` with a pointer to the
 * docs, and the baseline is only ever rewritten downward.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  CONTRACT_DOCS,
  MANIFEST_PATH,
  UNTYPED_BASELINE_PATH,
  checkUntypedRatchet,
  compareUntypedCounts,
  lowerUntypedBaseline,
  parseArguments,
  parseUntypedBaseline,
  runContractCheck,
  serializeUntypedBaseline,
  untypedCountsFromManifest,
  type UntypedCounts,
} from "../../scripts/contract-check";

const root = path.resolve(import.meta.dir, "../..");
const temporaryDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

function manifestText(untypedByDomain: UntypedCounts): string {
  const untyped = Object.values(untypedByDomain).reduce((a, b) => a + b, 0);
  return `${JSON.stringify(
    {
      schemaVersion: 1,
      counts: { commands: untyped, defined: 0, untyped },
      untypedByDomain,
      domains: {},
      commands: {},
      events: {},
    },
    null,
    2,
  )}\n`;
}

async function files(manifest: UntypedCounts, baseline: UntypedCounts | null) {
  const dir = await mkdtemp(path.join(tmpdir(), "contract-ratchet-"));
  temporaryDirs.push(dir);
  const manifestPath = path.join(dir, "manifest.json");
  const baselinePath = path.join(dir, "untyped-baseline.json");
  await writeFile(manifestPath, manifestText(manifest));
  if (baseline) await writeFile(baselinePath, serializeUntypedBaseline(baseline));
  const lines: string[] = [];
  return { manifestPath, baselinePath, lines, log: (line: string) => lines.push(line) };
}

describe("the committed ratchet", () => {
  test("the baseline matches the manifest exactly: nothing rose, nothing is stale", () => {
    const actual = untypedCountsFromManifest(readFileSync(path.join(root, MANIFEST_PATH), "utf8"));
    const baselineText = readFileSync(path.join(root, UNTYPED_BASELINE_PATH), "utf8");
    const result = compareUntypedCounts(actual, parseUntypedBaseline(baselineText));
    expect(result).toEqual({ rises: [], stale: [] });
    expect(serializeUntypedBaseline(actual)).toBe(baselineText);
  });

  test("the docs anchor the failures name exists, and AGENTS.md points contract changes at it", () => {
    const [file, anchor] = CONTRACT_DOCS.split("#");
    expect(anchor).toBe("domain-contracts");
    expect(readFileSync(path.join(root, file!), "utf8")).toMatch(/^## Domain contracts$/m);
    expect(readFileSync(path.join(root, "AGENTS.md"), "utf8")).toContain(
      "(docs/architecture/version-compatibility.md#domain-contracts)",
    );
  });
});

describe("compareUntypedCounts", () => {
  const baseline = parseUntypedBaseline(serializeUntypedBaseline({ git: 3, kanban: 2 }));

  test("a domain above its baseline, or absent from it, is a rise", () => {
    expect(compareUntypedCounts({ git: 4, kanban: 2, mcp: 1 }, baseline).rises).toEqual([
      { domain: "git", allowed: 3, actual: 4 },
      { domain: "mcp", allowed: 0, actual: 1 },
    ]);
  });

  test("a domain below its baseline, or gone, is stale", () => {
    expect(compareUntypedCounts({ git: 1 }, baseline)).toEqual({
      rises: [],
      stale: [
        { domain: "git", allowed: 3, actual: 1 },
        { domain: "kanban", allowed: 2, actual: 0 },
      ],
    });
  });

  test("moving a command between domains is a rise even though the total is unchanged", () => {
    expect(compareUntypedCounts({ git: 4, kanban: 1 }, baseline).rises).toEqual([
      { domain: "git", allowed: 3, actual: 4 },
    ]);
  });
});

describe("runContractCheck", () => {
  test("a new string-registered command fails with a pointer to the docs", async () => {
    // The PR mapped the new command in contract-domain-map.ts and regenerated the
    // manifest, so the drift check passes and only the ratchet stands in the way.
    const setup = await files({ git: 4, kanban: 2 }, { git: 3, kanban: 2 });
    const status = await runContractCheck({ ...setup, checkManifest: async () => 0 });
    expect(status).toBe(1);
    const output = setup.lines.join("\n");
    expect(output).toContain("git: baseline 3, now 4");
    expect(output).toContain("defineCommand");
    expect(output).toContain(CONTRACT_DOCS);
  });

  test("a manifest drift failure also ends with the docs pointer, and the ratchet still runs", async () => {
    const setup = await files({ git: 3 }, { git: 3 });
    const status = await runContractCheck({
      ...setup,
      checkManifest: async (log) => {
        log("No contract domain for new_command: register it with defineCommand, or …");
        return 1;
      },
    });
    expect(status).toBe(1);
    expect(setup.lines).toContain(`${UNTYPED_BASELINE_PATH} matches: 3 untyped commands.`);
    expect(setup.lines.at(-1)).toContain(CONTRACT_DOCS);
  });

  test("a stale baseline fails and asks for the smaller one", async () => {
    const setup = await files({ git: 2 }, { git: 3 });
    expect(await runContractCheck({ ...setup, checkManifest: async () => 0 })).toBe(1);
    expect(setup.lines.join("\n")).toContain("mise run contract:manifest");
  });

  test("passes when the manifest is current and the counts match", async () => {
    const setup = await files({ git: 3 }, { git: 3 });
    expect(await runContractCheck({ ...setup, checkManifest: async () => 0 })).toBe(0);
  });

  test("a missing baseline fails", async () => {
    const setup = await files({ git: 3 }, null);
    expect(await checkUntypedRatchet(setup)).toBe(1);
    expect(setup.lines.join("\n")).toContain("is missing");
  });
});

describe("lowerUntypedBaseline", () => {
  test("writes the smaller counts, dropping domains with none left", async () => {
    const setup = await files({ git: 1, kanban: 0 }, { git: 3, kanban: 2 });
    expect(await lowerUntypedBaseline(setup)).toBe(0);
    const written = parseUntypedBaseline(await readFile(setup.baselinePath, "utf8"));
    expect(written).toEqual({ total: 1, untypedByDomain: { git: 1 } });
  });

  test("refuses to raise a domain and leaves the file unchanged", async () => {
    const setup = await files({ git: 4, kanban: 1 }, { git: 3, kanban: 2 });
    const before = await readFile(setup.baselinePath, "utf8");
    expect(await lowerUntypedBaseline(setup)).toBe(1);
    expect(await readFile(setup.baselinePath, "utf8")).toBe(before);
    expect(setup.lines.join("\n")).toContain(CONTRACT_DOCS);
  });

  test("writes a missing baseline from the manifest", async () => {
    const setup = await files({ git: 3 }, null);
    expect(await lowerUntypedBaseline(setup)).toBe(0);
    expect(existsSync(setup.baselinePath)).toBe(true);
    expect(await checkUntypedRatchet(setup)).toBe(0);
  });
});

describe("parsing", () => {
  test("refuses a baseline whose total is not the sum", () => {
    const text = serializeUntypedBaseline({ git: 3 }).replace('"total": 3', '"total": 4');
    expect(() => parseUntypedBaseline(text)).toThrow("total is not the sum");
  });

  test("refuses a manifest with an unknown schemaVersion or inconsistent totals", () => {
    const text = manifestText({ git: 3 });
    expect(() =>
      untypedCountsFromManifest(text.replace('"schemaVersion": 1', '"schemaVersion": 2')),
    ).toThrow("unknown schemaVersion 2");
    expect(() => untypedCountsFromManifest(text.replace('"untyped": 3', '"untyped": 2'))).toThrow(
      "counts.untyped does not match",
    );
  });

  test("refuses a negative or fractional count", () => {
    expect(() =>
      parseUntypedBaseline(
        JSON.stringify({ schemaVersion: 1, total: -1, untypedByDomain: { git: -1 } }),
      ),
    ).toThrow("not a count");
  });

  test("arguments", () => {
    expect(parseArguments([])).toEqual({ lowerBaseline: false });
    expect(parseArguments(["--lower-baseline"])).toEqual({ lowerBaseline: true });
    expect(() => parseArguments(["--raise"])).toThrow("usage");
  });
});
