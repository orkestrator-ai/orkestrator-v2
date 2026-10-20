/**
 * Find fetch-capable constructs in CSS by tokenizing it.
 *
 * Stripping the literal text `url(` is not CSS validation: escapes
 * (`u\72l(`), comments (`ur/**\/l(`), `@import "x"` with a bare string and
 * `image-set("x")` all fetch without it. This scanner follows the CSS Syntax
 * Level 3 tokenizer closely enough to classify every url-token, `url()` /
 * `src()` / `image()` / `image-set()` function and `@import`/`@namespace`/
 * `@font-face src` reference, and reports whether each target is a local
 * `data:` URL, a fragment reference or something that would leave the
 * document.
 */

export interface CssResourceReference {
  kind: "url" | "import" | "function-string";
  /** The decoded target, bounded to 200 characters for diagnostics. */
  target: string;
  offset: number;
  external: boolean;
}

export interface CssScanResult {
  references: CssResourceReference[];
  externalCount: number;
  /** `@import` is rejected whatever its target. */
  importCount: number;
  truncated: boolean;
}

const FETCHING_FUNCTIONS = new Set([
  "url",
  "src",
  "image",
  "image-set",
  "-webkit-image-set",
  "cross-fade",
  "element",
]);

function isLocalTarget(target: string): boolean {
  const trimmed = target.trim();
  if (trimmed === "") return true;
  if (trimmed.startsWith("#")) return true;
  return /^data:/i.test(trimmed);
}

function isNameChar(code: number): boolean {
  return (
    (code >= 0x30 && code <= 0x39) ||
    (code >= 0x41 && code <= 0x5a) ||
    (code >= 0x61 && code <= 0x7a) ||
    code === 0x2d ||
    code === 0x5f ||
    code >= 0x80
  );
}

export function scanCssResources(css: string, maxReferences = 200): CssScanResult {
  const references: CssResourceReference[] = [];
  let importCount = 0;
  let truncated = false;
  let i = 0;
  const length = css.length;

  const push = (reference: CssResourceReference) => {
    if (references.length >= maxReferences) {
      truncated = true;
      return;
    }
    references.push(reference);
  };

  /** Consume an escape starting after the backslash; returns the decoded text. */
  const consumeEscape = (): string => {
    let hex = "";
    while (hex.length < 6 && i < length && /[0-9a-fA-F]/.test(css[i]!)) hex += css[i++];
    if (hex) {
      if (i < length && /\s/.test(css[i]!)) i++;
      const code = Number.parseInt(hex, 16);
      return code === 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)
        ? "�"
        : String.fromCodePoint(code);
    }
    return i < length ? css[i++]! : "�";
  };

  const consumeName = (): string => {
    let name = "";
    while (i < length) {
      const code = css.charCodeAt(i);
      if (isNameChar(code)) {
        name += css[i++];
      } else if (css[i] === "\\" && css[i + 1] !== "\n") {
        i++;
        name += consumeEscape();
      } else break;
    }
    return name;
  };

  const consumeString = (quote: string): string => {
    let value = "";
    while (i < length) {
      const char = css[i++]!;
      if (char === quote) break;
      if (char === "\n") break;
      if (char === "\\") {
        if (css[i] === "\n") {
          i++;
          continue;
        }
        value += consumeEscape();
        continue;
      }
      value += char;
    }
    return value;
  };

  const skipWhitespaceAndComments = () => {
    for (;;) {
      while (i < length && /\s/.test(css[i]!)) i++;
      if (css.startsWith("/*", i)) {
        const end = css.indexOf("*/", i + 2);
        i = end === -1 ? length : end + 2;
        continue;
      }
      break;
    }
  };

  /** Unquoted url( contents per the url-token rules. */
  const consumeUrlToken = (): string => {
    while (i < length && /\s/.test(css[i]!)) i++;
    let value = "";
    while (i < length) {
      const char = css[i++]!;
      if (char === ")") break;
      if (char === "\\") {
        value += consumeEscape();
        continue;
      }
      if (/\s/.test(char)) {
        while (i < length && /\s/.test(css[i]!)) i++;
        if (css[i] === ")") i++;
        break;
      }
      value += char;
    }
    return value;
  };

  while (i < length) {
    if (css.startsWith("/*", i)) {
      const end = css.indexOf("*/", i + 2);
      i = end === -1 ? length : end + 2;
      continue;
    }
    const char = css[i]!;
    if (char === '"' || char === "'") {
      i++;
      consumeString(char);
      continue;
    }
    if (char === "@") {
      const start = i;
      i++;
      const name = consumeName().toLowerCase();
      if (name === "import") {
        importCount++;
        skipWhitespaceAndComments();
        let target = "";
        if (css[i] === '"' || css[i] === "'") {
          const quote = css[i++]!;
          target = consumeString(quote);
        }
        push({ kind: "import", target: target.slice(0, 200), offset: start, external: true });
      }
      continue;
    }
    if (char === "\\" || isNameChar(css.charCodeAt(i))) {
      const start = i;
      let name: string;
      if (char === "\\") {
        i++;
        name = consumeEscape() + consumeName();
      } else {
        name = consumeName();
      }
      if (name.length === 0) {
        i++;
        continue;
      }
      if (css[i] === "(") {
        i++;
        const lower = name.toLowerCase();
        if (lower === "url") {
          skipWhitespaceAndComments();
          let target: string;
          if (css[i] === '"' || css[i] === "'") {
            const quote = css[i++]!;
            target = consumeString(quote);
          } else {
            target = consumeUrlToken();
          }
          push({
            kind: "url",
            target: target.slice(0, 200),
            offset: start,
            external: !isLocalTarget(target),
          });
        } else if (FETCHING_FUNCTIONS.has(lower)) {
          // image-set("a.png" 1x) / src("x") fetch bare strings too.
          let depth = 1;
          while (i < length && depth > 0) {
            skipWhitespaceAndComments();
            const next = css[i];
            if (next === undefined) break;
            if (next === '"' || next === "'") {
              const stringStart = i;
              i++;
              const target = consumeString(next);
              push({
                kind: "function-string",
                target: target.slice(0, 200),
                offset: stringStart,
                external: !isLocalTarget(target),
              });
              continue;
            }
            if (next === "\\" || isNameChar(css.charCodeAt(i))) {
              const innerStart = i;
              const inner = (next === "\\" ? (i++, consumeEscape()) : "") + consumeName();
              if (css[i] === "(" && inner.toLowerCase() === "url") {
                i++;
                skipWhitespaceAndComments();
                let target: string;
                if (css[i] === '"' || css[i] === "'") {
                  const quote = css[i++]!;
                  target = consumeString(quote);
                } else {
                  target = consumeUrlToken();
                }
                push({
                  kind: "url",
                  target: target.slice(0, 200),
                  offset: innerStart,
                  external: !isLocalTarget(target),
                });
              } else if (inner.length === 0) {
                i++;
              }
              continue;
            }
            if (next === "(") depth++;
            else if (next === ")") depth--;
            i++;
          }
        }
      }
      continue;
    }
    i++;
  }
  return {
    references,
    externalCount: references.filter((reference) => reference.external).length,
    importCount,
    truncated,
  };
}
