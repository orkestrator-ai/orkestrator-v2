/**
 * Decodes a workflow result a model sent as JSON text instead of an object.
 *
 * Some models (Haiku 5.5 on a large consolidated report, issue #2470) pass
 * `result` as a JSON-encoded string. The tool's input check used to refuse it
 * with `$: Expected object, received string`, which told the model nothing
 * about the real fault: the string was not valid JSON, because one stray `}`
 * closed the report early. The model read the refusal as a transport problem
 * and resent the same text until the step failed.
 *
 * Now a string is parsed here. Valid text is used as if it had been sent as an
 * object. Invalid text is refused with where it breaks: the character offset,
 * line and column, the field path at that point, what was expected there, and
 * a short excerpt, so the model can repair the one fault instead of retyping
 * the whole report.
 *
 * `JSON.parse` reports no position under Bun, so the fault is found by a small
 * scanner of its own, run only on text `JSON.parse` already refused.
 */

/** Characters of excerpt shown before and after the fault. */
const EXCERPT_BEFORE = 60;
const EXCERPT_AFTER = 40;

export type JsonTextResultDecode =
  | { ok: true; value: Record<string, unknown> }
  | {
      ok: false;
      /** The whole refusal, excerpt included, for the model that wrote the text. */
      message: string;
      /**
       * The refusal without the excerpt: offsets, the field path and what was
       * expected. Kept for the result reminder, which is a durable prompt.
       */
      summary: string;
    };

/** Where a JSON text stops being valid, and why. */
interface JsonTextFault {
  offset: number;
  /** What is wrong, as one clause ("expected `,` or `}`"). */
  problem: string;
  /** Advice that only applies to this fault, as one sentence. */
  advice?: string;
}

type Frame =
  | {
      kind: "object";
      key?: string;
      state: "key-or-end" | "key" | "colon" | "value" | "comma-or-end";
    }
  | { kind: "array"; index: number; state: "value-or-end" | "value" | "comma-or-end" };

const NUMBER = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/y;
const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

function describeValue(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "an array";
  return typeof value === "object" ? "an object" : `a ${typeof value}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * `result` given as text. Valid JSON that encodes an object is returned as
 * that object (text that encodes another JSON string is unwrapped once, for a
 * payload encoded twice). Anything else is refused with a positioned reason.
 */
export function decodeJsonTextResult(text: string): JsonTextResultDecode {
  const first = tryParse(text);
  if (first.ok) {
    if (isRecord(first.value)) return { ok: true, value: first.value };
    if (typeof first.value === "string") {
      const second = tryParse(first.value);
      if (second.ok && isRecord(second.value)) return { ok: true, value: second.value };
      if (!second.ok) return refusal(first.value, " (after decoding it once more)");
      return wrongType(second.value);
    }
    return wrongType(first.value);
  }
  return refusal(text, "");
}

function tryParse(text: string): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    return { ok: false };
  }
}

function wrongType(value: unknown): JsonTextResultDecode {
  const summary = `\`result\` is a string of JSON text that decodes to ${describeValue(value)}, not an object. Pass the result itself as a JSON object in \`result\`, not as a string.`;
  return { ok: false, message: summary, summary };
}

function refusal(text: string, decoding: string): JsonTextResultDecode {
  const fault = findJsonTextFault(text) ?? {
    offset: text.length,
    problem: "the text is not valid JSON",
  };
  const { line, column } = lineAndColumn(text, fault.offset);
  const summary = [
    `\`result\` is a string, and it is not valid JSON${decoding}: at character ${fault.offset} (line ${line}, column ${column}) ${fault.problem}.`,
    fault.advice,
    "Fix only that point, keep the rest of the content, and pass the result as a JSON object in `result` rather than as a string.",
  ]
    .filter(Boolean)
    .join(" ");
  return {
    ok: false,
    summary,
    message: `${summary} Near the fault: ${excerpt(text, fault.offset)}`,
  };
}

function lineAndColumn(text: string, offset: number): { line: number; column: number } {
  let line = 1;
  let lineStart = 0;
  for (let index = text.indexOf("\n"); index !== -1 && index < offset;) {
    line += 1;
    lineStart = index + 1;
    index = text.indexOf("\n", lineStart);
  }
  return { line, column: offset - lineStart + 1 };
}

function excerpt(text: string, offset: number): string {
  const start = Math.max(0, offset - EXCERPT_BEFORE);
  const end = Math.min(text.length, offset + EXCERPT_AFTER);
  // Only control characters are escaped, so the excerpt reads like the text.
  const shown = (part: string) =>
    part.replace(/[\u0000-\u001f]/g, (char) => JSON.stringify(char).slice(1, -1));
  return `\`${start > 0 ? "…" : ""}${shown(text.slice(start, offset))}⟪HERE⟫${shown(text.slice(offset, end))}${end < text.length ? "…" : ""}\``;
}

