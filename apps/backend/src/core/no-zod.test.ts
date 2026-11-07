import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

/**
 * The backend has one schema system, Effect Schema (plan item 7014). A Zod
 * import anywhere in the backend's sources, tests or scripts, or a `zod`
 * dependency, fails here; `tool-schema.ts` has the Effect equivalents.
 */
const BACKEND = path.resolve(import.meta.dir, "../..");
const ROOTS = ["src", "tests", "scripts"];
const ZOD_IMPORT =
  /(?:\bfrom\s*["']zod(?:\/[^"']*)?["'])|(?:\bimport\s*\(\s*["']zod(?:\/[^"']*)?["']\s*\))|(?:\brequire\s*\(\s*["']zod(?:\/[^"']*)?["']\s*\))|(?:^\s*import\s*["']zod(?:\/[^"']*)?["'])/m;

function sources(directory: string): string[] {
  let entries;
  try {
    entries = readdirSync(directory, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries.flatMap((entry) => {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) return entry.name === "node_modules" ? [] : sources(full);
    return /\.(?:[cm]?[jt]sx?)$/.test(entry.name) ? [full] : [];
  });
}

test("no backend file imports zod", () => {
  const importers = ROOTS.flatMap((root) => sources(path.join(BACKEND, root)))
    // This file spells the import forms out to test the pattern.
    .filter((file) => file !== import.meta.path && ZOD_IMPORT.test(readFileSync(file, "utf8")))
    .map((file) => path.relative(BACKEND, file));
  expect(importers).toEqual([]);
});

test("zod is not a backend dependency", () => {
  const manifest = JSON.parse(readFileSync(path.join(BACKEND, "package.json"), "utf8")) as Record<
    string,
    Record<string, string> | undefined
  >;
  const declared = [
    "dependencies",
    "devDependencies",
    "peerDependencies",
    "optionalDependencies",
  ].filter((field) => manifest[field]?.zod !== undefined);
  expect(declared).toEqual([]);
});

test("the pattern recognises every import form", () => {
  for (const source of [
    'import { z } from "zod";',
    "import * as z from 'zod/v4';",
    'const z = await import("zod");',
    'const z = require("zod");',
    'import "zod";',
    'export { z } from "zod";',
  ])
    expect(ZOD_IMPORT.test(source)).toBe(true);
  expect(ZOD_IMPORT.test('const name = "zod";')).toBe(false);
});
