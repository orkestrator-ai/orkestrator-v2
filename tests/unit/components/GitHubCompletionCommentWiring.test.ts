import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";

const repoRoot = path.resolve(import.meta.dir, "../../..");

describe("GitHub completion comment build-tab wiring", () => {
  for (const relativePath of [
    "apps/web/src/components/build-pipeline/BuildChatTab.tsx",
  ]) {
    test(`${relativePath} renders the persisted failure and retry status`, () => {
      const source = fs.readFileSync(path.join(repoRoot, relativePath), "utf8");
      expect(source).toContain(
        'import { GitHubCompletionCommentStatus } from "./GitHubCompletionCommentStatus";',
      );
      expect(source).toContain("<GitHubCompletionCommentStatus pipeline={pipeline} />");
    });
  }
});
