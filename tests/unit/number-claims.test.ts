import { afterEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";

// Two branches that each take "the next number" for a to-do or flake file in
// different folders pass todo-index and flaky-tests-index alone and collide
// once both merge (todo 7142 task 3). A claim file named by the number makes
// the two branches add the same path, so Git reports an add/add conflict and
// the second pull request cannot merge until it renumbers.
// docs/number-claims/README.md explains the rules.

const root = path.resolve(import.meta.dir, "../..");
const claimsRoot = path.join(root, "docs/number-claims");
const INDEX = "0000-index.md";
const README = "README.md";
const NUMBERED_FILE = /^(\d{4})-.+\.md$/;
const CLAIM_NAME = /^\d{4}$/;
const CLAIM_BODY = /^[a-z0-9-]+\/(\d{4})-[^/\s]+\.md$/;

// Claims are required from these numbers up. They sat just below the highest
// number in use when the claims were added; new numbers come from the top.
const REGISTERS = [
  { claims: "todo", register: "docs/todo", claimsFrom: 7500 },
  { claims: "flaky-tests", register: "docs/tests/flaky-tests", claimsFrom: 9800 },
] as const;

function numberedFiles(register: string): string[] {
  return readdirSync(register, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .flatMap((folder) =>
      readdirSync(path.join(register, folder.name))
        .filter((name) => NUMBERED_FILE.test(name) && name !== INDEX)
        .map((name) => `${folder.name}/${name}`),
    )
    .sort();
}

function readClaims(claims: string): { claims: Map<string, string>; problems: string[] } {
  const found = new Map<string, string>();
  const problems: string[] = [];
  if (!existsSync(claims)) return { claims: found, problems };
  for (const name of readdirSync(claims).sort()) {
    if (name === README) continue;
    if (!CLAIM_NAME.test(name)) {
      problems.push(`${name}: a claim is named by its four-digit number only`);
      continue;
    }
    const body = readFileSync(path.join(claims, name), "utf8").trim();
    const owner = body.match(CLAIM_BODY);
    if (!owner || owner[1] !== name) {
      problems.push(`${name}: must hold one line, the <folder>/${name}-<slug>.md that owns it`);
      continue;
    }
    found.set(name, body);
  }
  return { claims: found, problems };
}

/** Every reason the register and its claims disagree; empty when they match. */
function claimProblems(register: string, claimsDir: string, claimsFrom: number): string[] {
  const { claims, problems } = readClaims(claimsDir);
  const claimsName = path.basename(claimsDir);
  for (const file of numberedFiles(register)) {
    const id = path.basename(file).slice(0, 4);
    const claimed = claims.get(id);
    if (claimed === file) continue;
    if (claimed !== undefined) {
      problems.push(
        `${file}: number ${id} is claimed by ${claimed}; renumber this file to an unclaimed number`,
      );
    } else if (Number(id) >= claimsFrom) {
      problems.push(`${file}: add docs/number-claims/${claimsName}/${id} containing "${file}"`);
    }
  }
  return problems;
}

describe("number claims", () => {
  for (const { claims, register, claimsFrom } of REGISTERS) {
    test(`every ${register} file numbered ${claimsFrom} or above owns its claim`, () => {
      expect(
        claimProblems(path.join(root, register), path.join(claimsRoot, claims), claimsFrom),
      ).toEqual([]);
    });
  }

  test("only the registers' claim folders and the README sit in docs/number-claims", () => {
    expect(readdirSync(claimsRoot).sort()).toEqual(
      [README, ...REGISTERS.map((entry) => entry.claims)].sort(),
    );
  });
});

const fixtures: string[] = [];
afterEach(() => {
  for (const fixture of fixtures.splice(0)) rmSync(fixture, { recursive: true, force: true });
});

function write(directory: string, file: string, body = "") {
  const target = path.join(directory, file);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, body);
}

const THRESHOLD = 7500;

function fixture() {
  const directory = mkdtempSync(path.join(os.tmpdir(), "number-claims-"));
  fixtures.push(directory);
  write(directory, `register/area/${INDEX}`);
  write(directory, "register/area/0100-old.md");
  write(directory, "register/area/7500-first.md");
  write(directory, "register/other/7510-second.md");
  write(directory, `claims/${README}`, "# Claims\n");
  write(directory, "claims/7500", "area/7500-first.md\n");
  write(directory, "claims/7510", "other/7510-second.md\n");
  expect(check(directory)).toEqual([]);
  return directory;
}

function check(directory: string) {
  return claimProblems(path.join(directory, "register"), path.join(directory, "claims"), THRESHOLD);
}

describe("number claim guard fixtures", () => {
  test("rejects a planted duplicate number in another folder", () => {
    const directory = fixture();
    write(directory, "register/other/7500-duplicate.md");
    expect(check(directory)).toEqual([
      "other/7500-duplicate.md: number 7500 is claimed by area/7500-first.md; renumber this file to an unclaimed number",
    ]);
  });

  test("rejects a planted duplicate number in the same folder", () => {
    const directory = fixture();
    write(directory, "register/area/7510-duplicate.md");
    expect(check(directory)).toHaveLength(1);
  });

  test("rejects a new number with no claim and says which claim to add", () => {
    const directory = fixture();
    write(directory, "register/area/7520-new.md");
    expect(check(directory)).toEqual([
      'area/7520-new.md: add docs/number-claims/claims/7520 containing "area/7520-new.md"',
    ]);
  });

  test("rejects a file that reuses the number of a deleted file", () => {
    const directory = fixture();
    rmSync(path.join(directory, "register/area/7500-first.md"));
    expect(check(directory)).toEqual([]);
    write(directory, "register/area/7500-reused.md");
    expect(check(directory)).toHaveLength(1);
  });

  test("rejects a claim whose body names another number", () => {
    const directory = fixture();
    write(directory, "claims/7510", "area/7500-first.md\n");
    expect(check(directory).length).toBeGreaterThan(0);
  });

  test("rejects a claim file that is not named by a number", () => {
    const directory = fixture();
    write(directory, "claims/7520-new", "area/7520-new.md\n");
    expect(check(directory)).toEqual(["7520-new: a claim is named by its four-digit number only"]);
  });

  test("rejects a numbered file below the threshold that contradicts an existing claim", () => {
    const directory = fixture();
    write(directory, "claims/0200", "area/0200-claimed.md\n");
    write(directory, "register/other/0200-clash.md");
    expect(check(directory)).toHaveLength(1);
  });

  test("accepts an unclaimed file below the threshold", () => {
    const directory = fixture();
    write(directory, "register/other/0101-older.md");
    expect(check(directory)).toEqual([]);
  });
});
