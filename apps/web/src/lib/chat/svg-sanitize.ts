/**
 * Sanitize generated SVG (Mermaid output, chart exports) before it touches
 * the application DOM or is offered as a download.
 *
 * A dedicated DOMPurify instance with an SVG-only profile: no scripts, event
 * attributes, navigation targets, `foreignObject`, external images/fonts/
 * styles or external URL references. Fragment references (`url(#id)`,
 * `href="#id"`) used by markers survive. CSS inside `<style>` and `style=`
 * is rejected wholesale when it contains a fetch-capable construct, found by
 * tokenizing rather than by string matching. Element counts are measured
 * before and after so sanitization cannot be relied on to shrink an
 * oversized result.
 */
import DOMPurify from "dompurify";
import { scanCssResources } from "@orkestrator/protocol/css-resource-scan";
import { MERMAID_POLICY } from "@orkestrator/protocol/rich-content-policy";

export const SVG_SANITIZER_VERSION = "web-svg-sanitizer:v1";

const FORBID_TAGS = [
  "script",
  "foreignObject",
  "iframe",
  "object",
  "embed",
  "image",
  "feImage",
  "a",
  "use",
  "animate",
  "set",
  "animateMotion",
  "animateTransform",
  "handler",
  "listener",
];
const FORBID_ATTR = ["xlink:href", "href", "src", "action", "formaction", "srcset", "ping"];

/** MathML vocabulary Mermaid math labels may use when HTML labels are off. */
const MATHML_TAGS = [
  "math",
  "mrow",
  "mi",
  "mn",
  "mo",
  "msup",
  "msub",
  "msubsup",
  "mfrac",
  "msqrt",
  "mroot",
  "mtext",
  "mspace",
  "mtable",
  "mtr",
  "mtd",
  "semantics",
  "annotation",
];

export interface SvgSanitizeResult {
  svg: string;
  elementsBefore: number;
  elementsAfter: number;
  removed: number;
  bytes: number;
}

export class SvgSanitizeError extends Error {
  constructor(
    message: string,
    readonly code: "too_large" | "too_many_elements" | "invalid_svg",
  ) {
    super(message);
    this.name = "SvgSanitizeError";
  }
}

let purifier: ReturnType<typeof DOMPurify> | null = null;

function instance() {
  if (purifier) return purifier;
  const created = DOMPurify(window);
  created.addHook("uponSanitizeAttribute", (_node, data) => {
    const name = data.attrName.toLowerCase();
    if (name.startsWith("on")) {
      data.keepAttr = false;
      return;
    }
    const value = data.attrValue;
    if (
      name === "style" &&
      scanCssResources(value).externalCount + scanCssResources(value).importCount > 0
    ) {
      data.keepAttr = false;
      return;
    }
    // Presentation attributes may reference local fragments only.
    if (/url\s*\(/i.test(value)) {
      const scan = scanCssResources(`x{p:${value}}`);
      if (scan.externalCount > 0) data.keepAttr = false;
    }
  });
  created.addHook("uponSanitizeElement", (node, data) => {
    if (data.tagName === "style") {
      const text = node.textContent ?? "";
      const scan = scanCssResources(text);
      if (scan.externalCount > 0 || scan.importCount > 0) node.textContent = "";
    }
  });
  purifier = created;
  return created;
}

function countElements(markup: string): number {
  let count = 0;
  for (const match of markup.matchAll(/<[A-Za-z][^\s/>]*/g)) {
    if (match[0]) count++;
  }
  return count;
}

export function sanitizeSvg(
  markup: string,
  limits: { maxBytes: number; maxElements: number } = {
    maxBytes: MERMAID_POLICY.maxSvgBytes,
    maxElements: MERMAID_POLICY.maxSvgElements,
  },
): SvgSanitizeResult {
  const bytes = new TextEncoder().encode(markup).length;
  if (bytes > limits.maxBytes)
    throw new SvgSanitizeError(`SVG exceeds ${limits.maxBytes} bytes`, "too_large");
  const elementsBefore = countElements(markup);
  if (elementsBefore > limits.maxElements) {
    throw new SvgSanitizeError(`SVG exceeds ${limits.maxElements} elements`, "too_many_elements");
  }
  const clean = instance().sanitize(markup, {
    USE_PROFILES: { svg: true, svgFilters: true, mathMl: true },
    ADD_TAGS: MATHML_TAGS,
    FORBID_TAGS,
    FORBID_ATTR,
    ALLOW_DATA_ATTR: false,
    ALLOW_UNKNOWN_PROTOCOLS: false,
    RETURN_TRUSTED_TYPE: false,
  }) as string;
  if (!/^\s*<svg[\s>]/i.test(clean))
    throw new SvgSanitizeError("Sanitized output is not an SVG document", "invalid_svg");
  const elementsAfter = countElements(clean);
  return {
    svg: clean,
    elementsBefore,
    elementsAfter,
    removed: Math.max(0, elementsBefore - elementsAfter),
    bytes: new TextEncoder().encode(clean).length,
  };
}
