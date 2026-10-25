/**
 * Canonical JSON for content identities, plus a strict JSON reader.
 *
 * Artifact hashes are computed over a versioned canonical encoding: object
 * keys sorted by UTF-16 code unit, array order preserved, only finite numbers,
 * no `undefined`. The strict reader rejects duplicate object keys (which
 * `JSON.parse` silently resolves to the last value, so two different
 * documents would otherwise hash the same) and bounds nesting depth.
 */

export class CanonicalJsonError extends Error {
  constructor(
    message: string,
    readonly path: string,
  ) {
    super(message);
    this.name = "CanonicalJsonError";
  }
}

export function canonicalJson(value: unknown, maxDepth = 64): string {
  return encode(value, "$", 0, maxDepth);
}

function encode(value: unknown, path: string, depth: number, maxDepth: number): string {
  if (depth > maxDepth) throw new CanonicalJsonError("Nesting is too deep", path);
  if (value === null) return "null";
  switch (typeof value) {
    case "boolean":
      return value ? "true" : "false";
    case "number":
      if (!Number.isFinite(value)) throw new CanonicalJsonError("Number is not finite", path);
      // -0 and 0 share one identity.
      return JSON.stringify(Object.is(value, -0) ? 0 : value);
    case "string":
      return JSON.stringify(value);
    case "object": {
      if (Array.isArray(value)) {
        return `[${value
          .map((item, index) => {
            if (item === undefined) {
              throw new CanonicalJsonError("Array entry is undefined", `${path}[${index}]`);
            }
            return encode(item, `${path}[${index}]`, depth + 1, maxDepth);
          })
          .join(",")}]`;
      }
      const proto = Object.getPrototypeOf(value);
      if (proto !== Object.prototype && proto !== null) {
        throw new CanonicalJsonError("Only plain objects are supported", path);
      }
      const record = value as Record<string, unknown>;
      const keys = Object.keys(record).sort();
      const parts: string[] = [];
      for (const key of keys) {
        const child = record[key];
        if (child === undefined) {
          throw new CanonicalJsonError("Object value is undefined", `${path}.${key}`);
        }
        parts.push(
          `${JSON.stringify(key)}:${encode(child, `${path}.${key}`, depth + 1, maxDepth)}`,
        );
      }
      return `{${parts.join(",")}}`;
    }
    default:
      throw new CanonicalJsonError(`Unsupported value of type ${typeof value}`, path);
  }
}

export type StrictJsonResult =
  | { ok: true; value: unknown }
  | { ok: false; message: string; offset: number; path: string };

/**
 * Parse RFC 8259 JSON, rejecting duplicate keys and excessive depth.
 * Numbers are parsed with `Number`, so values beyond double precision are
 * rejected by the caller's finite/range checks rather than silently rounded.
 */
export function parseStrictJson(text: string, maxDepth = 32): StrictJsonResult {
  const parser = new StrictJsonParser(text, maxDepth);
  try {
    parser.skipWhitespace();
    const value = parser.parseValue("$", 1);
    parser.skipWhitespace();
    if (parser.index !== text.length) parser.fail("Unexpected trailing content", "$");
    return { ok: true, value };
  } catch (error) {
    if (error instanceof StrictJsonFailure) {
      return { ok: false, message: error.message, offset: error.offset, path: error.path };
    }
    throw error;
  }
}

class StrictJsonFailure extends Error {
  constructor(
    message: string,
    readonly offset: number,
    readonly path: string,
  ) {
    super(message);
  }
}

class StrictJsonParser {
  index = 0;

  constructor(
    private readonly text: string,
    private readonly maxDepth: number,
  ) {}

  fail(message: string, path: string): never {
    throw new StrictJsonFailure(message, this.index, path);
  }

  skipWhitespace(): void {
    while (this.index < this.text.length) {
      const char = this.text.charCodeAt(this.index);
      if (char === 0x20 || char === 0x0a || char === 0x0d || char === 0x09) this.index++;
      else break;
    }
  }

