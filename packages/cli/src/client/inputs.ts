import { promises as fs } from "node:fs";
import path from "node:path";
import { PUBLIC_API_LIMITS } from "@orkestrator/protocol/public-api";
import { CliError } from "./errors.js";
import type { ClientIo } from "./io.js";

/**
 * Prompt and patch inputs are read from the caller's filesystem or stdin with
 * explicit byte limits, decoded as strict UTF-8, and never echoed. Content is
 * preserved exactly (no trimming, no newline normalization); only a prompt
 * that is empty or whitespace-only is rejected.
 */

export interface TextSourceOptions {
  file?: unknown;
  stdin?: unknown;
  inline?: unknown;
  label: string;
  maxBytes: number;
  /** Option names for messages, e.g. `--prompt-file`. */
  names: { file: string; stdin: string; inline?: string };
  required: boolean;
}

function decodeUtf8(bytes: Uint8Array, label: string): string {
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    throw new CliError("invalid-input", `${label} is not valid UTF-8`);
  }
}

async function readFileBounded(io: ClientIo, file: string, label: string, maxBytes: number) {
  const resolved = path.resolve(io.cwd, file);
  let handle: import("node:fs/promises").FileHandle;
  try {
    handle = await fs.open(resolved, "r");
  } catch {
    throw new CliError("invalid-input", `${label} file could not be opened`);
  }
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new CliError("invalid-input", `${label} file is not a regular file`);
    if (stat.size > maxBytes) {
      throw new CliError("input-too-large", `${label} is larger than ${maxBytes} bytes`);
    }
    const buffer = Buffer.alloc(Math.min(stat.size, maxBytes) + 1);
    let offset = 0;
    for (;;) {
      const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, null);
      if (bytesRead === 0) break;
      offset += bytesRead;
      if (offset > maxBytes) {
        throw new CliError("input-too-large", `${label} is larger than ${maxBytes} bytes`);
      }
      if (offset === buffer.length) break;
    }
    return buffer.subarray(0, offset);
  } finally {
    await handle.close();
  }
}

export async function readBinaryFile(
  io: ClientIo,
  file: string,
  label: string,
  maxBytes: number,
): Promise<Uint8Array> {
  return readFileBounded(io, file, label, maxBytes);
}

export async function readTextSource(
  io: ClientIo,
  options: TextSourceOptions,
): Promise<string | undefined> {
  const provided = [
    options.file !== undefined ? options.names.file : null,
    options.stdin === true ? options.names.stdin : null,
    options.inline !== undefined && options.names.inline ? options.names.inline : null,
  ].filter((value): value is string => value !== null);
  if (provided.length > 1) {
    throw new CliError("invalid-input", `${provided.join(", ")} are mutually exclusive`);
  }
  if (provided.length === 0) {
    if (options.required) {
      throw new CliError(
        "invalid-input",
        `${options.label} is required: pass ${[
          options.names.file,
          options.names.stdin,
          options.names.inline,
        ]
          .filter(Boolean)
          .join(", ")}`,
      );
    }
    return undefined;
  }
  let bytes: Uint8Array;
  if (typeof options.file === "string") {
    bytes = await readFileBounded(io, options.file, options.label, options.maxBytes);
  } else if (options.stdin === true) {
    bytes = await io.readStdin(options.maxBytes);
  } else {
    bytes = new TextEncoder().encode(String(options.inline));
    if (bytes.byteLength > options.maxBytes) {
      throw new CliError(
        "input-too-large",
        `${options.label} is larger than ${options.maxBytes} bytes`,
      );
    }
  }
  const text = decodeUtf8(bytes, options.label);
  if (text.trim().length === 0) {
    throw new CliError("empty-input", `${options.label} is empty`);
  }
  return text;
}

export async function readPrompt(
  io: ClientIo,
  options: Record<string, unknown>,
  required = true,
): Promise<string | undefined> {
  const prompt = await readTextSource(io, {
    file: options["prompt-file"],
    stdin: options["prompt-stdin"],
    inline: options.prompt,
    label: "Prompt",
    maxBytes: PUBLIC_API_LIMITS.promptMaxBytes,
    names: { file: "--prompt-file", stdin: "--prompt-stdin", inline: "--prompt" },
    required,
  });
  if (prompt !== undefined && prompt.length > PUBLIC_API_LIMITS.promptMaxChars) {
    throw new CliError(
      "input-too-large",
      `Prompt is longer than ${PUBLIC_API_LIMITS.promptMaxChars} characters`,
    );
  }
  return prompt;
}

/** A JSON patch document from `--patch-file` / `--patch-stdin`. */
export async function readPatch(
  io: ClientIo,
  options: Record<string, unknown>,
): Promise<Record<string, unknown> | undefined> {
  const text = await readTextSource(io, {
    file: options["patch-file"],
    stdin: options["patch-stdin"],
    label: "Patch",
    maxBytes: PUBLIC_API_LIMITS.patchMaxBytes,
    names: { file: "--patch-file", stdin: "--patch-stdin" },
    required: false,
  });
  if (text === undefined) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new CliError("invalid-input", "Patch is not valid JSON");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new CliError("invalid-input", "Patch must be a JSON object");
  }
  return parsed as Record<string, unknown>;
}
