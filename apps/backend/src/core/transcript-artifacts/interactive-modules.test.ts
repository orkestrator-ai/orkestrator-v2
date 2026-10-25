import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { INTERACTIVE_HTML_POLICY } from "@orkestrator/protocol/rich-content-policy";

import {
  ARTIFACT_DEPENDENCY_MANIFEST,
  findArtifactDependency,
  loadPinnedBundle,
  sha256Hex,
} from "./dependency-manifest.js";
import { inlineScriptHash } from "./interactive-csp.js";
import {
  MAX_MODULE_SCRIPTS,
  MODULE_BUNDLER_CONFIG,
  bundleModuleScript,
  moduleSpecifierTable,
  verifyMacrosDisabled,
} from "./interactive-modules.js";
import { TranscriptInteractivePreparer, collectExecutableScripts } from "./interactive-prepare.js";

const fixture = (name: string) =>
  readFileSync(path.join(import.meta.dir, "fixtures", name), "utf8");
const preparer = new TranscriptInteractivePreparer({ frameAncestors: ["http://127.0.0.1:*"] });
const D3 = findArtifactDependency("d3@7.9.0")!;
const CHART = findArtifactDependency("chart.js@4.5.1")!;

function prepare(html: string, dependencyIds: string[] = [], instance = preparer) {
  return instance.prepare({
    artifactId: "art_modules001",
    revision: 1,
    html,
    dependencyIds,
    assets: [],
  });
}

async function errors(html: string, dependencyIds: string[] = []) {
  const result = await prepare(html, dependencyIds);
  if (result.ok) return [];
  return result.diagnostics.filter((d) => d.severity === "error");
}

const codes = async (html: string, dependencyIds: string[] = []) =>
  (await errors(html, dependencyIds)).map((d) => d.code);

