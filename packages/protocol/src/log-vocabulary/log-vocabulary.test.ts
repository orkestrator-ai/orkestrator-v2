import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DESKTOP_STARTUP_EVENTS } from "../debug-logging.js";
import type { LogAreaSpec } from "./define.js";
import { COMMAND_FAILURE_REASONS, LOG_VOCABULARY } from "./index.js";

const NAME_GRAMMAR = /^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)*$/;
const areas = LOG_VOCABULARY as Readonly<Record<string, LogAreaSpec>>;

const DOMAIN_FILES = readdirSync(import.meta.dir).filter(
  (name) =>
    name.endsWith(".ts") &&
    !name.endsWith(".test.ts") &&
    !["define.ts", "index.ts", "command-failure-reasons.ts"].includes(name),
);

async function domainAreas(): Promise<Array<[file: string, area: string]>> {
  const claimed: Array<[string, string]> = [];
  for (const file of DOMAIN_FILES) {
    const module = (await import(join(import.meta.dir, file))) as Record<
      string,
      Record<string, LogAreaSpec>
    >;
    for (const exported of Object.values(module)) {
      for (const area of Object.keys(exported)) claimed.push([file, area]);
    }
  }
  return claimed;
}

describe("log vocabulary", () => {
  test("every domain file is registered in the index", async () => {
    const claimed = await domainAreas();
    expect(claimed.map(([, area]) => area).sort()).toEqual(Object.keys(areas).sort());
  });

  test("no two files claim one area, which the spread would silently overwrite", async () => {
    const claimed = (await domainAreas()).map(([, area]) => area);
    expect(new Set(claimed).size).toBe(claimed.length);
  });

  test("there is no catch-all area for migrated code to hide in", () => {
    for (const name of ["legacy", "misc", "general", "unknown", "other", "console"]) {
      expect(Object.keys(areas)).not.toContain(name);
    }
  });

  test("area and event names follow the grammar", () => {
    for (const [area, spec] of Object.entries(areas)) {
      expect(area).toMatch(NAME_GRAMMAR);
      for (const event of Object.keys(spec.events)) expect(event).toMatch(NAME_GRAMMAR);
    }
  });

  test("everything is documented", () => {
    for (const spec of Object.values(areas)) {
      expect(spec.description.length).toBeGreaterThan(10);
      expect(Object.keys(spec.events).length).toBeGreaterThan(0);
      for (const description of Object.values(spec.events)) {
        expect(description.length).toBeGreaterThan(10);
      }
    }
  });

  test("an event description never includes a placeholder for dynamic text", () => {
    for (const spec of Object.values(areas)) {
      for (const event of Object.keys(spec.events)) expect(event).not.toMatch(/[{}$<>%]/);
    }
  });

  test("the renderer's allowlisted startup markers are all listed", () => {
    expect(Object.keys(areas["desktop.startup"]!.events)).toEqual(
      expect.arrayContaining([...DESKTOP_STARTUP_EVENTS]),
    );
    expect(areas["desktop.startup"]!.tag).toBe("DesktopStartup");
  });
});

describe("command failure reasons", () => {
  const reasons = Object.entries(COMMAND_FAILURE_REASONS) as Array<[string, string]>;

  test("every reason follows the grammar, as a single word with no hierarchy", () => {
    for (const [reason] of reasons) {
      expect(reason).toMatch(NAME_GRAMMAR);
      expect(reason).not.toContain(".");
    }
  });

  test("every reason says what it means", () => {
    for (const [, description] of reasons) expect(description.length).toBeGreaterThan(10);
  });

  test("the fallback is listed", () => {
    expect(COMMAND_FAILURE_REASONS.unclassified.length).toBeGreaterThan(10);
  });

  test("the logging guide lists every reason and no other", () => {
    const guide = readFileSync(
      join(import.meta.dir, "../../../../docs/architecture/logging.md"),
      "utf8",
    );
    const section = guide.slice(guide.indexOf("### The reasons"));
    const listed = Array.from(section.matchAll(/^\| `([a-z-]+)` \|/gm), (match) => match[1]);
    expect(listed.sort()).toEqual(reasons.map(([reason]) => reason).sort());
  });
});
