import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

test("the local-discovery shell fixture contains no single quotes, including comments", () => {
  // Inspect the actual inline script without importing the slow suite or
  // starting its servers. An apostrophe anywhere would end its shell argument.
  const source = readFileSync(new URL("./local-discovery.test.ts", import.meta.url), "utf8");
  const scripts = Array.from(source.matchAll(/const script = `([^`]+)`;/g));
  expect(scripts).toHaveLength(1);
  expect(scripts[0]![1]).not.toContain("'");
});
