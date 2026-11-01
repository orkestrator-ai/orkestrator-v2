/**
 * Pinned, prebundled browser libraries.
 *
 * Two lists with different trust:
 *
 * - `ARTIFACT_DEPENDENCY_MANIFEST`: libraries an interactive HTML artifact may
 *   request by id. Their bytes are inlined into the prepared document and run
 *   with the artifact's own (untrusted) authority under its CSP.
 * - `RENDERER_BUNDLES`: application-owned renderer code (Mermaid, DOMPurify)
 *   that runs only inside the network-denied preview worker.
 *
 * Bytes come from the installed packages during development and from
 * `dist/artifact-runtime/` in the packaged backend (copied by
 * `apps/backend/scripts/build.ts`). Every load verifies the pinned SHA-256; a
 * missing or different file fails closed. Nothing is ever downloaded, and no
 * caller (artifact, environment variable or request) selects a path.
 *
 * Updating a pin: bump the package in apps/backend/package.json, then replace
 * `version` and `sha256` here with `shasum -a 256 <file>` of the new bundle.
 *
 * Module scripts: an artifact dependency is also importable by bare specifier
 * (`moduleSpecifiers`) from `<script type="module">`. The pinned UMD bytes are
 * still what runs, injected verbatim as a classic script that defines
 * `global`; the specifier resolves (in `interactive-modules.ts`) to
 * `moduleShim`, a few lines of application-owned CommonJS that re-export that
 * global. So classic and module scripts share one instance of the exact
 * hashed bytes, and no bundle is generated whose hash depends on the bundler.
 */
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export interface PinnedBundle {
  /** Stable identifier; for artifact dependencies this is what authors request. */
  id: string;
  packageName: string;
  version: string;
  /** File inside the package. */
  packageFile: string;
  /** File name inside `artifact-runtime/` in packaged builds. */
  distName: string;
  sha256: string;
  license: string;
  notice: string;
  /**
   * License texts inside the package, shipped beside the bundle
   * (`licenses/<id>/`). `../<package>/<file>` names a sibling package whose
   * code the bundle embeds.
   */
  licenseFiles: readonly string[];
}

export interface ArtifactDependency extends PinnedBundle {
  /** Global the bundle defines in the prepared document. */
  global: string;
  /** Bare specifiers a module script may import once the dependency is declared. */
  moduleSpecifiers: readonly string[];
  /**
   * Application-owned CommonJS module every specifier resolves to. It only
   * re-exports `global` (the bundler's CommonJS interop provides named and
   * namespace imports); it never contains or loads other code.
   */
  moduleShim: string;
}

export const ARTIFACT_DEPENDENCY_MANIFEST_VERSION = "artifact-dependency-manifest:v2";

export const ARTIFACT_DEPENDENCY_MANIFEST: readonly ArtifactDependency[] = Object.freeze([
  {
    id: "d3@7.9.0",
    packageName: "d3",
    version: "7.9.0",
    packageFile: "dist/d3.min.js",
    distName: "d3.min.js",
    sha256: "f2094bbf6141b359722c4fe454eb6c4b0f0e42cc10cc7af921fc158fceb86539",
    license: "ISC",
    notice: "d3 7.9.0 https://d3js.org Copyright 2010-2023 Mike Bostock (ISC License)",
    licenseFiles: ["LICENSE"],
    global: "d3",
    moduleSpecifiers: ["d3"],
    moduleShim: "module.exports = globalThis.d3;\n",
  },
  {
    id: "chart.js@4.5.1",
    packageName: "chart.js",
    version: "4.5.1",
    // The UMD build registers every controller, element, scale and plugin.
    packageFile: "dist/chart.umd.min.js",
    distName: "chart.umd.min.js",
    sha256: "48444a82d4edcb5bec0f1965faacdde18d9c17db3063d042abada2f705c9f54a",
    license: "MIT",
    notice:
      "Chart.js 4.5.1 https://www.chartjs.org (c) 2025 Chart.js Contributors (MIT License); embeds @kurkle/color v0.3.2 (c) 2023 Jukka Kurkela (MIT License)",
    licenseFiles: ["LICENSE.md", "../@kurkle/color/LICENSE.md"],
    global: "Chart",
    moduleSpecifiers: ["chart.js", "chart.js/auto"],
    // Named exports mirror the UMD's (controllers, elements, scales, plugins,
    // Chart). Everything is already registered, so `registerables` is empty
    // and `Chart.register(...registerables)` is a harmless no-op.
    moduleShim: [
      "var Chart = globalThis.Chart;",
      "module.exports = Object.assign(Object.create(null), Chart, {",
      "  __esModule: true,",
      "  default: Chart,",
      "  Chart: Chart,",
      "  registerables: [],",
      "});",
      "",
    ].join("\n"),
  },
]);

