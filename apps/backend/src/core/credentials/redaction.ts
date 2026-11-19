import { redactSecrets } from "@orkestrator/protocol/secret-redaction";

/**
 * The output boundary of a credential operation: every byte of output passes
 * through here before anything else (the agent's tool result, the operation
 * record, a log) can see it.
 *
 * It replaces each granted value, and these encodings of it, wherever they
 * appear: the exact text, JSON string escaping, URL (percent) encoding, and
 * standard and URL-safe base64 (also of `user:value` for basic auth). That is
 * the whole supported list. A program that transforms the value any other way
 * (reverses it, splits it across lines, hashes it, writes it to a file or the
 * network) is not stopped by this, and the documentation says so: filtering
 * catches accidental echoes, it is not isolation.
 *
 * Streaming: the tail of each chunk that could be the start of a value is
 * held back until the next chunk or `flush`, so a value split across chunks
 * is still caught. The hold is bounded by the longest pattern.
 */

/**
 * What replaces a value. The shape-based detector (`redactSecrets`) runs over
 * the same text afterwards and leaves exactly this marker alone, so it stays
 * readable after `token=[redacted]`.
 */
export const REDACTED_MARKER = "[redacted]";

export interface RedactionValue {
  value: string;
  label: string;
  /** Basic-auth user name; adds base64 of `user:value`. */
  basicUser?: string;
}

function base64(text: string): string {
  return Buffer.from(text, "utf8").toString("base64");
}

function variants(entry: RedactionValue): string[] {
  const { value } = entry;
  const forms = new Set<string>([value]);
  const json = JSON.stringify(value).slice(1, -1);
  forms.add(json);
  forms.add(encodeURIComponent(value));
  const encoded = base64(value);
  forms.add(encoded);
  forms.add(encoded.replace(/=+$/u, ""));
  forms.add(encoded.replace(/\+/gu, "-").replace(/\//gu, "_").replace(/=+$/u, ""));
  if (entry.basicUser !== undefined) {
    const basic = base64(`${entry.basicUser}:${value}`);
    forms.add(basic);
    forms.add(basic.replace(/=+$/u, ""));
  }
  return [...forms].filter((form) => form.length > 0);
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

export class StreamingRedactor {
  private readonly pattern: RegExp | null;
  private readonly replacements = new Map<string, string>();
  private readonly hold: number;
  private pending = "";

  constructor(values: readonly RedactionValue[]) {
    const forms: string[] = [];
    for (const entry of values) {
      for (const form of variants(entry)) {
        if (!this.replacements.has(form)) {
          this.replacements.set(form, REDACTED_MARKER);
          forms.push(form);
        }
      }
    }
    // Longest first, so a value that contains another is replaced whole.
    forms.sort((left, right) => right.length - left.length);
    this.pattern = forms.length ? new RegExp(forms.map(escapeRegExp).join("|"), "gu") : null;
    this.hold = forms.reduce((max, form) => Math.max(max, form.length), 0);
  }

  private replace(text: string): string {
    if (!this.pattern) return text;
    return text.replace(this.pattern, (match) => this.replacements.get(match) ?? "[redacted]");
  }

  /** Filters `chunk`; returns the text that is now safe to release. */
  push(chunk: string): string {
    if (!this.pattern) return chunk;
    const text = this.pending + chunk;
    // A value not yet complete starts within the last `hold - 1` characters,
    // so everything before that point can be decided now. A match that
    // straddles the point is complete, so the point moves to its end.
    let cut = Math.max(0, text.length - (this.hold - 1));
    let released = "";
    let position = 0;
    this.pattern.lastIndex = 0;
    for (let match = this.pattern.exec(text); match; match = this.pattern.exec(text)) {
      const start = match.index;
      const end = start + match[0].length;
      if (start >= cut) break;
      released += text.slice(position, start) + (this.replacements.get(match[0]) ?? "[redacted]");
      position = end;
      if (end > cut) cut = end;
    }
    released += text.slice(position, Math.max(position, cut));
    this.pending = text.slice(Math.max(position, cut));
    return released;
  }

  /** Releases the held tail at the end of the stream. */
  flush(): string {
    const rest = this.replace(this.pending);
    this.pending = "";
    return rest;
  }
}

/** Filters a whole text at once, then applies the shape-based detector. */
export function redactCredentialText(text: string, values: readonly RedactionValue[]): string {
  const redactor = new StreamingRedactor(values);
  return redactSecrets(redactor.push(text) + redactor.flush());
}

/**
 * A bounded tail of filtered text. Output beyond `maxBytes` keeps the most
 * recent part, which is where errors usually are.
 */
export class BoundedTail {
  private text = "";
  private truncated = false;

  constructor(private readonly maxChars: number) {}

  append(text: string): void {
    if (!text) return;
    this.text += text;
    if (this.text.length > this.maxChars * 2) this.trim();
  }

  private trim(): void {
    if (this.text.length > this.maxChars) {
      this.text = this.text.slice(this.text.length - this.maxChars);
      this.truncated = true;
    }
  }

  snapshot(): { text: string; truncated: boolean } {
    this.trim();
    return { text: redactSecrets(this.text), truncated: this.truncated };
  }
}
