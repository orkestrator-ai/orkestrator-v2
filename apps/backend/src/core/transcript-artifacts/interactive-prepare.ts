/**
 * Prepares one immutable, offline executable document from authored HTML.
 *
 * HTML is parsed structurally with Bun's HTMLRewriter (lol-html, an HTML5
 * tokenizer) and CSS with the shared CSS tokenizer; executable tags and CSS
 * resources are never identified by a regular expression. Authored
 * JavaScript is parsed (Bun.Transpiler) to find imports and syntax errors but
 * never evaluated. Module scripts may import declared pinned dependencies by
 * bare specifier and are bundled under a fixed configuration
 * (`interactive-modules.ts`). Unsupported behaviour is rejected with a structured
 * diagnostic rather than silently producing a substantially different
 * artifact. The same inputs (source, assets, dependency ids, configured frame
 * ancestors, runtime and policy versions) always produce byte-identical output.
 */
import { artifactFrameRuntimeScript } from "@orkestrator/protocol/artifact-frame-channel";
import { scanCssResources } from "@orkestrator/protocol/css-resource-scan";
import {
  DIAGNOSTIC_POLICY,
  INTERACTIVE_HTML_POLICY,
  utf8ByteLength,
} from "@orkestrator/protocol/rich-content-policy";
import {
  ARTIFACT_ASSET_NAME_PATTERN,
  ARTIFACT_VERSIONS,
  artifactError,
  type ArtifactDiagnostic,
  type ArtifactError,
} from "@orkestrator/protocol/transcript-artifacts";

import type {
  InteractiveAssetInput,
  InteractivePreparer,
  PreparedInteractivePackage,
} from "./contracts.js";
import {
  ARTIFACT_DEPENDENCY_MANIFEST,
  PinnedBundleError,
  artifactDependencyManifestHash,
  dependencyListIdentity,
  findArtifactDependency,
  loadPinnedBundle,
  sha256Hex,
  type ArtifactDependency,
} from "./dependency-manifest.js";
import { validateInteractiveAssets, type ValidatedAsset } from "./interactive-assets.js";
import {
  MAX_MODULE_SCRIPTS,
  ModuleBundlerUnavailableError,
  bundleModuleScript,
  checkModuleImports,
  moduleBundlerIdentity,
  moduleSpecifierTable,
} from "./interactive-modules.js";
import {
  INTERACTIVE_CSP_VERSION,
  buildInteractiveCsp,
  escapeInlineScript,
  inlineScriptHash,
  readinessNonce,
} from "./interactive-csp.js";

export type PrepareResult =
  | { ok: true; prepared: PreparedInteractivePackage & PreparedPackageIdentity }
  | { ok: false; error: ArtifactError; diagnostics: ArtifactDiagnostic[] };

/** Additional identities (additive to the shared contract). */
export interface PreparedPackageIdentity {
  /** SHA-256 of the original authored HTML bytes. */
  sourceSha256: string;
  cspVersion: string;
  /** Element count found during structural preparation (static markup only). */
  staticElementCount: number;
  /** Bundler that compiled the module scripts (`interactive-modules.ts`), or null when there were none. */
  moduleBundler: string | null;
}

export interface InteractivePreparerOptions {
  /** Trusted viewer origins for `frame-ancestors`; configuration, never authored. */
  frameAncestors: readonly string[];
  /** Test seam: replaces pinned-bundle loading. */
  loadDependency?: (dependency: ArtifactDependency) => Promise<Uint8Array>;
}

const JS_MIME_TYPES = new Set([
  "",
  "module",
  "application/ecmascript",
  "application/javascript",
  "application/x-ecmascript",
  "application/x-javascript",
  "text/ecmascript",
  "text/javascript",
  "text/javascript1.0",
  "text/javascript1.1",
  "text/javascript1.2",
  "text/javascript1.3",
  "text/javascript1.4",
  "text/javascript1.5",
  "text/jscript",
  "text/livescript",
  "text/x-ecmascript",
  "text/x-javascript",
]);

