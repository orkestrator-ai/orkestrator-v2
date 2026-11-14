import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DESKTOP_STARTUP_EVENTS } from "../debug-logging.js";
import { MAX_BRIDGE_DIAGNOSTIC_BYTES } from "./bridge.js";
import type { EssentialLogEvent, LogAreaSpec } from "./define.js";
import { COMMAND_FAILURE_REASONS, LOG_VOCABULARY } from "./index.js";

const NAME_GRAMMAR = /^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)*$/;
const areas = LOG_VOCABULARY as Readonly<Record<string, LogAreaSpec>>;

const essentialEvents = Object.entries(areas).flatMap(([area, spec]) =>
  Object.entries(spec.events).flatMap(([event, definition]) =>
    typeof definition === "object" ? [{ name: `${area} ${event}`, definition }] : [],
  ),
);

/**
 * What the app keeps with every setting off. Changing this list changes that
 * stance, so a new entry is a decision to review, here and in the logging guide.
 */
const CURATED_ESSENTIAL_EVENTS = [
  "backend previous-run",
  "backend shutdown.finished",
  "backend shutdown.signal-received",
  "backend starting",
  "bridge.claude query.failed",
  "bridge.cursor session.resume-fell-back",
  "bridge.pi session.resume-fell-back",
  "desktop backend.exited",
  "desktop backend.exited-recovering",
  "desktop backend.start-failed",
  "desktop main-thread.stalled",
  "desktop uncaught-exception",
  "docker bridge.launched",
  "docker bridge.listener-refused",
  "docker bridge.listener-unrecorded",
  "docker writer-lease.acquired-late",
  "docker writer-lease.lost",
  "docker writer-lease.not-acquired",
  "docker writer-lease.regained",
  "event-loop stalled",
  "local-server bridge.exited",
  "local-server bridge.orphans-reaped",
  "local-server bridge.started",
  "logging entries.dropped",
  "logging essential.started",
  "logging essential.stopped",
  "process rejection.unhandled",
  "process uncaught-exception",
  "renderer-errors error.recorded",
  "review consolidation.budget-exceeded",
  "storage migration.failed",
  "storage operation.slow",
  "storage snapshot.failed",
  "storage snapshot.integrity-failed",
];

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
      for (const definition of Object.values(spec.events)) {
        const description = typeof definition === "string" ? definition : definition.description;
        expect(description.length).toBeGreaterThan(10);
      }
    }
  });

  test("an event description never includes a placeholder for dynamic text", () => {
    for (const spec of Object.values(areas)) {
      for (const event of Object.keys(spec.events)) expect(event).not.toMatch(/[{}$<>%]/);
    }
  });

  test("only a bridge diagnostic snapshot may exceed the string bound", () => {
    const wider = Object.entries(areas).filter(([, spec]) => spec.maxStringChars !== undefined);
    expect(wider.map(([area]) => area)).toEqual(["bridge.diagnostics"]);
    expect(areas["bridge.diagnostics"]!.maxStringChars).toBe(MAX_BRIDGE_DIAGNOSTIC_BYTES);
  });

  test("the renderer's allowlisted startup markers are all listed", () => {
    expect(Object.keys(areas["desktop.startup"]!.events)).toEqual(
      expect.arrayContaining([...DESKTOP_STARTUP_EVENTS]),
    );
    expect(areas["desktop.startup"]!.tag).toBe("DesktopStartup");
  });
});

describe("essential events", () => {
  test("the list is exactly the curated one", () => {
    expect(essentialEvents.map(({ name }) => name).sort()).toEqual(CURATED_ESSENTIAL_EVENTS);
  });

  test("an event definition is a sentence or a flagged essential event, nothing in between", () => {
    for (const { definition } of essentialEvents) {
      expect((definition as EssentialLogEvent).essential).toBe(true);
    }
  });

  test("every field is a scalar kind", () => {
    for (const { name, definition } of essentialEvents) {
      for (const [field, kind] of Object.entries(definition.fields)) {
        expect(`${name} ${field} ${["number", "boolean", "label"].includes(kind)}`).toBe(
          `${name} ${field} true`,
        );
      }
    }
  });

  test("no field can hold an error's text, a path or other content", () => {
    const content =
      /(^|\.)(message|stack|cause|detail|text|path|file|directory|dir|cwd|url|prompt|content|output|stdout|stderr|cmd|command|args|spawnargs|token|password|secret|authorization|apikey|cookie|credentials)$/i;
    for (const { name, definition } of essentialEvents) {
      for (const field of Object.keys(definition.fields)) {
        expect(`${name} ${field} ${content.test(field)}`).toBe(`${name} ${field} false`);
      }
    }
  });

  test("an error can only be declared by its identity, not as a whole", () => {
    for (const { name, definition } of essentialEvents) {
      expect(`${name} ${Object.hasOwn(definition.fields, "error")}`).toBe(`${name} false`);
    }
  });

  test("the logging guide lists every essential event and no other", () => {
    const guide = readFileSync(
      join(import.meta.dir, "../../../../docs/architecture/logging.md"),
      "utf8",
    );
    const start = guide.indexOf("### What it holds");
    const section = guide.slice(start, guide.indexOf("\n### ", start + 1));
    const listed = Array.from(
      section.matchAll(/^\| `([\w.-]+)` \| `([\w.-]+)` \|/gm),
      (match) => `${match[1]} ${match[2]}`,
    );
    expect(listed.sort()).toEqual(CURATED_ESSENTIAL_EVENTS);
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
