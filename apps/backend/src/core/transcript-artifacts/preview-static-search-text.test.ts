/**
 * A static verification reads the document's text for Find in the real
 * worker, with real Chromium, from the effective HTML it stores (to-do 5780).
 * Browser cases skip with a warning when no Chromium executable resolves.
 *
 * The container case runs the same verification in the prepared worker image
 * (the staged Node bundle, the production default where Docker is available;
 * to-do 7670 (retired)). It skips with a warning unless Docker answers and the
 * image `ORKESTRATOR_ARTIFACT_PREVIEW_IMAGE` (default the worker's own tag)
 * exists and its bundled worker reads search text; build it with
 * docker/artifact-preview-worker/build.sh. An image prepared before to-do 5780
 * carries the same tag without that step, so the case probes the bundle, as
 * preview-print.test.ts probes for pdf.js, rather than trusting the tag.
 */
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";

import { STATIC_PRESENTATION_POLICY } from "@orkestrator/protocol/rich-content-policy";
import { DEFAULT_PREVIEW_PROFILE } from "@orkestrator/protocol/transcript-artifacts-validation";

import { resolveDesignChromiumPath } from "../design/index.js";
import type { PreviewJobResult } from "./contracts.js";
import { previewTestScratchRoot } from "./fixtures/preview-scratch-root.js";
import { TranscriptPreviewRunner } from "./preview-runner.js";
import { WORKER_CONTEXT_LABEL } from "./preview-worker-context-digest.js";
import {
  DEFAULT_PREVIEW_WORKER_IMAGE,
  PREVIEW_WORKER_USER,
  resolveSeccompProfile,
} from "./runtime.js";

// Docker and Chromium are real processes; Bun's 5 s default is too short under load.
setDefaultTimeout(30_000);

const CHROMIUM = resolveDesignChromiumPath();
if (!CHROMIUM)
  console.warn(
    "[preview-static-search-text.test] browser cases skipped: no Chromium executable (set ORKESTRATOR_DESIGN_CHROMIUM_PATH)",
  );
const browserTest = CHROMIUM ? test : test.skip;
const IMAGE = process.env.ORKESTRATOR_ARTIFACT_PREVIEW_IMAGE ?? DEFAULT_PREVIEW_WORKER_IMAGE;
/**
 * Whether the image's bundled worker has the static search-text step (it
 * stores `result.searchText` from `staticHtmlDocumentText`). Probed with the
 * image's own Node and no network, so a stale image skips instead of failing.
 */
const WORKER_BUNDLE = "/opt/artifact-preview-worker/preview-worker.mjs";
const imageReadsSearchText =
  spawnSync(
    "docker",
    [
      "run",
      "--rm",
      "--network",
      "none",
      "--entrypoint",
      "node",
      IMAGE,
      "-e",
      `const src = require("fs").readFileSync(${JSON.stringify(WORKER_BUNDLE)}, "utf8");` +
        `process.exit(/staticHtmlDocumentText/.test(src) && /\\.searchText\\s*=/.test(src) ? 0 : 1);`,
    ],
    { stdio: "ignore", timeout: 60_000 },
  ).status === 0;
const imageContext = imageReadsSearchText
  ? spawnSync(
      "docker",
      ["image", "inspect", "--format", `{{index .Config.Labels "${WORKER_CONTEXT_LABEL}"}}`, IMAGE],
      { encoding: "utf8", timeout: 30_000 },
    ).stdout?.trim() || "(no label)"
  : null;
if (!imageReadsSearchText)
  console.warn(
    `[preview-static-search-text.test] container case skipped: Docker or a worker image ${IMAGE} that reads search text is unavailable (rebuild it with docker/artifact-preview-worker/build.sh)`,
  );
const containerTest = imageReadsSearchText && CHROMIUM ? test : test.skip;

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

async function verify(html: string, through: TranscriptPreviewRunner = runner) {
  const result: PreviewJobResult = await through.run(
    { kind: "html-static", html, profile: DEFAULT_PREVIEW_PROFILE },
    scope(),
    new AbortController().signal,
  );
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  if (result.kind !== "html-static") throw new Error(`unexpected ${result.kind}`);
  return result;
}

const REPORT = `<!doctype html><html><head><title>Not body</title>
        <style>.x { color: red }</style></head><body>
        <h1>Quarterly <b>re</b>port</h1>
        <p>Revenue   grew
          😀</p>
        <details><summary>Method</summary>Closed body</details>
        <div hidden>never</div><noscript>no script</noscript>
        <script>document.body.append("ran")</script>
        <table><tr><td>a</td><td>b</td></tr></table>
      </body></html>`;
const REPORT_TEXT = "Quarterly report\nRevenue grew 😀\nMethod\nClosed body\na\nb";

describe("static verification", () => {
  browserTest(
    "reads the effective document's text with the frame's walk",
    async () => {
      const result = await verify(REPORT);
      expect(result.effectiveHtml).not.toContain("<script");
      expect(result.searchText).toBe(REPORT_TEXT);
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

describe("container worker", () => {
  containerTest(
    "reads the same text inside the prepared worker image",
    async () => {
      process.stderr.write(
        `preview-static-search-text: container image ${IMAGE}, context ${imageContext}\n`,
      );
      const container = new TranscriptPreviewRunner({
        isolation: "container",
        container: {
          docker: "docker",
          image: IMAGE,
          seccompProfile: resolveSeccompProfile()!,
          user: PREVIEW_WORKER_USER,
        },
      });
      try {
        const inside = await verify(REPORT, container);
        const local = await verify(REPORT);
        expect(inside.searchText).toBe(REPORT_TEXT);
        // The same sanitized document, so the same stored text, in either boundary.
        expect(inside.effectiveHtml).toBe(local.effectiveHtml);
        expect(inside.searchText).toBe(local.searchText);
        const limit = STATIC_PRESENTATION_POLICY.maxSearchTextCharacters;
        const bounded = await verify(`<p>${"x".repeat(limit + 10)}</p>`, container);
        expect(bounded.searchText).toHaveLength(limit);
      } finally {
        await container.close();
      }
    },
    180_000,
  );
});