const NESTED_CONTEXTS = new Set([
  "iframe",
  "frame",
  "frameset",
  "object",
  "embed",
  "portal",
  "applet",
  "fencedframe",
]);
const RESOURCE_HINTS = new Set([
  "preload",
  "prefetch",
  "preconnect",
  "dns-prefetch",
  "modulepreload",
  "prerender",
]);
/** Attributes whose value the browser may fetch. */
const RESOURCE_ATTRIBUTES = new Set([
  "src",
  "srcset",
  "poster",
  "background",
  "lowsrc",
  "dynsrc",
  "longdesc",
  "manifest",
  "data",
  "codebase",
  "archive",
  "imagesrcset",
  "xlink:href",
]);
/** Elements whose `href` is a resource reference rather than navigation. */
const HREF_RESOURCE_ELEMENTS = new Set([
  "image",
  "use",
  "feimage",
  "link",
  "script",
  "pattern",
  "filter",
  "textpath",
  "mpath",
  "tref",
  "lineargradient",
  "radialgradient",
]);
const NAVIGATION_ATTRIBUTES = new Set(["action", "formaction"]);

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  colon: ":",
  sol: "/",
  bsol: "\\",
  lpar: "(",
  rpar: ")",
  period: ".",
  comma: ",",
  semi: ";",
  num: "#",
  equals: "=",
  excl: "!",
  tab: "\t",
  newline: "\n",
};

