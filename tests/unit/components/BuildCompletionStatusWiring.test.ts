import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";

const repoRoot = path.resolve(import.meta.dir, "../../..");

/**
 * The banner is the only surface for a terminal hand-off the backend failed at
 * and never retries — an unposted issue comment, or a kanban card stranded in
 * the wrong column. Dropping it from the build tab makes those failures
 * completely invisible, which no rendering test would notice.
 */
describe("build completion status wiring", () => {
  for (const relativePath of [
    "apps/web/src/components/build-pipeline/BuildChatTab.tsx",
  ]) {
    test(`${relativePath} renders the persisted failure and retry status`, () => {
      const source = fs.readFileSync(path.join(repoRoot, relativePath), "utf8");
      expect(source).toContain(
        'import { BuildCompletionStatus } from "./BuildCompletionStatus";',
      );
      expect(source).toContain("<BuildCompletionStatus pipeline={pipeline} />");
    });
  }
});
