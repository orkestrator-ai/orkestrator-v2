import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import path from "node:path";

const root = path.resolve(import.meta.dir, "../../..");

describe("backend state review transcript", () => {
  test("does not contain developer-specific absolute home paths", async () => {
    const transcript = await readFile(
      path.join(root, "docs", "backend-state-review-transcript.md"),
      "utf8",
    );

    expect(transcript).not.toMatch(/\/Users\/[^/\s]+/);
    expect(transcript).not.toMatch(/\/home\/[^/\s]+/);
  });
});
