import { describe, expect, test } from "bun:test";
import { BoundedTail, StreamingRedactor, redactCredentialText } from "./redaction.js";

const SECRET = "sk-test-0123456789abcdef";

function streamed(values: string[], chunks: string[]): string {
  const redactor = new StreamingRedactor(values.map((value) => ({ value, label: "token" })));
  return chunks.map((chunk) => redactor.push(chunk)).join("") + redactor.flush();
}

describe("StreamingRedactor", () => {
  test("replaces a value inside one chunk", () => {
    expect(streamed([SECRET], [`before ${SECRET} after`])).toBe("before [redacted] after");
  });

  test("catches a value split across every possible chunk boundary", () => {
    const text = `x ${SECRET} y ${SECRET}`;
    for (let cut = 0; cut <= text.length; cut += 1) {
      const output = streamed([SECRET], [text.slice(0, cut), text.slice(cut)]);
      expect(output).not.toContain(SECRET);
      expect(output).toBe("x [redacted] y [redacted]");
    }
  });

  test("catches a value fed one character at a time", () => {
    const text = `start${SECRET}end`;
    expect(streamed([SECRET], [...text])).toBe("start[redacted]end");
  });

  test("replaces the supported encodings", () => {
    const value = 'p@ss "word"/+=';
    const forms = [
      value,
      JSON.stringify(value).slice(1, -1),
      encodeURIComponent(value),
      Buffer.from(value).toString("base64"),
      Buffer.from(value).toString("base64url"),
    ];
    for (const form of forms) {
      expect(streamed([value], [`a ${form} b`])).not.toContain(form);
    }
  });

  test("replaces base64 of user:value for basic auth", () => {
    const redactor = new StreamingRedactor([{ value: SECRET, label: "token", basicUser: "me" }]);
    const basic = Buffer.from(`me:${SECRET}`).toString("base64");
    expect(redactor.push(`Authorization: Basic ${basic}`) + redactor.flush()).not.toContain(basic);
  });

  test("handles several values and a value containing another", () => {
    const short = "abcd1234";
    const long = `${short}-extended`;
    const output = streamed([short, long], [`${long} and ${short}`]);
    expect(output).not.toContain(short);
    expect(output).toBe("[redacted] and [redacted]");
  });

  test("multiline values", () => {
    const pem = "-----BEGIN KEY-----\nAAAABBBBCCCC\n-----END KEY-----";
    const text = `key:\n${pem}\ndone`;
    expect(streamed([pem], [text.slice(0, 20), text.slice(20)])).toBe("key:\n[redacted]\ndone");
  });

  test("text without values passes through unchanged", () => {
    expect(streamed([SECRET], ["plain ", "output\n"])).toBe("plain output\n");
  });
});

describe("redactCredentialText", () => {
  test("also applies the shape-based detector", () => {
    const output = redactCredentialText(`value ${SECRET}`, [{ value: SECRET, label: "key" }]);
    expect(output).toBe("value [redacted]");
  });
});

describe("BoundedTail", () => {
  test("keeps the most recent text and reports truncation", () => {
    const tail = new BoundedTail(10);
    tail.append("0123456789");
    tail.append("abcdef");
    expect(tail.snapshot()).toEqual({ text: "6789abcdef", truncated: true });
  });
});
