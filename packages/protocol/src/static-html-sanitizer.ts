/**
 * The one sanitizer for static HTML: the design runtime (which renders,
 * validates and verifies `html-static` artifacts and design frames) and the
 * transcript's static document presentation runtime both use it, so a document
 * the backend verified is cleaned by exactly the same rules wherever it is
 * shown.
 *
 * Both runtimes are serialized with `toString()` into an opaque frame or a
 * worker page, where no module scope exists. So the sanitizer is a
 * self-contained factory: each runtime's script passes
 * `createStaticHtmlSanitizer.toString()` to the runtime as an argument and the
 * runtime calls it. Nothing in its body may refer to anything outside it.
 *
 * Its source is part of the static renderer's identity (`STATIC_RENDERER_HASH`
 * in the preview runner, compared at publication) and of the preview worker
 * image's context digest, so any change here, even a refactor, re-verifies
 * unpublished drafts and asks prepared worker images to be rebuilt. Change its
 * rules deliberately, and bump `ARTIFACT_VERSIONS.staticSanitizer` when its
 * behaviour changes.
 */

/** What one pass removed or found, reported by `validate` and preview diagnostics. */
export interface StaticHtmlSanitizerCounts {
  scripts: number;
  handlers: number;
  externalReferences: number;
  forbiddenElements: number;
  executableUrls: number;
}

export interface StaticHtmlSanitizer {
  emptyCounts: () => StaticHtmlSanitizerCounts;
  /** Remove executable content in place, counting what was removed. */
  clean: (doc: Document | DocumentFragment, counts: StaticHtmlSanitizerCounts) => void;
  /** Elements, including those inside `<template>` content. */
  elementCount: (root: Document | DocumentFragment) => number;
}

/**
 * Removes scripts, frames, embedded objects, `<base>`, `<meta>`, `<link>`,
 * event handlers, `srcdoc`/`nonce`/`http-equiv`/form targets and
 * `javascript:`/`vbscript:` URLs, recursing into `<template>` content. Inline
 * SVG and CSS are kept; external references are counted, not removed.
 */
export function createStaticHtmlSanitizer(): StaticHtmlSanitizer {
  const forbidden = "script,iframe,frame,object,embed,base,meta,link,portal,applet";
  const externalUrl = /^\s*(?:https?:)?\/\//i;
  const cssExternal = /url\(\s*['"]?\s*(?:https?:)?\/\//gi;
  const cssImport = /@import\s/gi;
  const emptyCounts = (): StaticHtmlSanitizerCounts => ({
    scripts: 0,
    handlers: 0,
    externalReferences: 0,
    forbiddenElements: 0,
    executableUrls: 0,
  });
  function countCss(text: string | null, counts: StaticHtmlSanitizerCounts) {
    if (!text) return;
    counts.externalReferences += (text.match(cssExternal) ?? []).length;
    counts.externalReferences += (text.match(cssImport) ?? []).length;
  }
  function clean(doc: Document | DocumentFragment, counts: StaticHtmlSanitizerCounts) {
    doc.querySelectorAll(forbidden).forEach((node) => {
      if (node.tagName.toLowerCase() === "script") counts.scripts++;
      else counts.forbiddenElements++;
      node.remove();
    });
    for (const node of Array.from(doc.querySelectorAll("*"))) {
      if (node.tagName.toLowerCase() === "style") countCss(node.textContent, counts);
      for (const attr of Array.from(node.attributes)) {
        const lower = attr.name.toLowerCase();
        if (/^on/i.test(attr.name)) {
          counts.handlers++;
          node.removeAttribute(attr.name);
        } else if (["srcdoc", "nonce", "http-equiv", "action", "formaction"].includes(lower)) {
          counts.forbiddenElements++;
          node.removeAttribute(attr.name);
        } else if (["href", "src", "xlink:href", "srcset", "poster"].includes(lower)) {
          if (/^(?:javascript|vbscript):/i.test(attr.value.trim())) {
            counts.executableUrls++;
            node.removeAttribute(attr.name);
          } else if (externalUrl.test(attr.value) && lower !== "href") {
            counts.externalReferences++;
          }
        } else if (lower === "style") {
          countCss(attr.value, counts);
        }
      }
      if (node instanceof HTMLTemplateElement) clean(node.content, counts);
    }
  }
  function elementCount(root: Document | DocumentFragment): number {
    let total = 0;
    for (const node of Array.from(root.querySelectorAll("*"))) {
      total++;
      if (node instanceof HTMLTemplateElement) total += elementCount(node.content);
    }
    return total;
  }
  return { emptyCounts, clean, elementCount };
}
