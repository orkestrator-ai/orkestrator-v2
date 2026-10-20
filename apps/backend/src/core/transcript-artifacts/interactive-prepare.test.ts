import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";

import { INTERACTIVE_HTML_POLICY } from "@orkestrator/protocol/rich-content-policy";

import {
  ARTIFACT_DEPENDENCY_MANIFEST,
  PinnedBundleError,
  loadPinnedBundle,
  pinnedBundleCandidates,
  sha256Hex,
  RENDERER_BUNDLES,
} from "./dependency-manifest.js";
import {
  buildInteractiveCsp,
  escapeInlineScript,
  inlineScriptHash,
  rebindFrameAncestors,
} from "./interactive-csp.js";
import {
  TranscriptInteractivePreparer,
  collectExecutableScripts,
  decodeAttributeValue,
} from "./interactive-prepare.js";

const fixture = (name: string) =>
  readFileSync(path.join(import.meta.dir, "fixtures", name), "utf8");
const ANCESTORS = ["http://127.0.0.1:*", "https://app.example.com"];
const preparer = new TranscriptInteractivePreparer({ frameAncestors: ANCESTORS });

function prepare(html: string, extra: Partial<Parameters<typeof preparer.prepare>[0]> = {}) {
  return preparer.prepare({
    artifactId: "art_fixture01",
    revision: 1,
    html,
    dependencyIds: [],
    assets: [],
    ...extra,
  });
}

async function codes(html: string, extra: Partial<Parameters<typeof preparer.prepare>[0]> = {}) {
  const result = await prepare(html, extra);
  if (result.ok) return [];
  return result.diagnostics.filter((d) => d.severity === "error").map((d) => d.code);
}

const PNG_1x1 = Uint8Array.from(
  Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
    "base64",
  ),
);