const scratch = mkdtempSync(path.join(tmpdir(), "ork-module-bundler-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

describe("dependency manifest for modules", () => {
  test("pins d3 and Chart.js with exact bytes, specifiers and shims", async () => {
    expect(ARTIFACT_DEPENDENCY_MANIFEST.map((entry) => entry.id)).toEqual([
      "d3@7.9.0",
      "chart.js@4.5.1",
    ]);
    expect(Array.from(moduleSpecifierTable().keys())).toEqual(["d3", "chart.js", "chart.js/auto"]);
    for (const dependency of ARTIFACT_DEPENDENCY_MANIFEST) {
      const bytes = await loadPinnedBundle(dependency);
      expect(sha256Hex(bytes)).toBe(dependency.sha256);
      // A shim only re-exports the global; it never names another module.
      expect(dependency.moduleShim).toContain(`globalThis.${dependency.global}`);
      expect(dependency.moduleShim).not.toMatch(/\bimport\b|\brequire\b/);
    }
    expect(CHART).toMatchObject({
      version: "4.5.1",
      packageFile: "dist/chart.umd.min.js",
      sha256: "48444a82d4edcb5bec0f1965faacdde18d9c17db3063d042abada2f705c9f54a",
      license: "MIT",
      global: "Chart",
    });
    expect(new TextDecoder().decode(await loadPinnedBundle(CHART))).toStartWith(
      "/*!\n * Chart.js v4.5.1",
    );
  });

  test("the bundler configuration is fixed and closed", () => {
    expect(MODULE_BUNDLER_CONFIG).toMatchObject({
      target: "browser",
      format: "esm",
      minify: false,
      sourcemap: "none",
      splitting: false,
      external: [],
      allowUnresolved: [],
      env: "disable",
      macros: false,
    });
    expect(Object.isFrozen(MODULE_BUNDLER_CONFIG)).toBe(true);
    expect("plugins" in MODULE_BUNDLER_CONFIG).toBe(false);
  });
});

describe("module script bundling", () => {
  test("d3 namespace import: bundled inline, after the verbatim pinned bytes, covered by the CSP", async () => {
    const result = await prepare(fixture("d3-module-bars.html"), ["d3@7.9.0"]);
    if (!result.ok) throw new Error(JSON.stringify(result.diagnostics));
    const { document, scriptHashes, contentSecurityPolicy } = result.prepared;
    const scripts = await collectExecutableScripts(document);
    expect(scripts).toHaveLength(3); // runtime, d3, module bundle
    // The pinned UMD runs byte for byte; the module only binds to its global.
    expect(scripts[1]).toBe(new TextDecoder().decode(await loadPinnedBundle(D3)));
    expect(scripts[2]).toContain("module.exports = globalThis.d3;");
    expect(scripts[2]).toContain('d3.select("#chart")');
    expect(scripts[2]).not.toMatch(/\bimport\s*[*{(]|from\s*"d3"/);
    expect(document).toContain('<script type="module">');
    expect(new Set(scripts.map(inlineScriptHash))).toEqual(new Set(scriptHashes));
    for (const hash of scriptHashes) expect(contentSecurityPolicy).toContain(hash);
    expect(result.prepared.moduleBundler).toMatch(/^artifact-module-bundler:v1 bun@/);
    expect(result.prepared.byteLength).toBe(Buffer.byteLength(document));
  });

  test("output is deterministic: same bytes, hashes and policy across runs and instances", async () => {
    const html = fixture("chartjs-module.html");
    const deps = ["chart.js@4.5.1"];
    const first = await prepare(html, deps);
    const second = await prepare(html, deps);
    const third = await prepare(
      html,
      deps,
      new TranscriptInteractivePreparer({ frameAncestors: ["http://127.0.0.1:*"] }),
    );
    if (!first.ok || !second.ok || !third.ok) throw new Error("preparation failed");
    for (const other of [second, third]) {
      expect(other.prepared.document).toBe(first.prepared.document);
      expect(other.prepared.documentSha256).toBe(first.prepared.documentSha256);
      expect(other.prepared.scriptHashes).toEqual(first.prepared.scriptHashes);
      expect(other.prepared.contentSecurityPolicy).toBe(first.prepared.contentSecurityPolicy);
      expect(other.prepared.dependencyManifestHash).toBe(first.prepared.dependencyManifestHash);
    }
    expect(first.prepared.documentSha256).toBe(sha256Hex(first.prepared.document));
    const direct = await bundleModuleScript('import * as d3 from "d3";\nd3.select("p");\n', [D3]);
    const again = await bundleModuleScript('import * as d3 from "d3";\nd3.select("p");\n', [D3]);
    expect(direct).toEqual(again);
  });

  test("Chart.js named, registerables and chart.js/auto default imports resolve to one shim", async () => {
    const result = await prepare(fixture("chartjs-module.html"), ["chart.js@4.5.1"]);
    if (!result.ok) throw new Error(JSON.stringify(result.diagnostics));
    expect(result.prepared.resolvedDependencies).toEqual([
      { id: "chart.js@4.5.1", version: "4.5.1", sha256: CHART.sha256, license: "MIT" },
    ]);
    const scripts = await collectExecutableScripts(result.prepared.document);
    expect(scripts).toHaveLength(4); // runtime, Chart.js, two module bundles
    expect(scripts[1]).toContain("Chart.js v4.5.1");
    expect(scripts[2]).toContain("registerables: []");
    expect(scripts[3]).toContain("var Chart = globalThis.Chart;");
    expect(preparer.dependencyManifestHash(["chart.js@4.5.1"])).toBe(
      result.prepared.dependencyManifestHash,
    );
    expect(preparer.dependencyManifestHash(["chart.js@4.5.1"])).not.toBe(
      preparer.dependencyManifestHash(["d3@7.9.0"]),
    );
  });

  test("module bundles are escaped for inline embedding and hashed as serialized", async () => {
    const html =
      '<script type="module">import { select } from "d3"; const s = "<\\/script><!-- x"; select("body").attr("data-x", s);</script>';
    const result = await prepare(html, ["d3@7.9.0"]);
    if (!result.ok) throw new Error(JSON.stringify(result.diagnostics));
    const scripts = await collectExecutableScripts(result.prepared.document);
    const bundle = scripts.at(-1)!;
    expect(bundle).not.toMatch(/<\/script/i);
    expect(bundle).not.toContain("<!--");
    expect(bundle).toContain('"<\\/script><\\!-- x"');
    expect(result.prepared.scriptHashes).toContain(inlineScriptHash(bundle));
  });

  test("module scripts without imports, and empty ones, still prepare", async () => {
    const result = await prepare(
      '<p id="t">x</p><script type="module">const t = document.getElementById("t"); t.textContent = String(await Promise.resolve(2));</script><script type="module"></script>',
    );
    if (!result.ok) throw new Error(JSON.stringify(result.diagnostics));
    const scripts = await collectExecutableScripts(result.prepared.document);
    expect(scripts.at(-2)).toContain("await Promise.resolve(2)");
    expect(scripts.at(-1)).toBe("");
  });

  test("backend environment variables and paths never reach the output", async () => {
    process.env.ORK_MODULE_BUNDLER_CANARY = "canary-7f3c1e";
    try {
      const result = await bundleModuleScript(
        "console.log(process.env.ORK_MODULE_BUNDLER_CANARY, process.env.HOME, import.meta.env?.HOME, process.env.NODE_ENV);\n",
        [],
      );
      if (!result.ok) throw new Error(JSON.stringify(result.diagnostics));
      expect(result.code).not.toContain("canary-7f3c1e");
      expect(result.code).not.toContain(process.env.HOME ?? "/nonexistent-home");
      expect(result.code).not.toContain(process.cwd());
      expect(result.code).toContain('"production"');
    } finally {
      delete process.env.ORK_MODULE_BUNDLER_CANARY;
    }
  });
});

describe("module import rejection", () => {
  test("relative, absolute, URL, node: and bare non-manifest specifiers are unresolved", async () => {
    for (const specifier of [
      "./util.js",
      "../x.js",
      "/etc/passwd",
      "https://cdn.example.com/d3.js",
      "//cdn.example.com/d3.js",
      "data:text/javascript,export default 1",
      "node:fs",
      "fs",
      "bun:sqlite",
      "lodash",
      "d3-selection",
      "chart.js/helpers",
    ]) {
      const found = await errors(
        `<script type="module">import x from ${JSON.stringify(specifier)}; x;</script>`,
        ["d3@7.9.0", "chart.js@4.5.1"],
      );
      expect(found.map((d) => d.code)).toEqual(["unresolved_import"]);
      expect(found[0]!.message).toContain('"d3", "chart.js", "chart.js/auto"');
    }
    expect(
      await codes('<script type="module">export * from "./other.js";</script>', ["d3@7.9.0"]),
    ).toEqual(["unresolved_import"]);
  });

  test("an import of an undeclared dependency asks for the dependency id", async () => {
    const found = await errors('<script type="module">import * as d3 from "d3"; d3;</script>');
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ code: "undeclared_dependency" });
    expect(found[0]!.message).toContain('Add "d3@7.9.0" to dependencyIds');
    expect(
      await codes('<script type="module">import Chart from "chart.js/auto"; Chart;</script>', [
        "d3@7.9.0",
      ]),
    ).toEqual(["undeclared_dependency"]);
  });

  test("dynamic import(), top-level await of import() and require are rejected", async () => {
    const deps = ["d3@7.9.0"];
    expect(
      await codes('<script type="module">import("d3").then((d3) => d3);</script>', deps),
    ).toEqual(["unresolved_import"]);
    expect(
      await codes('<script type="module">const d3 = await import("d3"); d3;</script>', deps),
    ).toEqual(["unresolved_import"]);
    // A computed specifier is invisible to the import scan; the bundler refuses it.
    const computed = await errors(
      '<script type="module">const name = "d" + "3"; const m = await import(name); m;</script>',
      deps,
    );
    expect(computed.map((d) => d.code)).toEqual(["unresolved_import"]);
    expect(computed[0]!.location).toMatch(/^element 1 <script> line 1/);
    expect(await codes('<script type="module">const fs = require("fs");</script>', deps)).toEqual([
      "unresolved_import",
    ]);
  });

  test("classic scripts keep using globals; their imports point at module scripts", async () => {
    const found = await errors('<script>import("d3").then(() => 1)</script>', ["d3@7.9.0"]);
    expect(found.map((d) => d.code)).toEqual(["unresolved_import"]);
    expect(found[0]!.message).toContain("global d3");
    expect(found[0]!.message).toContain('<script type="module">');
  });

  test("macro imports never run: rejected for manifest specifiers and disabled in the bundler", async () => {
    await verifyMacrosDisabled();
    const found = await errors(
      '<script type="module">import { select } from "d3" with { type: "macro" }; select("x");</script>',
      ["d3@7.9.0"],
    );
    expect(found.map((d) => d.code)).toEqual(["unresolved_import"]);
    expect(found[0]!.message).toContain("Macro imports are not allowed");

    // Below the preparer's import check, a macro naming a real file on disk
    // still must not execute (macros resolve from disk and bypass plugins).
    const marker = path.join(scratch, "macro-ran");
    const macro = path.join(scratch, "macro.ts");
    writeFileSync(
      macro,
      `import { writeFileSync } from "node:fs";\nexport function run() { writeFileSync(${JSON.stringify(marker)}, "ran"); return 1; }\n`,
    );
    const direct = await bundleModuleScript(
      `import { run } from ${JSON.stringify(macro)} with { type: "macro" };\nconsole.log(run());\n`,
      [],
    );
    expect(direct.ok).toBe(false);
    expect(existsSync(marker)).toBe(false);
  });

  test("the resolver plugin enforces the manifest even when called directly", async () => {
    for (const source of [
      'import x from "./x.js"; x;',
      'import x from "node:fs"; x;',
      'import * as d3 from "d3"; d3;', // not declared
      'export { select } from "d3";', // not declared
    ]) {
      const result = await bundleModuleScript(source, []);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.diagnostics.map((d) => d.code)).toEqual(["unresolved_import"]);
    }
  });

  test("bounds the number of module scripts", async () => {
    const html = Array.from(
      { length: MAX_MODULE_SCRIPTS + 1 },
      (_, index) => `<script type="module">window.m${index} = ${index};</script>`,
    ).join("");
    expect(await codes(html)).toEqual(["too_many_module_scripts"]);
  });

  test("module bundle bytes count against the prepared-package limit", async () => {
    const module = `<script type="module">import * as d3 from "d3"; d3.select("p").text(${JSON.stringify("y".repeat(4_000))});</script>`;
    const size = async (bytes: number, html: string) => {
      const heavy = new TranscriptInteractivePreparer({
        frameAncestors: [],
        loadDependency: async () => new TextEncoder().encode(`/*${"x".repeat(bytes)}*/`),
      });
      return prepare(html, ["d3@7.9.0"], heavy);
    };
    // Measure the fixed overhead, then size the dependency so the document
    // fits without the module and exceeds the limit only with its bundle.
    const probe = await size(0, "<p>x</p>");
    if (!probe.ok) throw new Error("probe failed");
    const fill = INTERACTIVE_HTML_POLICY.maxPreparedBytes - probe.prepared.byteLength - 2_000;
    const without = await size(fill, "<p>x</p>");
    expect(without.ok).toBe(true);
    const withModule = await size(fill, `<p>x</p>${module}`);
    expect(withModule.ok).toBe(false);
    if (!withModule.ok) {
      expect(withModule.error.code).toBe("package_size_exceeded");
      expect(withModule.error.resource).toBe("prepared-bytes");
    }
  });
});
