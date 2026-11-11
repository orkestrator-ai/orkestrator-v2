/**
 * The text Find searches in a published `html-static` document, read from its
 * stored effective HTML without displaying it.
 *
 * The preview worker runs this once, at verification, on the sanitized
 * document it serialized, and the backend stores the result with the
 * publication (`search-text`). A transcript then searches a report the reader
 * has not reached yet, or has not reached since a reload, without framing it.
 *
 * It must produce exactly the text the presentation runtime's own walk
 * reports from its frame (`documentText` in `static-html-presentation.ts`):
 * Find counts matches in this text before the frame exists and in the frame's
 * text after, and the frame draws the n-th match. The walk is copied rather
 * than shared because both are serialized into a page on their own, and
 * `static-html-document-text.test.ts` pins the two together over the
 * reference, hostile and edge-case documents. Change both or neither.
 *
 * Self-contained: it is serialized into a browser page (`page.evaluate`), so
 * it may refer to nothing outside its own body. It parses with `DOMParser`,
 * which builds an inert document: nothing in it runs or loads.
 *
 * This module is part of the preview worker's bundle, so changing it changes
 * the worker's context digest.
 */
export function staticHtmlDocumentText(input: { html: string; maxCharacters: number }): string {
  const INLINE_TEXT =
    /^(?:a|abbr|b|bdi|bdo|cite|code|data|del|dfn|em|font|i|ins|kbd|label|mark|q|rp|rt|ruby|s|samp|small|span|strike|strong|sub|sup|time|tspan|tt|u|var|wbr)$/;
  const max = Math.max(0, Math.floor(input.maxCharacters));
  const doc = new DOMParser().parseFromString(input.html, "text/html");
  let text = "";
  let space = false;
  let boundary = false;
  const emit = (character: string) => {
    if (text.length < max) text += character;
  };
  const visit = (node: Node) => {
    if (node.nodeType === 3) {
      const value = node.nodeValue ?? "";
      for (let offset = 0; offset < value.length; offset++) {
        const character = value[offset]!;
        if (/\s/.test(character)) {
          space = true;
          continue;
        }
        if (text.length > 0) {
          if (boundary) emit("\n");
          else if (space) emit(" ");
        }
        boundary = false;
        space = false;
        emit(character);
      }
    }
    if (node.nodeType !== 1) return;
    const element = node as Element;
    if (/^(?:style|noscript)$/.test(element.localName) || element.hasAttribute("hidden")) return;
    const isBoundary = !INLINE_TEXT.test(element.localName);
    if (isBoundary) boundary = true;
    for (const child of Array.from(element.childNodes)) visit(child);
    if (isBoundary) boundary = true;
  };
  if (doc.body) visit(doc.body);
  return text;
}