describe("interactive preparation", () => {
  test("is deterministic and keeps authored code", async () => {
    const html = fixture("calculator.html");
    const first = await prepare(html);
    const second = await prepare(html);
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(first.prepared.document).toBe(second.prepared.document);
    expect(first.prepared.documentSha256).toBe(second.prepared.documentSha256);
    expect(first.prepared.contentSecurityPolicy).toBe(second.prepared.contentSecurityPolicy);
    expect(first.prepared.sourceSha256).toBe(sha256Hex(html));
    expect(first.prepared.documentSha256).toBe(sha256Hex(first.prepared.document));
    expect(first.prepared.byteLength).toBe(Buffer.byteLength(first.prepared.document));
    expect(first.prepared.document).toContain('tasks.addEventListener("input", update)');
    // A different revision has a different readiness nonce and runtime identity.
    const other = await preparer.prepare({
      artifactId: "art_fixture01",
      revision: 2,
      html,
      dependencyIds: [],
      assets: [],
    });
    expect(other.ok && other.prepared.readinessNonce).not.toBe(first.prepared.readinessNonce);
  });

  test("publish re-resolves the same dependency identity a preview recorded", async () => {
    // Regression: publish once compared a receipt's resolved-list identity
    // with the whole-manifest hash, so no interactive artifact could publish.
    for (const dependencyIds of [[], ["d3@7.9.0"]]) {
      const result = await prepare(fixture("calculator.html"), { dependencyIds });
      expect(result.ok).toBe(true);
      if (!result.ok) continue;
      expect(preparer.dependencyManifestHash(dependencyIds)).toBe(
        result.prepared.dependencyManifestHash,
      );
    }
    expect(preparer.dependencyManifestHash(["left-pad@1.0.0"])).toStartWith("unresolvable:");
    expect(preparer.dependencyManifestHash([])).not.toBe(
      preparer.dependencyManifestHash(["d3@7.9.0"]),
    );
  });

  test("CSP authorizes exactly the serialized scripts and nothing else", async () => {
    const result = await prepare(fixture("calculator.html"));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const { contentSecurityPolicy: csp, scriptHashes, document } = result.prepared;
    const scripts = await collectExecutableScripts(document);
    expect(scripts.length).toBe(2); // runtime + authored
    expect(new Set(scripts.map(inlineScriptHash))).toEqual(new Set(scriptHashes));
    for (const hash of scriptHashes) expect(csp).toContain(hash);
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("script-src-attr 'none'");
    expect(csp).toContain("connect-src 'none'");
    expect(csp).toContain("sandbox allow-scripts");
    expect(csp).toContain("frame-ancestors http://127.0.0.1:* https://app.example.com");
    expect(csp).not.toMatch(/unsafe-eval|wasm-unsafe-eval|\*;|https?:\/\/\*|'self'/);
    expect(csp).not.toMatch(/script-src[^;]*https?:/);
  });

  test("escapes closing script tags in injected code and hashes the escaped bytes", async () => {
    const hostile = 'window.x = "</script><script>alert(1)</script>"; /* <!-- <script> */';
    const escaped = escapeInlineScript(hostile);
    expect(escaped).not.toMatch(/<\/script/i);
    expect(escaped).not.toContain("<!--");
    const document = `<!doctype html><head><script>${escaped}</script></head><body></body>`;
    const scripts = await collectExecutableScripts(document);
    expect(scripts).toEqual([escaped]);
    // The hash a browser computes is over the escaped text, which is what we authorize.
    expect(inlineScriptHash(scripts[0]!)).toBe(inlineScriptHash(escaped));
    // Escaping is an identity for JavaScript string semantics.
    expect(new Function(escaped.replace("window.x =", "return"))()).toBe(
      "</script><script>alert(1)</script>",
    );
    // Authored script text that contains "</scr" + "ipt" in a string is split by the author and kept verbatim.
    const authored = await prepare('<script>const s = "<\\/script>"; document.title = s;</script>');
    expect(authored.ok).toBe(true);
    if (authored.ok) {
      const parsed = await collectExecutableScripts(authored.prepared.document);
      expect(parsed[parsed.length - 1]).toBe('const s = "<\\/script>"; document.title = s;');
      expect(authored.prepared.scriptHashes).toContain(
        inlineScriptHash(parsed[parsed.length - 1]!),
      );
    }
  });

  test("rejects an external script with a structured diagnostic", async () => {
    const result = await prepare('<script src="https://cdn.example.com/x.js"></script>');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("policy_denied");
    expect(result.diagnostics[0]).toMatchObject({
      severity: "error",
      code: "external_script",
      location: "element 1 <script>",
    });
    expect(result.diagnostics[0]!.message).toContain("pinned dependency");
  });

  test("rejects static and dynamic imports", async () => {
    expect(
      await codes(
        '<script type="module">import * as d3 from "https://cdn.example.com/d3.js"; d3;</script>',
      ),
    ).toEqual(["unresolved_import"]);
    expect(await codes('<script>import("./x.js").then(() => 1)</script>')).toEqual([
      "unresolved_import",
    ]);
    expect(await codes("<script>const x = require('fs');</script>")).toEqual(["unresolved_import"]);
    expect(await codes("<script>const = ;</script>")).toEqual(["script_syntax"]);
  });

  test("rejects external CSS including escaped url, comments, @import and image-set", async () => {
    expect(await codes("<style>body{background:url(https://x.example/a.png)}</style>")).toEqual([
      "external_css",
    ]);
    expect(await codes("<style>body{background:u\\72l(https://x.example/a.png)}</style>")).toEqual([
      "external_css",
    ]);
    expect(await codes('<style>@import "https://x.example/a.css";</style>')).toEqual([
      "external_css",
    ]);
    expect(
      await codes('<style>a{background-image:image-set("https://x.example/a.png" 1x)}</style>'),
    ).toEqual(["external_css"]);
    expect(await codes('<p style="background:url(//x.example/a.png)">x</p>')).toEqual([
      "external_css",
    ]);
    expect(await codes('<p style="background:u&#114;l(//x.example/a.png)">x</p>')).toEqual([
      "external_css",
    ]);
    expect(await codes("<style>a{background:url(data:image/png;base64,AAAA)}</style>")).toEqual([]);
  });

  test("rejects inline handlers with a corrective suggestion", async () => {
    const result = await prepare('<button onclick="go()">Go</button>');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.diagnostics[0]!.code).toBe("inline_handler");
    expect(result.diagnostics[0]!.message).toContain('addEventListener("click"');
  });

  test("rejects base, meta refresh, nested browsing contexts and javascript URLs", async () => {
    expect(await codes('<base href="https://x.example/">')).toEqual(["base_element"]);
    expect(await codes('<meta http-equiv="refresh" content="0;url=https://x.example">')).toEqual([
      "meta_refresh",
    ]);
    expect(await codes('<iframe src="https://x.example"></iframe>')).toContain(
      "nested_browsing_context",
    );
    expect(await codes('<object data="x.swf"></object>')).toContain("nested_browsing_context");
    expect(await codes('<embed src="x">')).toContain("nested_browsing_context");
    expect(await codes('<a href="javascript:alert(1)">x</a>')).toEqual(["executable_url"]);
    expect(await codes('<a href="jav&#x61;script:alert(1)">x</a>')).toEqual(["executable_url"]);
    expect(await codes('<link rel="preload" href="https://x.example/a.js" as="script">')).toEqual([
      "resource_hint",
    ]);
    expect(await codes('<link rel="stylesheet" href="https://x.example/a.css">')).toEqual([
      "external_stylesheet",
    ]);
    expect(await codes('<img src="https://x.example/a.png">')).toEqual(["external_resource"]);
    expect(await codes('<img srcset="a.png 1x, https://x.example/b.png 2x">')).toEqual([
      "external_resource",
    ]);
    expect(await codes('<a href="https://x.example" ping="https://x.example/p">x</a>')).toEqual([
      "external_resource",
    ]);
    expect(await codes('<script type="importmap">{"imports":{}}</script>')).toEqual([
      "unsupported_script_type",
    ]);
    expect(await codes("<svg><script>alert(1)</script></svg>")).toEqual(["svg_script"]);
  });

  test("removes author CSP metadata with a warning and keeps navigation links as warnings", async () => {
    const result = await prepare(
      '<head><meta http-equiv="Content-Security-Policy" content="default-src *"></head><body><a href="https://example.com">x</a></body>',
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.prepared.document).not.toContain("http-equiv");
    expect(result.prepared.diagnostics.map((d) => d.code)).toEqual([
      "author_policy_removed",
      "navigation_link",
    ]);
  });

  test("rewrites artifact-asset references to bounded data URLs", async () => {
    const asset = {
      name: "dot.png",
      mimeType: "image/png",
      bytes: PNG_1x1,
      sha256: sha256Hex(PNG_1x1),
    };
    const result = await prepare(
      '<img alt="dot" src="artifact-asset:dot.png"><div style="background:url(artifact-asset:dot.png)"></div><style>.x{background:url("artifact-asset:dot.png")}</style>',
      { assets: [asset] },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.prepared.document).not.toContain("artifact-asset:");
    expect(result.prepared.document.match(/data:image\/png;base64,/g)?.length).toBe(3);
    expect(await codes('<img src="artifact-asset:missing.png">', { assets: [asset] })).toEqual([
      "unknown_asset",
    ]);
    // MIME is checked by magic bytes, and integrity by hash.
    const fake = new TextEncoder().encode("not a png");
    expect(
      await codes("<p>x</p>", {
        assets: [{ name: "a.png", mimeType: "image/png", bytes: fake, sha256: sha256Hex(fake) }],
      }),
    ).toEqual(["asset_type_mismatch"]);
    expect(await codes("<p>x</p>", { assets: [{ ...asset, sha256: "0".repeat(64) }] })).toEqual([
      "asset_integrity",
    ]);
    expect(await codes("<p>x</p>", { assets: [{ ...asset, mimeType: "text/html" }] })).toEqual([
      "unsupported_asset_type",
    ]);
  });

  test("enforces authored, asset, dependency and prepared size limits at and over the bound", async () => {
    const shell = "<p>x</p><!---->";
    const pad = (bytes: number) => shell + " ".repeat(bytes - Buffer.byteLength(shell));
    const atLimit = await prepare(pad(INTERACTIVE_HTML_POLICY.maxAuthoredBytes));
    expect(atLimit.ok).toBe(true);
    const over = await prepare(pad(INTERACTIVE_HTML_POLICY.maxAuthoredBytes + 1));
    expect(over.ok).toBe(false);
    if (!over.ok) {
      expect(over.error.code).toBe("package_size_exceeded");
      expect(over.error.message).toContain(String(INTERACTIVE_HTML_POLICY.maxAuthoredBytes + 1));
    }
    const blob = (size: number) => {
      return new Uint8Array(size).fill(0x61);
    };
    const chunk = INTERACTIVE_HTML_POLICY.maxAssetBytesTotal / 2;
    const assets = [0, 1].map((index) => {
      const bytes = blob(chunk);
      return { name: `a${index}.txt`, mimeType: "text/plain", bytes, sha256: sha256Hex(bytes) };
    });
    const atAssets = await prepare("<p>x</p>", { assets });
    expect(atAssets.ok).toBe(true);
    const extra = blob(1);
    const overAssets = await prepare("<p>x</p>", {
      assets: [
        ...assets,
        { name: "b.txt", mimeType: "text/plain", bytes: extra, sha256: sha256Hex(extra) },
      ],
    });
    expect(overAssets.ok).toBe(false);
    if (!overAssets.ok) expect(overAssets.error.code).toBe("package_size_exceeded");
    const tooMany = Array.from({ length: INTERACTIVE_HTML_POLICY.maxAssets + 1 }, (_, index) => {
      const bytes = blob(8);
      return { name: `n${index}.txt`, mimeType: "text/plain", bytes, sha256: sha256Hex(bytes) };
    });
    expect((await prepare("<p>x</p>", { assets: tooMany })).ok).toBe(false);
    expect(
      (await prepare("<p>x</p>", { assets: tooMany.slice(0, INTERACTIVE_HTML_POLICY.maxAssets) }))
        .ok,
    ).toBe(true);
    const deps = await prepare("<p>x</p>", {
      dependencyIds: Array(INTERACTIVE_HTML_POLICY.maxDependencies + 1).fill("d3@7.9.0"),
    });
    expect(deps.ok).toBe(false);
    if (!deps.ok) expect(deps.error.code).toBe("package_size_exceeded");
    expect(await codes("<p>x</p>", { dependencyIds: ["left-pad@1.0.0"] })).toEqual([
      "unknown_dependency",
    ]);

    // Prepared-document bound: dependency bytes count toward the 16 MiB total.
    const big = new TextEncoder().encode(
      `/*${"x".repeat(INTERACTIVE_HTML_POLICY.maxPreparedBytes)}*/`,
    );
    const heavy = new TranscriptInteractivePreparer({
      frameAncestors: ANCESTORS,
      loadDependency: async () => big,
    });
    const heavyResult = await heavy.prepare({
      artifactId: "art_fixture01",
      revision: 1,
      html: "<p>x</p>",
      dependencyIds: ["d3@7.9.0"],
      assets: [],
    });
    expect(heavyResult.ok).toBe(false);
    if (!heavyResult.ok) {
      expect(heavyResult.error.code).toBe("package_size_exceeded");
      expect(heavyResult.error.resource).toBe("prepared-bytes");
    }
  });

  test("packages the pinned d3 dependency with its identity before authored scripts", async () => {
    const result = await prepare(fixture("d3-bars.html"), { dependencyIds: ["d3@7.9.0"] });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.prepared.resolvedDependencies).toEqual([
      {
        id: "d3@7.9.0",
        version: "7.9.0",
        sha256: ARTIFACT_DEPENDENCY_MANIFEST[0]!.sha256,
        license: "ISC",
      },
    ]);
    const scripts = await collectExecutableScripts(result.prepared.document);
    expect(scripts.length).toBe(3);
    expect(scripts[1]).toContain("https://d3js.org v7.9.0");
    expect(scripts[2]).toContain('d3.select("#chart")');
    expect(result.prepared.dependencyManifestHash).toMatch(/^[0-9a-f]{64}$/);
    expect(preparer.dependencyManifestHash()).toMatch(/^[0-9a-f]{64}$/);
  });

  test("pinned bundles verify integrity and fail closed", async () => {
    for (const bundle of [
      ...ARTIFACT_DEPENDENCY_MANIFEST,
      RENDERER_BUNDLES.mermaid,
      RENDERER_BUNDLES.dompurify,
    ]) {
      const bytes = await loadPinnedBundle(bundle);
      expect(sha256Hex(bytes)).toBe(bundle.sha256);
    }
    const tampered = {
      ...ARTIFACT_DEPENDENCY_MANIFEST[0]!,
      id: "d3-tampered",
      sha256: "0".repeat(64),
    };
    await expect(loadPinnedBundle(tampered)).rejects.toBeInstanceOf(PinnedBundleError);
    await expect(
      loadPinnedBundle({
        ...tampered,
        id: "missing",
        packageName: "no-such-package",
        distName: "none.js",
      }),
    ).rejects.toMatchObject({
      reason: "missing",
    });
    expect(pinnedBundleCandidates(ARTIFACT_DEPENDENCY_MANIFEST[0]!, "/opt/x")[0]).toBe(
      "/opt/x/artifact-runtime/d3.min.js",
    );
  });

  test("CSP generation and frame-ancestor rebinding only accept generated policies", () => {
    const csp = buildInteractiveCsp([inlineScriptHash("a")], ["http://127.0.0.1:*"]);
    expect(rebindFrameAncestors(csp, ["https://app.example.com"])).toContain(
      "frame-ancestors https://app.example.com",
    );
    expect(() => rebindFrameAncestors(`${csp}; script-src 'unsafe-eval'`, [])).toThrow();
    expect(() =>
      rebindFrameAncestors(csp.replace("connect-src 'none'", "connect-src *"), []),
    ).toThrow();
    expect(() => buildInteractiveCsp([], ["*"])).toThrow();
    expect(() => buildInteractiveCsp([], ["https://*.example.com"])).toThrow();
    expect(() => buildInteractiveCsp([], ["https://example.com:*"])).toThrow();
    expect(buildInteractiveCsp([], [])).toContain("frame-ancestors 'none'");
  });

  test("attribute decoding is conservative", () => {
    expect(decodeAttributeValue("a&amp;b")).toBe("a&b");
    expect(decodeAttributeValue("&#106;avascript&colon;")).toBe("javascript:");
    expect(decodeAttributeValue("&unknownentity;")).toBeNull();
  });
});

test("authored HTML string literals survive rewriting and script serialization", async () => {
  const source =
    'document.body.innerHTML = `<section><span class="x">漢字 &amp; 😀</span></section>`;';
  const result = await prepare(`<html><body><script>${source}</script></body></html>`);
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  const scripts = await collectExecutableScripts(result.prepared.document);
  expect(scripts).toContain(source);
  expect(result.prepared.scriptHashes).toContain(inlineScriptHash(source));
});