  parseValue(path: string, depth: number): unknown {
    if (depth > this.maxDepth) this.fail("Nesting is too deep", path);
    const char = this.text[this.index];
    if (char === "{") return this.parseObject(path, depth);
    if (char === "[") return this.parseArray(path, depth);
    if (char === '"') return this.parseString(path);
    if (char === "t") return this.parseLiteral("true", true, path);
    if (char === "f") return this.parseLiteral("false", false, path);
    if (char === "n") return this.parseLiteral("null", null, path);
    if (char === "-" || (char !== undefined && char >= "0" && char <= "9")) {
      return this.parseNumber(path);
    }
    return this.fail(char === undefined ? "Unexpected end of input" : "Unexpected character", path);
  }

  private parseLiteral<T>(word: string, value: T, path: string): T {
    if (this.text.startsWith(word, this.index)) {
      this.index += word.length;
      return value;
    }
    return this.fail("Invalid literal", path);
  }

  private parseNumber(path: string): number {
    const match = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(this.text.slice(this.index));
    if (!match) return this.fail("Invalid number", path);
    this.index += match[0].length;
    return Number(match[0]);
  }

  private parseString(path: string): string {
    // Opening quote.
    this.index++;
    let result = "";
    while (this.index < this.text.length) {
      const char = this.text[this.index]!;
      if (char === '"') {
        this.index++;
        return result;
      }
      if (char === "\\") {
        const escape = this.text[this.index + 1];
        this.index += 2;
        switch (escape) {
          case '"':
          case "\\":
          case "/":
            result += escape;
            break;
          case "b":
            result += "\b";
            break;
          case "f":
            result += "\f";
            break;
          case "n":
            result += "\n";
            break;
          case "r":
            result += "\r";
            break;
          case "t":
            result += "\t";
            break;
          case "u": {
            const hex = this.text.slice(this.index, this.index + 4);
            if (!/^[0-9a-fA-F]{4}$/.test(hex)) this.fail("Invalid unicode escape", path);
            result += String.fromCharCode(Number.parseInt(hex, 16));
            this.index += 4;
            break;
          }
          default:
            this.fail("Invalid escape sequence", path);
        }
        continue;
      }
      if (char.charCodeAt(0) < 0x20) this.fail("Control character in string", path);
      result += char;
      this.index++;
    }
    return this.fail("Unterminated string", path);
  }

  private parseArray(path: string, depth: number): unknown[] {
    this.index++;
    const result: unknown[] = [];
    this.skipWhitespace();
    if (this.text[this.index] === "]") {
      this.index++;
      return result;
    }
    for (;;) {
      this.skipWhitespace();
      result.push(this.parseValue(`${path}[${result.length}]`, depth + 1));
      this.skipWhitespace();
      const char = this.text[this.index];
      if (char === ",") {
        this.index++;
        continue;
      }
      if (char === "]") {
        this.index++;
        return result;
      }
      this.fail("Expected ',' or ']'", path);
    }
  }

  private parseObject(path: string, depth: number): Record<string, unknown> {
    this.index++;
    const result: Record<string, unknown> = Object.create(null);
    const seen = new Set<string>();
    this.skipWhitespace();
    if (this.text[this.index] === "}") {
      this.index++;
      return Object.assign({}, result);
    }
    for (;;) {
      this.skipWhitespace();
      if (this.text[this.index] !== '"') this.fail("Expected a property name", path);
      const key = this.parseString(path);
      const childPath = `${path}.${key}`;
      if (seen.has(key)) this.fail("Duplicate object key", childPath);
      seen.add(key);
      this.skipWhitespace();
      if (this.text[this.index] !== ":") this.fail("Expected ':'", childPath);
      this.index++;
      this.skipWhitespace();
      result[key] = this.parseValue(childPath, depth + 1);
      this.skipWhitespace();
      const char = this.text[this.index];
      if (char === ",") {
        this.index++;
        continue;
      }
      if (char === "}") {
        this.index++;
        // Return an ordinary object so callers' plain-object checks hold;
        // `__proto__` was stored as an own key above and is copied as data.
        const plain: Record<string, unknown> = {};
        for (const k of Object.keys(result)) {
          Object.defineProperty(plain, k, {
            value: result[k],
            enumerable: true,
            writable: true,
            configurable: true,
          });
        }
        return plain;
      }
      this.fail("Expected ',' or '}'", path);
    }
  }
}