/** Decode character references in a raw attribute value; null when ambiguous. */
export function decodeAttributeValue(raw: string): string | null {
  if (!raw.includes("&")) return raw;
  let ambiguous = false;
  const decoded = raw.replace(
    /&(#[xX][0-9a-fA-F]+|#[0-9]+|[A-Za-z][A-Za-z0-9]*);?/g,
    (match, body: string) => {
      if (body.startsWith("#")) {
        const hex = body[1] === "x" || body[1] === "X";
        const code = Number.parseInt(body.slice(hex ? 2 : 1), hex ? 16 : 10);
        return Number.isFinite(code) &&
          code > 0 &&
          code <= 0x10ffff &&
          !(code >= 0xd800 && code <= 0xdfff)
          ? String.fromCodePoint(code)
          : "�";
      }
      const value = NAMED_ENTITIES[body.toLowerCase()];
      if (value === undefined || (!match.endsWith(";") && body.toLowerCase() !== "amp")) {
        ambiguous = true;
        return match;
      }
      return value;
    },
  );
  return ambiguous ? null : decoded;
}

type UrlClass = "empty" | "fragment" | "data" | "asset" | "executable" | "external";

function classifyUrl(value: string): UrlClass {
  // Browsers strip leading/trailing C0 controls and spaces and ignore tabs/newlines inside.
  const trimmed = value.replace(/^[\u0000- ]+|[\u0000- ]+$/g, "").replace(/[\t\n\r]/g, "");
  if (trimmed === "") return "empty";
  if (trimmed.startsWith("#")) return "fragment";
  const scheme = /^([A-Za-z][A-Za-z0-9+.-]*):/.exec(trimmed)?.[1]?.toLowerCase();
  if (scheme === "data") return "data";
  if (scheme === "artifact-asset") return "asset";
  if (scheme === "javascript" || scheme === "vbscript") return "executable";
  return "external";
}

const ASSET_TOKEN = /artifact-asset:([A-Za-z0-9][A-Za-z0-9._-]{0,99})/g;

class DiagnosticSink {
  readonly entries: ArtifactDiagnostic[] = [];
  omitted = 0;
  private bytes = 0;
  errors = 0;

  add(diagnostic: ArtifactDiagnostic): void {
    if (diagnostic.severity === "error") this.errors++;
    const bounded: ArtifactDiagnostic = {
      ...diagnostic,
      message: diagnostic.message.slice(0, 1_500),
      ...(diagnostic.location ? { location: diagnostic.location.slice(0, 200) } : {}),
    };
    const size = utf8ByteLength(JSON.stringify(bounded));
    if (
      this.entries.length >= DIAGNOSTIC_POLICY.maxPersistedEntries ||
      size > DIAGNOSTIC_POLICY.maxEntryBytes ||
      this.bytes + size > DIAGNOSTIC_POLICY.maxPersistedBytes
    ) {
      this.omitted++;
      return;
    }
    this.bytes += size;
    this.entries.push(bounded);
  }
}

interface ScriptRecord {
  executable: boolean;
  module: boolean;
  /** Authored text exactly as the HTML tokenizer delimited it. */
  text: string;
  /** Escaped bundler output that replaces `text` (module scripts only). */
  bundled?: string;
  location: string;
}

function rewriteAssetTokens(
  text: string,
  assets: Map<string, ValidatedAsset>,
  used: Set<string>,
  onMissing: (name: string) => void,
): string {
  return text.replace(ASSET_TOKEN, (match, name: string) => {
    const asset = assets.get(name);
    if (!asset) {
      onMissing(name);
      return match;
    }
    used.add(name);
    return asset.dataUrl;
  });
}

/** Executable inline scripts of a document exactly as an HTML5 tokenizer sees them. */
export async function collectExecutableScripts(html: string): Promise<string[]> {
  const scripts: string[] = [];
  let current: { executable: boolean; text: string } | null = null;
  await new HTMLRewriter()
    .on("script", {
      element(element) {
        const type = (element.getAttribute("type") ?? "").trim().toLowerCase();
        current = {
          executable:
            element.namespaceURI === "http://www.w3.org/1999/xhtml" && JS_MIME_TYPES.has(type),
          text: "",
        };
        const record = current;
        if (record.executable) scripts.push("");
        const index = scripts.length - 1;
        element.onEndTag(() => {
          if (record.executable) scripts[index] = record.text;
          current = null;
        });
      },
      text(chunk) {
        if (current) current.text += chunk.text;
      },
    })
    .transform(new Response(html))
    .arrayBuffer();
  return scripts;
}

export class TranscriptInteractivePreparer implements InteractivePreparer {
  private readonly frameAncestors: readonly string[];
  private readonly loadDependency: (dependency: ArtifactDependency) => Promise<Uint8Array>;

  constructor(options: InteractivePreparerOptions) {
    this.frameAncestors = options.frameAncestors;
    // Validates configuration eagerly so a bad origin fails at startup.
    buildInteractiveCsp([], this.frameAncestors);
    this.loadDependency = options.loadDependency ?? ((dependency) => loadPinnedBundle(dependency));
  }

  dependencyManifestHash(dependencyIds?: readonly string[]): string {
    if (!dependencyIds) return artifactDependencyManifestHash();
    const resolved = [];
    for (const id of dependencyIds) {
      const dependency = findArtifactDependency(id);
      if (!dependency) return `unresolvable:${id.slice(0, 64)}`;
      resolved.push(dependency);
    }
    return dependencyListIdentity(resolved);
  }

  async prepare(input: {
    artifactId: string;
    revision: number;
    html: string;
    dependencyIds: string[];
    assets: InteractiveAssetInput[];
  }): Promise<PrepareResult> {
    const sink = new DiagnosticSink();
    const fail = (error: ArtifactError): PrepareResult => ({
      ok: false,
      error,
      diagnostics: sink.entries,
    });

    // Byte limits are enforced before parsing.
    const authoredBytes = utf8ByteLength(input.html);
    if (authoredBytes > INTERACTIVE_HTML_POLICY.maxAuthoredBytes) {
      sink.add({
        severity: "error",
        code: "authored_too_large",
        message: `Authored HTML is ${authoredBytes} bytes; at most ${INTERACTIVE_HTML_POLICY.maxAuthoredBytes} are allowed`,
        location: "payload.html",
      });
      return fail(
        artifactError(
          "package_size_exceeded",
          `Authored HTML is ${authoredBytes} bytes (limit ${INTERACTIVE_HTML_POLICY.maxAuthoredBytes})`,
          {
            resource: "authored-bytes",
          },
        ),
      );
    }

    // Dependencies resolve only through the checked-in manifest.
    const dependencyIds = input.dependencyIds ?? [];
    if (dependencyIds.length > INTERACTIVE_HTML_POLICY.maxDependencies) {
      sink.add({
        severity: "error",
        code: "too_many_dependencies",
        message: `${dependencyIds.length} dependencies requested; at most ${INTERACTIVE_HTML_POLICY.maxDependencies} are allowed`,
        location: "payload.dependencyIds",
      });
      return fail(
        artifactError("package_size_exceeded", "Too many dependencies", {
          resource: "dependencies",
        }),
      );
    }
    const dependencies: ArtifactDependency[] = [];
    dependencyIds.forEach((id, index) => {
      const dependency = typeof id === "string" ? findArtifactDependency(id) : undefined;
      if (!dependency) {
        sink.add({
          severity: "error",
          code: "unknown_dependency",
          message: `Dependency "${String(id).slice(0, 80)}" is not in the pinned manifest`,
          location: `payload.dependencyIds[${index}]`,
        });
      } else if (dependencies.includes(dependency)) {
        sink.add({
          severity: "error",
          code: "duplicate_dependency",
          message: `Dependency "${id}" is listed twice`,
          location: `payload.dependencyIds[${index}]`,
        });
      } else dependencies.push(dependency);
    });
    if (sink.errors) {
      return fail(
        artifactError("policy_denied", "Unknown or duplicate dependency", {
          suggestion: `Use dependency ids from the pinned manifest: ${ARTIFACT_DEPENDENCY_MANIFEST.map((entry) => entry.id).join(", ")}`,
        }),
      );
    }

    const assetDiagnostics: ArtifactDiagnostic[] = [];
    const assets = validateInteractiveAssets(input.assets ?? [], assetDiagnostics);
    assetDiagnostics.forEach((diagnostic) => sink.add(diagnostic));
    if (!assets) {
      const tooLarge = assetDiagnostics.some(
        (d) => d.code === "assets_too_large" || d.code === "too_many_assets",
      );
      return fail(
        tooLarge
          ? artifactError("package_size_exceeded", "Assets exceed the package limits", {
              resource: "assets",
            })
          : artifactError("validation_failed", "One or more assets are invalid"),
      );
    }

    let dependencyBytes: Array<{ dependency: ArtifactDependency; text: string }>;
    try {
      dependencyBytes = await Promise.all(
        dependencies.map(async (dependency) => ({
          dependency,
          text: new TextDecoder("utf-8", { fatal: true }).decode(
            await this.loadDependency(dependency),
          ),
        })),
      );
    } catch (error) {
      const integrity = error instanceof PinnedBundleError && error.reason === "integrity";
      return fail(
        artifactError(
          integrity ? "policy_denied" : "renderer_unavailable",
          integrity
            ? "A pinned dependency failed its integrity check; it will not be packaged"
            : "A pinned dependency is not installed with this backend",
        ),
      );
    }

    const transpiler = new Bun.Transpiler({ loader: "js" });
    const usedAssets = new Set<string>();
    const scripts: ScriptRecord[] = [];
    let elementOrdinal = 0;
    let staticElementCount = 0;
    let sawHead = false;
    let sawHtml = false;
    let currentScript: ScriptRecord | null = null;
    let scriptBuffer = "";
    let currentStyle: { location: string; svg: boolean } | null = null;
    let styleBuffer = "";

    const error = (code: string, message: string, location: string, suggestion?: string) =>
      sink.add({
        severity: "error",
        code,
        message: suggestion ? `${message}. ${suggestion}` : message,
        location,
      });
    const warning = (code: string, message: string, location: string) =>
      sink.add({ severity: "warning", code, message, location });

    const checkCss = (css: string, location: string) => {
      const scan = scanCssResources(css);
      if (scan.importCount > 0) {
        error(
          "external_css",
          "CSS @import is not allowed",
          location,
          "Inline the imported rules into this <style>",
        );
      }
      for (const reference of scan.references) {
        if (reference.kind === "import" || !reference.external) continue;
        error(
          "external_css",
          `CSS references an external resource (${reference.target.slice(0, 80) || "empty"})`,
          location,
          "Embed the resource as an artifact asset (artifact-asset:<name>) or a data: URL",
        );
      }
      if (scan.truncated)
        error("external_css", "CSS has too many resource references to verify", location);
    };

    const rewriteCss = (css: string, location: string) =>
      rewriteAssetTokens(css, assets, usedAssets, (name) =>
        error("unknown_asset", `Asset "${name}" was not supplied`, location),
      );

    const rewriter = new HTMLRewriter()
      .on("*", {
        element: (element) => {
          const tag = element.tagName.toLowerCase();
          const ordinal = ++elementOrdinal;
          staticElementCount++;
          const location = `element ${ordinal} <${tag}>`;
          const svg = element.namespaceURI === "http://www.w3.org/2000/svg";
          if (tag === "head") sawHead = true;
          if (tag === "html") sawHtml = true;

          if (NESTED_CONTEXTS.has(tag)) {
            error(
              "nested_browsing_context",
              `<${tag}> is not allowed in interactive artifacts`,
              location,
              "Render the content directly in this document",
            );
          } else if (tag === "base") {
            error(
              "base_element",
              "<base> is not allowed",
              location,
              "Use fragment or data: URLs only",
            );
          } else if (tag === "meta") {
            const equiv = (element.getAttribute("http-equiv") ?? "").trim().toLowerCase();
            if (equiv === "refresh") {
              error(
                "meta_refresh",
                '<meta http-equiv="refresh"> navigation is not allowed',
                location,
                "Update the page with DOM event listeners instead",
              );
            } else if (equiv) {
              warning(
                "author_policy_removed",
                `Removed <meta http-equiv="${equiv.slice(0, 40)}">; the application sets the document policy`,
                location,
              );
              element.remove();
              return;
            }
          } else if (tag === "link") {
            const rel = (element.getAttribute("rel") ?? "")
              .toLowerCase()
              .split(/\s+/)
              .filter(Boolean);
            const rawHref = element.getAttribute("href") ?? "";
            const href = decodeAttributeValue(rawHref);
            const kind = href === null ? "external" : classifyUrl(href);
            if (rel.includes("stylesheet")) {
              error(
                "external_stylesheet",
                '<link rel="stylesheet"> is not allowed',
                location,
                "Put the CSS in an inline <style> element",
              );
            } else if (rel.some((token) => RESOURCE_HINTS.has(token))) {
              if (kind === "external" || kind === "executable") {
                error(
                  "resource_hint",
                  `<link rel="${rel.join(" ")}"> to an external target is not allowed`,
                  location,
                  "Remove resource hints; the document is offline",
                );
              } else {
                warning(
                  "resource_hint_removed",
                  "Removed a resource hint with no external target",
                  location,
                );
                element.remove();
                return;
              }
            } else if (kind === "external" || kind === "executable") {
              error(
                "external_resource",
                "<link> references an external resource",
                location,
                "Use a data: URL or an artifact asset",
              );
            }
          } else if (tag === "script") {
            const type = (element.getAttribute("type") ?? "").trim().toLowerCase();
            const executable = JS_MIME_TYPES.has(type);
            if (type === "importmap" || type === "speculationrules" || type === "webbundle") {
              error(
                "unsupported_script_type",
                `<script type="${type}"> is not allowed`,
                location,
                'Use inline scripts; a <script type="module"> may import declared pinned dependencies by bare specifier (for example "d3")',
              );
            }
            if (
              element.hasAttribute("src") ||
              (svg && (element.hasAttribute("href") || element.hasAttribute("xlink:href")))
            ) {
              error(
                "external_script",
                "External scripts are not allowed",
                location,
                'Inline the code in a <script> element, or declare a pinned dependency id and use its global or import it from a <script type="module">',
              );
            }
            if (svg) {
              error(
                "svg_script",
                "Scripts inside <svg> are not supported",
                location,
                "Move the code into an HTML <script> element",
              );
            }
            element.removeAttribute("nonce");
            element.removeAttribute("integrity");
            element.removeAttribute("crossorigin");
            const record: ScriptRecord = {
              executable: executable && !svg,
              module: type === "module",
              text: "",
              location,
            };
            scripts.push(record);
            currentScript = record;
            scriptBuffer = "";
            element.onEndTag(() => {
              currentScript = null;
            });
          } else if (tag === "style") {
            if (svg) {
              error(
                "svg_style",
                "<style> inside <svg> is not supported",
                location,
                "Move the CSS into an HTML <style> element",
              );
            }
            currentStyle = { location, svg };
            styleBuffer = "";
            element.onEndTag(() => {
              currentStyle = null;
            });
          }

          for (const [rawName, rawValue] of Array.from(element.attributes)) {
            const name = rawName.toLowerCase();
            const attrLocation = `${location} attribute ${name.slice(0, 40)}`;
            if (name.startsWith("on")) {
              error(
                "inline_handler",
                `Inline event handler ${name.slice(0, 40)} is blocked by the artifact policy`,
                attrLocation,
                `Attach the handler from a script with addEventListener("${name.slice(2, 40)}", ...)`,
              );
              continue;
            }
            if (name === "srcdoc") {
              error("nested_browsing_context", "srcdoc documents are not allowed", attrLocation);
              continue;
            }
            if (name === "ping") {
              error("external_resource", "Hyperlink auditing (ping) is not allowed", attrLocation);
              continue;
            }
            if (name === "style") {
              const decoded = decodeAttributeValue(rawValue);
              if (decoded === null) {
                error(
                  "ambiguous_entity",
                  "Style attribute uses an unsupported character reference",
                  attrLocation,
                );
                continue;
              }
              const rewritten = rewriteCss(decoded, attrLocation);
              checkCss(rewritten, attrLocation);
              if (rewritten !== decoded) element.setAttribute(rawName, rewritten);
              continue;
            }
            const isHref = name === "href" || name === "xlink:href";
            // <link href> was classified with its rel above.
            if (tag === "link" && isHref) continue;
            const resource =
              RESOURCE_ATTRIBUTES.has(name) ||
              (isHref && (svg ? HREF_RESOURCE_ELEMENTS.has(tag) : tag === "link"));
            const navigation = NAVIGATION_ATTRIBUTES.has(name) || (isHref && !resource);
            if (!resource && !navigation) continue;
            const decoded = decodeAttributeValue(rawValue);
            if (decoded === null) {
              error(
                "ambiguous_entity",
                `Attribute ${name} uses an unsupported character reference`,
                attrLocation,
              );
              continue;
            }
            if (name === "srcset" || name === "imagesrcset") {
              const rewritten = rewriteAssetTokens(decoded, assets, usedAssets, (asset) =>
                error("unknown_asset", `Asset "${asset}" was not supplied`, attrLocation),
              );
              const candidates = rewritten
                .split(/,(?=\s*\S)/)
                .map((candidate) => candidate.trim().split(/\s+/)[0] ?? "");
              if (
                candidates.some((candidate) => !["data", "empty"].includes(classifyUrl(candidate)))
              ) {
                error(
                  "external_resource",
                  `${name} references an external resource`,
                  attrLocation,
                  "Use artifact assets or data: URLs",
                );
              } else if (rewritten !== decoded) element.setAttribute(rawName, rewritten);
              continue;
            }
            const kind = classifyUrl(decoded);
            if (kind === "executable") {
              error(
                "executable_url",
                `${name} uses a script URL`,
                attrLocation,
                "Use addEventListener instead of javascript: URLs",
              );
            } else if (kind === "asset") {
              const assetName = decoded.trim().slice("artifact-asset:".length);
              const asset = ARTIFACT_ASSET_NAME_PATTERN.test(assetName)
                ? assets.get(assetName)
                : undefined;
              if (!asset)
                error(
                  "unknown_asset",
                  `Asset "${assetName.slice(0, 100)}" was not supplied`,
                  attrLocation,
                );
              else {
                usedAssets.add(asset.name);
                element.setAttribute(rawName, asset.dataUrl);
              }
            } else if (kind === "external") {
              if (resource) {
                error(
                  "external_resource",
                  `${name} references an external resource`,
                  attrLocation,
                  "Embed it as an artifact asset (artifact-asset:<name>) or a data: URL",
                );
              } else {
                warning(
                  "navigation_link",
                  `${name} points outside the artifact; navigation is blocked`,
                  attrLocation,
                );
              }
            }
          }
        },
      })
      .on("script", {
        text: (chunk) => {
          const record = currentScript;
          if (!record) return;
          scriptBuffer += chunk.text;
          if (!chunk.lastInTextNode) {
            chunk.remove();
            return;
          }
          record.text = scriptBuffer;
          // Authored script text is re-emitted byte for byte: the tokenizer
          // already ended the element where the browser will.
          chunk.replace(scriptBuffer, { html: true });
          scriptBuffer = "";
        },
      })
      .on("style", {
        text: (chunk) => {
          const style = currentStyle;
          if (!style) return;
          styleBuffer += chunk.text;
          if (!chunk.lastInTextNode) {
            chunk.remove();
            return;
          }
          const rewritten = rewriteCss(styleBuffer, style.location);
          checkCss(rewritten, style.location);
          chunk.replace(rewritten, { html: true });
          styleBuffer = "";
        },
      });

    let transformed: string;
    try {
      transformed = await rewriter.transform(new Response(input.html)).text();
    } catch {
      return fail(artifactError("validation_failed", "The HTML could not be parsed"));
    }

    if (staticElementCount > INTERACTIVE_HTML_POLICY.maxRuntimeElements) {
      error(
        "too_many_elements",
        `The document has ${staticElementCount} elements; at most ${INTERACTIVE_HTML_POLICY.maxRuntimeElements} are allowed`,
        "payload.html",
      );
    }

    // Authored scripts are parsed, never run. Classic scripts use dependency
    // globals; module scripts may import declared dependencies by specifier.
    const specifiers = moduleSpecifierTable();
    const moduleScripts: ScriptRecord[] = [];
    for (const script of scripts) {
      if (!script.executable) continue;
      let imports: ReturnType<typeof transpiler.scanImports>;
      try {
        imports = transpiler.scanImports(script.text);
      } catch (parseError) {
        const message = parseError instanceof Error ? parseError.message : String(parseError);
        error("script_syntax", `Script does not parse: ${message.slice(0, 300)}`, script.location);
        continue;
      }
      if (!script.module) {
        for (const entry of imports) {
          const dependency = specifiers.get(entry.path);
          error(
            "unresolved_import",
            `${entry.kind} of "${entry.path.slice(0, 80)}" cannot be resolved offline`,
            script.location,
            dependency
              ? `Use the global ${dependency.global} from the declared dependency ${dependency.id}, or a static import inside <script type="module">`
              : 'Remove imports; declare a pinned dependency id and use its global (for example d3), or import it from a <script type="module">',
          );
        }
        continue;
      }
      const problems = checkModuleImports(imports, dependencies);
      for (const problem of problems)
        error(problem.code, problem.message, script.location, problem.suggestion);
      if (!problems.length && script.text.trim() !== "") moduleScripts.push(script);
    }
    if (moduleScripts.length > MAX_MODULE_SCRIPTS) {
      error(
        "too_many_module_scripts",
        `The document has ${moduleScripts.length} module scripts; at most ${MAX_MODULE_SCRIPTS} are allowed`,
        "payload.html",
        "Combine module scripts",
      );
    }

    for (const name of assets.keys()) {
      if (!usedAssets.has(name))
        warning("unused_asset", `Asset "${name}" is not referenced`, "assets");
    }

    // Bundled only once everything else is valid; one build per module script.
    if (sink.errors === 0 && moduleScripts.length > 0) {
      for (const script of moduleScripts) {
        let bundled: Awaited<ReturnType<typeof bundleModuleScript>>;
        try {
          bundled = await bundleModuleScript(script.text, dependencies);
        } catch (bundleError) {
          if (bundleError instanceof ModuleBundlerUnavailableError)
            return fail(artifactError("renderer_unavailable", bundleError.message));
          throw bundleError;
        }
        if (!bundled.ok) {
          for (const diagnostic of bundled.diagnostics) {
            const where = diagnostic.line
              ? `${script.location} line ${diagnostic.line}${diagnostic.column !== undefined ? `:${diagnostic.column}` : ""}`
              : script.location;
            error(diagnostic.code, diagnostic.message, where);
          }
          continue;
        }
        const escaped = escapeInlineScript(bundled.code);
        // Escaping is an identity for valid code; prove the result still parses.
        try {
          transpiler.scanImports(escaped);
        } catch {
          error(
            "script_serialization",
            "The bundled module cannot be embedded inline without changing its meaning",
            script.location,
          );
          continue;
        }
        script.bundled = escaped;
      }
    }

    if (sink.errors > 0) {
      const first = sink.entries.find((entry) => entry.severity === "error");
      return fail(
        artifactError(
          first?.code === "external_script" ? "policy_denied" : "validation_failed",
          `Interactive HTML failed preparation (${sink.errors} error${sink.errors === 1 ? "" : "s"})`,
          { suggestion: "Fix the listed diagnostics and save a new revision" },
        ),
      );
    }

    // Module scripts are replaced by their bundles in place (same element, same
    // attributes); the boundary check below re-verifies every script.
    if (moduleScripts.some((script) => script.bundled !== undefined)) {
      const replacements = scripts.map((script) => script.bundled);
      let index = -1;
      transformed = await new HTMLRewriter()
        .on("script", {
          element(element) {
            const replacement = replacements[++index];
            if (replacement !== undefined) element.setInnerContent(replacement, { html: true });
          },
        })
        .transform(new Response(transformed))
        .text();
      if (index + 1 !== scripts.length) {
        sink.add({
          severity: "error",
          code: "script_serialization",
          message: "Script elements changed while embedding module bundles",
          location: "package",
        });
        return fail(
          artifactError("validation_failed", "Script serialization could not be verified"),
        );
      }
    }

    // Injected first: application runtime, then pinned dependencies in request order.
    const nonce = readinessNonce(input.artifactId, input.revision);
    const injectedSources = [
      artifactFrameRuntimeScript({ artifactId: input.artifactId, revision: input.revision, nonce }),
      ...dependencyBytes.map(({ text }) => text),
    ].map(escapeInlineScript);
    const injected = `<meta charset="utf-8">${injectedSources.map((source) => `<script>${source}</script>`).join("")}`;

    let document: string;
    if (sawHead) {
      document = await new HTMLRewriter()
        .on("head", {
          element(element) {
            element.prepend(injected, { html: true });
          },
        })
        .transform(new Response(transformed))
        .text();
    } else if (sawHtml) {
      document = await new HTMLRewriter()
        .on("html", {
          element(element) {
            element.prepend(`<head>${injected}</head>`, { html: true });
          },
        })
        .transform(new Response(transformed))
        .text();
    } else {
      document = `<!doctype html><html><head>${injected}</head><body>${transformed}</body></html>`;
    }

    const byteLength = utf8ByteLength(document);
    if (byteLength > INTERACTIVE_HTML_POLICY.maxPreparedBytes) {
      sink.add({
        severity: "error",
        code: "prepared_too_large",
        message: `The prepared document is ${byteLength} bytes; at most ${INTERACTIVE_HTML_POLICY.maxPreparedBytes} are allowed`,
        location: "package",
      });
      return fail(
        artifactError(
          "package_size_exceeded",
          `Prepared document is ${byteLength} bytes (limit ${INTERACTIVE_HTML_POLICY.maxPreparedBytes})`,
          {
            resource: "prepared-bytes",
          },
        ),
      );
    }

    // Hashes come from an independent re-parse of the final bytes, and must
    // agree with what we serialized: the runtime, each dependency, then every
    // authored executable script (or its module bundle) in document order.
    const expected = [
      ...injectedSources,
      ...scripts
        .filter((script) => script.executable)
        .map((script) => script.bundled ?? script.text),
    ];
    const observed = await collectExecutableScripts(document);
    if (
      observed.length !== expected.length ||
      observed.some((text, index) => text !== expected[index])
    ) {
      sink.add({
        severity: "error",
        code: "script_serialization",
        message:
          "Script boundaries changed during serialization; the document cannot be authorized exactly",
        location: "package",
      });
      return fail(artifactError("validation_failed", "Script serialization could not be verified"));
    }
    const scriptHashes = Array.from(
      new Set(observed.filter((text) => text.length > 0).map(inlineScriptHash)),
    );
    const contentSecurityPolicy = buildInteractiveCsp(scriptHashes, this.frameAncestors);

    return {
      ok: true,
      prepared: {
        document,
        documentSha256: sha256Hex(document),
        byteLength,
        contentSecurityPolicy,
        scriptHashes,
        dependencyManifestHash: dependencyListIdentity(dependencies),
        resolvedDependencies: dependencies.map((dependency) => ({
          id: dependency.id,
          version: dependency.version,
          sha256: dependency.sha256,
          license: dependency.license,
        })),
        runtimeVersion: ARTIFACT_VERSIONS.interactiveRuntime,
        policyVersion: ARTIFACT_VERSIONS.interactivePolicyVersion,
        readinessNonce: nonce,
        diagnostics: sink.entries,
        sourceSha256: sha256Hex(input.html),
        cspVersion: INTERACTIVE_CSP_VERSION,
        staticElementCount,
        moduleBundler: moduleScripts.length ? moduleBundlerIdentity() : null,
      },
    };
  }
}
