/**
 * Backend-side structural verification of sanitized Mermaid SVG.
 *
 * DOMPurify ran inside the isolated worker page; this independent check runs
 * in the backend over the exact bytes that will be stored, so a sanitizer
 * regression or a compromised worker cannot hand the application an SVG with
 * scripts, foreign HTML, event attributes, navigation or external resources.
 * It never mutates the markup: anything unexpected fails verification.
 */
import { scanCssResources } from "@orkestrator/protocol/css-resource-scan";
import { MERMAID_POLICY, utf8ByteLength } from "@orkestrator/protocol/rich-content-policy";

import { decodeAttributeValue } from "./interactive-prepare.js";

const FORBIDDEN_ELEMENTS = new Set([
  "script",
  "foreignobject",
  "iframe",
  "frame",
  "object",
  "embed",
  "image",
  "feimage",
  "use",
  "a",
  "animate",
  "set",
  "animatemotion",
  "animatetransform",
  "audio",
  "video",
  "link",
  "meta",
  "base",
  "form",
  "input",
  "button",
  "textarea",
]);

export interface MermaidSvgVerification {
  ok: boolean;
  bytes: number;
  elements: number;
  problems: string[];
}

export async function verifyMermaidSvg(svg: string): Promise<MermaidSvgVerification> {
  const problems: string[] = [];
  const bytes = utf8ByteLength(svg);
  if (bytes > MERMAID_POLICY.maxSvgBytes)
    problems.push(`SVG is ${bytes} bytes (limit ${MERMAID_POLICY.maxSvgBytes})`);
  let elements = 0;
  let roots = 0;
  let style: string | null = null;
  const checkCss = (css: string, where: string) => {
    const scan = scanCssResources(css);
    if (scan.importCount > 0 || scan.externalCount > 0 || scan.truncated)
      problems.push(`external CSS reference in ${where}`);
  };
  if (bytes <= MERMAID_POLICY.maxSvgBytes) {
    await new HTMLRewriter()
      .on("*", {
        element(element) {
          elements++;
          const tag = element.tagName.toLowerCase();
          if (elements === 1 && tag === "svg") roots++;
          if (FORBIDDEN_ELEMENTS.has(tag)) problems.push(`forbidden element <${tag}>`);
          if (tag === "style") {
            style = "";
            element.onEndTag(() => {
              // SVG <style> is foreign content: the serializer escapes `>` as `&gt;`
              // and an HTML parser decodes references, so scan the decoded text.
              if (style !== null) {
                const decoded = decodeAttributeValue(style);
                if (decoded === null) problems.push("unsupported character reference in <style>");
                else checkCss(decoded, "<style>");
              }
              style = null;
            });
          }
          for (const [rawName, rawValue] of Array.from(element.attributes)) {
            const name = rawName.toLowerCase();
            if (name.startsWith("on")) problems.push(`event attribute ${name.slice(0, 40)}`);
            const value = decodeAttributeValue(rawValue);
            if (value === null) {
              problems.push(`unsupported character reference in ${name.slice(0, 40)}`);
              continue;
            }
            if (name === "href" || name === "xlink:href") {
              if (!value.trim().startsWith("#")) problems.push(`non-fragment ${name}`);
            } else if (name === "style") {
              checkCss(value, `style attribute of <${tag}>`);
            } else if (/url\s*\(/i.test(value) || name === "src" || name === "srcset") {
              checkCss(`x{p:${value}}`, `${name} attribute of <${tag}>`);
            }
          }
        },
        text(chunk) {
          if (style !== null) style += chunk.text;
        },
      })
      .transform(new Response(svg))
      .arrayBuffer();
  }
  if (roots !== 1) problems.push("output is not a single SVG document");
  if (elements > MERMAID_POLICY.maxSvgElements) {
    problems.push(`SVG has ${elements} elements (limit ${MERMAID_POLICY.maxSvgElements})`);
  }
  return { ok: problems.length === 0, bytes, elements, problems: problems.slice(0, 20) };
}

/**
 * Mermaid math labels (`$$…$$`, rendered by Mermaid through KaTeX) need HTML
 * labels, which this application keeps disabled (`htmlLabels: false`, strict
 * security): an SVG `foreignObject` label would reintroduce HTML into the
 * diagram. KaTeX is not bundled or used. Rather than render the raw `$$`
 * text silently, previews fail with this diagnostic so the author can write
 * the expression as plain text or Unicode instead.
 */
export const MERMAID_MATH_LABELS_UNSUPPORTED = "math_labels_unsupported";

export function detectMermaidMathLabels(source: string): { line: number; column: number } | null {
  const lines = source.split("\n");
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!;
    // Comments (`%%`) never render, so math inside them is harmless.
    const code = line.trimStart().startsWith("%%") ? "" : line;
    const start = code.indexOf("$$");
    if (start < 0) continue;
    // A delimited pair on this line, or an opening `$$` closed later in the source.
    const rest = [code.slice(start + 2), ...lines.slice(index + 1)].join("\n");
    if (rest.includes("$$")) return { line: index + 1, column: start + 1 };
  }
  return null;
}