function quote(char: string | undefined): string {
  if (char === undefined) return "the end of the text";
  return `\`${JSON.stringify(char).slice(1, -1)}\``;
}

function pathOf(stack: readonly Frame[]): string {
  let path = "$";
  for (const frame of stack) {
    if (frame.kind === "array") path += `[${frame.index}]`;
    else if (frame.key !== undefined)
      path += IDENTIFIER.test(frame.key) ? `.${frame.key}` : `[${JSON.stringify(frame.key)}]`;
  }
  return path;
}

/**
 * The first point at which `text` stops being one JSON value, or null when it
 * is valid. Iterative, so a deeply nested text cannot exhaust the stack.
 */
export function findJsonTextFault(text: string): JsonTextFault | null {
  const stack: Frame[] = [];
  let pos = 0;
  let started = false;

  const skipWhitespace = () => {
    while (pos < text.length) {
      const char = text[pos];
      if (char !== " " && char !== "\n" && char !== "\r" && char !== "\t") break;
      pos += 1;
    }
  };

  /** Reads a string at `pos` (which holds `"`); returns its value or a fault. */
  const readString = (): string | JsonTextFault => {
    const start = pos;
    let value = "";
    pos += 1;
    while (pos < text.length) {
      const char = text[pos]!;
      if (char === '"') {
        pos += 1;
        return value;
      }
      if (char === "\\") {
        const escape = text[pos + 1];
        if (escape === "u") {
          const hex = text.slice(pos + 2, pos + 6);
          if (!/^[0-9a-fA-F]{4}$/.test(hex)) {
            return {
              offset: pos,
              problem: "a `\\u` escape is not followed by four hexadecimal digits",
            };
          }
          value += String.fromCharCode(Number.parseInt(hex, 16));
          pos += 6;
          continue;
        }
        const simple: Record<string, string> = {
          '"': '"',
          "\\": "\\",
          "/": "/",
          b: "\b",
          f: "\f",
          n: "\n",
          r: "\r",
          t: "\t",
        };
        if (escape === undefined || !(escape in simple)) {
          return {
            offset: pos,
            problem: `a string contains the invalid escape \`\\${escape ?? ""}\``,
            advice: "Write a literal backslash as `\\\\`.",
          };
        }
        value += simple[escape];
        pos += 2;
        continue;
      }
      if (char < " ") {
        return {
          offset: pos,
          problem: "a string contains an unescaped control character (a raw line break or tab)",
          advice: "Write a line break inside a string as `\\n` and a tab as `\\t`.",
        };
      }
      value += char;
      pos += 1;
    }
    return {
      offset: start,
      problem: `the string that starts here, inside \`${pathOf(stack)}\`, is never closed`,
      advice: 'A `"` inside a string must be written as `\\"`.',
    };
  };

  /** Reads one value at `pos`; containers are pushed, scalars consumed. */
  const readValue = (): JsonTextFault | "scalar" | "container" => {
    const char = text[pos];
    if (char === "{") {
      stack.push({ kind: "object", state: "key-or-end" });
      pos += 1;
      return "container";
    }
    if (char === "[") {
      stack.push({ kind: "array", index: 0, state: "value-or-end" });
      pos += 1;
      return "container";
    }
    if (char === '"') {
      const read = readString();
      return typeof read === "string" ? "scalar" : read;
    }
    NUMBER.lastIndex = pos;
    const number = NUMBER.exec(text);
    if (number) {
      pos += number[0].length;
      return "scalar";
    }
    for (const literal of ["true", "false", "null"]) {
      if (text.startsWith(literal, pos)) {
        pos += literal.length;
        return "scalar";
      }
    }
    return {
      offset: pos,
      problem: `${quote(char)} appears where a value of \`${pathOf(stack)}\` was expected`,
      ...(char === "'" ? { advice: "JSON strings use double quotes." } : {}),
    };
  };

  /** Moves the enclosing container on after a complete value. */
  const afterValue = () => {
    const top = stack.at(-1);
    if (top) top.state = "comma-or-end";
  };

  /** The fault for text that follows the completed root value, or null. */
  const trailing = (closer: { char: string; offset: number; lastKey?: string } | null) => {
    skipWhitespace();
    if (pos >= text.length) return null;
    if (!closer) {
      return {
        offset: pos,
        problem: "more text follows a complete JSON value",
        advice: "Pass exactly one JSON object.",
      };
    }
    const after =
      closer.lastKey !== undefined ? ` right after its field \`${closer.lastKey}\`` : "";
    return {
      offset: pos,
      problem: `more text follows, but the \`${closer.char}\` at character ${closer.offset} already closed the top-level value${after}`,
      advice: `There is one closing \`}\` or \`]\` too many at or before character ${closer.offset}: remove the extra one so the fields that follow stay inside the top-level object.`,
    };
  };

  while (true) {
    skipWhitespace();
    if (!started) {
      started = true;
      if (pos >= text.length) return { offset: pos, problem: "the text is empty" };
      const read = readValue();
      if (typeof read === "object") return read;
      if (read === "scalar") return trailing(null);
      continue;
    }
    const top = stack.at(-1);
    if (!top) return null;
    const char = text[pos];
    if (char === undefined) {
      const open = stack.map((frame) => (frame.kind === "object" ? "}" : "]")).reverse();
      return {
        offset: pos,
        problem: `the text ends while \`${pathOf(stack.slice(0, -1))}\` is still open (${stack.length} unclosed bracket${stack.length === 1 ? "" : "s"} in all)`,
        advice: `It is missing the closing \`${open.join("")}\` (in that order) or a value before them.`,
      };
    }
    const close = (closing: string) => {
      const frame = stack.pop()!;
      const closer = {
        char: closing,
        offset: pos,
        ...(frame.kind === "object" && frame.key !== undefined ? { lastKey: frame.key } : {}),
      };
      pos += 1;
      if (stack.length === 0) return trailing(closer);
      afterValue();
      return undefined;
    };
    if (top.kind === "object") {
      switch (top.state) {
        case "key-or-end":
        case "key": {
          if (char === '"') {
            const key = readString();
            if (typeof key !== "string") return key;
            top.key = key;
            top.state = "colon";
            continue;
          }
          if (char === "}" && top.state === "key-or-end") {
            const fault = close("}");
            if (fault !== undefined) return fault;
            continue;
          }
          return {
            offset: pos,
            problem:
              char === "}"
                ? `a comma after \`${pathOf(stack)}\` is followed by \`}\` instead of another field`
                : `${quote(char)} appears where a quoted field name was expected, inside \`${pathOf(stack)}\``,
            ...(char === "}" ? { advice: "Remove the trailing comma." } : {}),
          };
        }
        case "colon":
          if (char === ":") {
            pos += 1;
            top.state = "value";
            continue;
          }
          return {
            offset: pos,
            problem: `${quote(char)} appears where \`:\` was expected after the field name \`${pathOf(stack)}\``,
          };
        case "value": {
          const read = readValue();
          if (typeof read === "object") return read;
          if (read === "scalar") afterValue();
          continue;
        }
        case "comma-or-end":
          if (char === ",") {
            pos += 1;
            top.state = "key";
            continue;
          }
          if (char === "}") {
            const fault = close("}");
            if (fault !== undefined) return fault;
            continue;
          }
          return {
            offset: pos,
            problem: `${quote(char)} appears where \`,\` or \`}\` was expected, after \`${pathOf(stack)}\``,
            ...(char === "]"
              ? {
                  advice:
                    "That `]` closes an array that is not open here: an object's `}` is probably missing before it, or the `]` is extra.",
                }
              : {}),
          };
      }
    } else {
      switch (top.state) {
        case "value-or-end":
        case "value": {
          if (char === "]") {
            if (top.state === "value-or-end") {
              const fault = close("]");
              if (fault !== undefined) return fault;
              continue;
            }
            return {
              offset: pos,
              problem: `a comma inside \`${pathOf(stack.slice(0, -1))}\` is followed by \`]\` instead of another item`,
              advice: "Remove the trailing comma.",
            };
          }
          const read = readValue();
          if (typeof read === "object") return read;
          if (read === "scalar") afterValue();
          continue;
        }
        case "comma-or-end":
          if (char === ",") {
            pos += 1;
            top.index += 1;
            top.state = "value";
            continue;
          }
          if (char === "]") {
            const fault = close("]");
            if (fault !== undefined) return fault;
            continue;
          }
          return {
            offset: pos,
            problem: `${quote(char)} appears where \`,\` or \`]\` was expected, after \`${pathOf(stack)}\``,
            ...(char === "}"
              ? {
                  advice:
                    "That `}` closes an object that is not open here: an array's `]` is probably missing before it, or the `}` is extra.",
                }
              : {}),
          };
      }
    }
  }
}
