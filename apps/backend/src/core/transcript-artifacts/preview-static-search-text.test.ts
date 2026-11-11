/**
 * A static verification reads the document's text for Find in the real
 * worker, with real Chromium, from the effective HTML it stores (to-do 5780).
 * Browser cases skip with a warning when no Chromium executable resolves.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { STATIC_PRESENTATION_POLICY } from "@orkestrator/protocol/rich-content-policy";
import { DEFAULT_PREVIEW_PROFILE } from "@orkestrator/protocol/transcript-artifacts-validation";

import { resolveDesignChromiumPath } from "../design/index.js";
import type { PreviewJobResult } from "./contracts.js";
import { previewTestScratchRoot } from "./fixtures/preview-scratch-root.js";
import { TranscriptPreviewRunner } from "./preview-runner.js";

const CHROMIUM = resolveDesignChromiumPath();
if (!CHROMIUM)
  console.warn(
    "[preview-static-search-text.test] browser cases skipped: no Chromium executable (set ORKESTRATOR_DESIGN_CHROMIUM_PATH)",
  );
const browserTest = CHROMIUM ? test : test.skip;

let runner: TranscriptPreviewRunner;
let operation = 0;
const scope = () => ({
  environmentId: `env-t${++operation}`,
  conversationKey: "conv",
  operationId: `op_text${String(operation).padStart(9, "0")}`,
});

beforeAll(() => {
  runner = new TranscriptPreviewRunner({
    isolation: "process",
    scratchRoot: previewTestScratchRoot(),
  });
});
afterAll(async () => {
  await runner?.close();
});

async function verify(html: string) {
  const result: PreviewJobResult = await runner.run(
    { kind: "html-static", html, profile: DEFAULT_PREVIEW_PROFILE },
    scope(),
    new AbortController().signal,
  );
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  if (result.kind !== "html-static") throw new Error(`unexpected ${result.kind}`);
  return result;
}

describe("static verification", () => {
  browserTest(
    "reads the effective document's text with the frame's walk",
    async () => {
      const result = await verify(`<!doctype html><html><head><title>Not body</title>
        <style>.x { color: red }</style></head><body>
        <h1>Quarterly <b>re</b>port</h1>
        <p>Revenue   grew
          😀</p>
        <details><summary>Method</summary>Closed body</details>
        <div hidden>never</div><noscript>no script</noscript>
        <script>document.body.append("ran")</script>
        <table><tr><td>a</td><td>b</td></tr></table>
      </body></html>`);
      expect(result.effectiveHtml).not.toContain("<script");
      expect(result.searchText).toBe(
        "Quarterly report\nRevenue grew 😀\nMethod\nClosed body\na\nb",
      );
    },
    60_000,
  );

  browserTest(
    "bounds the text to the frame's limit",
    async () => {
      const limit = STATIC_PRESENTATION_POLICY.maxSearchTextCharacters;
      const result = await verify(`<p>${"x".repeat(limit + 10)}</p>`);
      expect(result.searchText).toHaveLength(limit);
    },
    60_000,
  );
});