export const RENDERER_BUNDLES = Object.freeze({
  mermaid: {
    id: "mermaid@12.2.0",
    packageName: "mermaid",
    version: "12.2.0",
    packageFile: "dist/mermaid.min.js",
    distName: "mermaid.min.js",
    sha256: "a8a6a6f805b074a8261a2825c86f99c8054acb3b35f50bb7e24a4f9f2c3c3b9f",
    license: "MIT",
    notice: "mermaid 12.2.0 https://mermaid.js.org (MIT License)",
    licenseFiles: ["LICENSE"],
  },
  dompurify: {
    id: "dompurify@3.4.17",
    packageName: "dompurify",
    version: "3.4.17",
    packageFile: "dist/purify.min.js",
    distName: "purify.min.js",
    sha256: "cd37898f9782adf54820c413191b5691803f0f137c799d6edcfd38523b4c2c31",
    license: "(MPL-2.0 OR Apache-2.0)",
    notice: "DOMPurify 3.4.17 https://github.com/cure53/DOMPurify (MPL-2.0 OR Apache-2.0)",
    licenseFiles: ["LICENSE", "LICENSE-MPL"],
  },
  // pdf.js renders the first page of PDF attachments inside the preview
  // worker only (main-thread "fake worker": the worker module is loaded as a
  // module, never as a Web Worker). Never injected into artifact documents.
  pdfjs: {
    id: "pdfjs-dist@6.4.299",
    packageName: "pdfjs-dist",
    version: "6.4.299",
    packageFile: "build/pdf.min.mjs",
    distName: "pdf.min.mjs",
    sha256: "57456c8e0c81e46be31174b499ef77f2b9f5ee46d04412ba627320a36755d4c2",
    license: "Apache-2.0",
    notice:
      "PDF.js (pdfjs-dist) 6.4.299 https://mozilla.github.io/pdf.js/ Copyright 2024 Mozilla Foundation (Apache License 2.0)",
    licenseFiles: ["LICENSE"],
  },
  pdfjsWorker: {
    id: "pdfjs-dist-worker@6.4.299",
    packageName: "pdfjs-dist",
    version: "6.4.299",
    packageFile: "build/pdf.worker.min.mjs",
    distName: "pdf.worker.min.mjs",
    sha256: "9536359f1b8367850d485731ca1d5e45c159a7b7a0912325e539937aa21ceb18",
    license: "Apache-2.0",
    notice:
      "PDF.js worker (pdfjs-dist) 6.4.299 https://mozilla.github.io/pdf.js/ Copyright 2024 Mozilla Foundation (Apache License 2.0)",
    licenseFiles: ["LICENSE"],
  },
} satisfies Record<string, PinnedBundle>);

/** Every bundle the build must ship next to the backend. */
export const ALL_PINNED_BUNDLES: readonly PinnedBundle[] = Object.freeze([
  ...ARTIFACT_DEPENDENCY_MANIFEST,
  RENDERER_BUNDLES.mermaid,
  RENDERER_BUNDLES.dompurify,
  RENDERER_BUNDLES.pdfjs,
  RENDERER_BUNDLES.pdfjsWorker,
]);

export class PinnedBundleError extends Error {
  constructor(
    readonly reason: "missing" | "integrity",
    readonly bundleId: string,
  ) {
    super(
      reason === "missing"
        ? `Pinned bundle ${bundleId} is not installed with this backend`
        : `Pinned bundle ${bundleId} does not match its recorded SHA-256`,
    );
    this.name = "PinnedBundleError";
  }
}

export function sha256Hex(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function moduleDirectory(): string {
  return path.dirname(fileURLToPath(import.meta.url));
}

/**
 * Fixed candidate locations, most specific first:
 * - packaged backend: `<dist>/artifact-runtime/<file>` (main bundle) or
 *   `<dir>/<file>` (the worker bundle, which itself lives in artifact-runtime);
 * - source checkout: `apps/backend/node_modules/<package>/<file>`.
 */
export function pinnedBundleCandidates(
  bundle: PinnedBundle,
  baseDir = moduleDirectory(),
): string[] {
  return [
    path.join(baseDir, "artifact-runtime", bundle.distName),
    path.join(baseDir, bundle.distName),
    path.resolve(baseDir, "../../../node_modules", bundle.packageName, bundle.packageFile),
  ];
}

/**
 * Process-wide on purpose: verified bytes of a pinned bundle file, keyed by
 * bundle and directory, the same for every backend.
 */
const cache = new Map<string, Promise<Uint8Array>>();

/** Loads and verifies a pinned bundle. Cached per process after verification. */
export function loadPinnedBundle(bundle: PinnedBundle, baseDir?: string): Promise<Uint8Array> {
  const key = `${bundle.id}\u0000${baseDir ?? ""}`;
  let pending = cache.get(key);
  if (!pending) {
    pending = (async () => {
      const file = pinnedBundleCandidates(bundle, baseDir).find((candidate) =>
        existsSync(candidate),
      );
      if (!file) throw new PinnedBundleError("missing", bundle.id);
      const bytes = new Uint8Array(await readFile(file));
      if (sha256Hex(bytes) !== bundle.sha256) throw new PinnedBundleError("integrity", bundle.id);
      return bytes;
    })();
    // A failed load is retried on the next request rather than cached forever.
    pending.catch(() => cache.delete(key));
    cache.set(key, pending);
  }
  return pending;
}

export function findArtifactDependency(id: string): ArtifactDependency | undefined {
  return ARTIFACT_DEPENDENCY_MANIFEST.find((entry) => entry.id === id);
}

/** Canonical identity of a dependency list (order preserved: it is injection order). */
export function dependencyListIdentity(entries: readonly PinnedBundle[]): string {
  const canonical = JSON.stringify({
    version: ARTIFACT_DEPENDENCY_MANIFEST_VERSION,
    dependencies: entries.map((entry) => ({
      id: entry.id,
      license: entry.license,
      sha256: entry.sha256,
      version: entry.version,
      ...("moduleShim" in entry
        ? {
            moduleSpecifiers: (entry as ArtifactDependency).moduleSpecifiers,
            moduleShimSha256: sha256Hex((entry as ArtifactDependency).moduleShim),
          }
        : {}),
    })),
  });
  return sha256Hex(canonical);
}

/** Identity of the whole checked-in manifest. */
export function artifactDependencyManifestHash(): string {
  return dependencyListIdentity(ARTIFACT_DEPENDENCY_MANIFEST);
}

/** Identity of the application-owned Mermaid renderer bundles used by the preview worker. */
export function mermaidRendererBundleHash(): string {
  return dependencyListIdentity([RENDERER_BUNDLES.mermaid, RENDERER_BUNDLES.dompurify]);
}

/** Identity of the pinned pdf.js bundles the worker renders PDF previews with. */
export function pdfRendererBundleHash(): string {
  return dependencyListIdentity([RENDERER_BUNDLES.pdfjs, RENDERER_BUNDLES.pdfjsWorker]);
}

/**
 * Where a bundle's license file is written: `<target>/licenses/<id>/<name>`;
 * a sibling package's license (`../@scope/pkg/LICENSE`) is kept under the
 * bundle's own directory as `@scope/pkg/LICENSE`.
 */
export function pinnedLicensePath(target: string, bundle: PinnedBundle, name: string): string {
  return path.join(
    target,
    "licenses",
    bundle.id,
    ...name.split("/").filter((part) => part !== ".." && part !== "."),
  );
}

/**
 * Writes every pinned bundle's license texts to `<target>/licenses/<id>/` and
 * a combined `<target>/THIRD_PARTY_NOTICES.txt` (notice, license, version,
 * SHA-256 and full license text per bundle). Used by the backend build and
 * the worker image build; sources are the installed packages, so a missing
 * license file fails the build instead of shipping a bundle without it.
 */
export async function writePinnedBundleLicenses(
  target: string,
  moduleDir = moduleDirectory(),
): Promise<string[]> {
  const written: string[] = [];
  const sections: string[] = [
    "Third-party software bundled with Orkestrator's transcript-artifact runtime.",
    "Each bundle is pinned by SHA-256 in apps/backend/src/core/transcript-artifacts/dependency-manifest.ts.",
    "Mermaid's minified bundle also embeds its own dependencies; their notices are preserved inside mermaid.min.js.",
    "Chart.js's UMD bundle embeds @kurkle/color; its license is listed with Chart.js below.",
    "",
  ];
  for (const bundle of ALL_PINNED_BUNDLES) {
    const bundleFile = await realpath(pinnedBundleCandidates(bundle, moduleDir).at(-1)!);
    // `<package>/<packageFile>` → package root.
    const packageRoot = path.resolve(bundleFile, ...bundle.packageFile.split("/").map(() => ".."));
    const directory = path.join(target, "licenses", bundle.id);
    await mkdir(directory, { recursive: true });
    sections.push("=".repeat(78), `${bundle.id} (${bundle.distName})`, bundle.notice);
    sections.push(`License: ${bundle.license}`, `SHA-256: ${bundle.sha256}`, "");
    for (const name of bundle.licenseFiles) {
      const text = await readFile(path.join(packageRoot, name), "utf8");
      const destination = pinnedLicensePath(target, bundle, name);
      await mkdir(path.dirname(destination), { recursive: true });
      await writeFile(destination, text);
      written.push(destination);
      sections.push(`--- ${name} ---`, text.trimEnd(), "");
    }
  }
  const notices = path.join(target, "THIRD_PARTY_NOTICES.txt");
  await writeFile(notices, `${sections.join("\n")}\n`);
  written.push(notices);
  return written;
}
