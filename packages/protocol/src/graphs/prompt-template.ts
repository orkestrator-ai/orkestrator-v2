/**
 * The logic-less prompt template engine (plan P1.5, D13, report §5.6).
 *
 * A Mustache-style subset, and nothing executable:
 *
 * - `{{a.b.c}}` interpolates a value; `{{.}}` is the current element.
 * - `{{#list}}…{{/list}}` repeats over a list, or renders once for any other
 *   truthy value with that value as the context; `{{^list}}…{{/list}}`
 *   renders only when the value is missing, null, false, empty, `0` or `[]`.
 * - `{{> input.<port>}}` expands an input port in its render mode (item 105's
 *   `prompt-render.ts`); type markdown templates take no partials.
 * - `{{! comment }}` renders nothing.
 *
 * Lookup follows Mustache: the first segment is searched from the innermost
 * context outwards, and the rest of the path is followed from where it was
 * found, without falling back. Only own properties of plain objects and
 * in-range indices of arrays are read, so `{{constructor}}`, `{{__proto__}}`
 * or `{{list.length}}` never reach a prototype. A tag that is not part of the
 * subset (`{{{raw}}}`, `{{= =}}`, `{{each items}}`, `{{a + b}}`) and a name
 * that does not resolve render literally, as the text the author wrote.
 *
 * Section, inverted, close and comment tags on a line of their own take the
 * line with them, as in Mustache. Parsing and rendering are bounded (size,
 * nesting, sections, tags, iterations, output) and never throw: problems are
 * diagnostics. Browser-safe.
 */
import {
  serializeFramedEvidence,
  wrapGraphInlineEvidenceFrame,
} from "../review-evidence-frames.js";
import { graphUtf8Bytes } from "./grammar.js";

// ------------------------------------------------------------- diagnostics

export type GraphPromptDiagnosticSeverity = "error" | "warning" | "info";

/** Every code the prompt engine, renderer and linter report (item 105). */
export const GRAPH_PROMPT_DIAGNOSTIC_CODES = [
  // Parse (prompt-template.ts).
  "prompt-template-too-large",
  "prompt-template-too-deep",
  "prompt-template-too-many-sections",
  "prompt-template-too-many-tags",
  "prompt-template-unclosed-tag",
  "prompt-template-unclosed-section",
  "prompt-template-unexpected-close",
  "prompt-template-unsupported-tag",
  "prompt-template-invalid-tag",
  "prompt-template-invalid-partial",
  // Render (prompt-template.ts, prompt-render.ts).
  "prompt-output-truncated",
  "prompt-value-missing",
  "prompt-input-missing",
  "prompt-input-not-json",
  "prompt-input-over-budget",
  "prompt-file-ref-invalid",
  "prompt-artifact-ref-invalid",
  "prompt-result-key-invalid",
  "prompt-capability-invalid",
  "prompt-built-in-preview",
  // Lint (prompt-lint.ts).
  "prompt-unbound-variable",
  "prompt-unknown-variable",
  "prompt-unknown-field",
  "prompt-container-variable",
  "prompt-unbound-partial",
  "prompt-branch-variable-before-shared-input",
  "prompt-prose-output",
  "prompt-profile-contradiction",
  "prompt-reserved-marker",
  "prompt-input-unused",
  "prompt-summary-unavailable",
  "prompt-markdown-unavailable",
  "prompt-size-over-ceiling",
  "prompt-built-in-unknown",
  "prompt-built-in-input",
  "prompt-built-in-output",
  "prompt-built-in-extra-input",
  "prompt-built-in-profile",
] as const;
export type GraphPromptDiagnosticCode = (typeof GRAPH_PROMPT_DIAGNOSTIC_CODES)[number];

export interface GraphPromptDiagnostic {
  code: GraphPromptDiagnosticCode;
  severity: GraphPromptDiagnosticSeverity;
  /** Content-free apart from names the author wrote (variable paths, ports). */
  message: string;
  /** UTF-16 offset into the template, when the diagnostic points into it. */
  offset?: number;
  length?: number;
  /** The variable or partial path, when there is one. */
  path?: string;
  /** The input port, when the diagnostic is about one. */
  port?: string;
  /** Where the text came from when it is not the node's template: `lens:<key>`. */
  source?: string;
}

/** Diagnostics kept per call; the rest are counted, not listed. */
export const GRAPH_PROMPT_MAX_DIAGNOSTICS = 64;

/** Bounded diagnostic list: keeps the first {@link GRAPH_PROMPT_MAX_DIAGNOSTICS}. */
export class GraphPromptDiagnostics {
  readonly list: GraphPromptDiagnostic[] = [];
  omitted = 0;

  add(diagnostic: GraphPromptDiagnostic): void {
    if (this.list.length >= GRAPH_PROMPT_MAX_DIAGNOSTICS) {
      this.omitted++;
      return;
    }
    this.list.push({ ...diagnostic, message: diagnostic.message.slice(0, 300) });
  }

  addAll(diagnostics: readonly GraphPromptDiagnostic[]): void {
    for (const diagnostic of diagnostics) this.add(diagnostic);
  }
}

// ---------------------------------------------------------------- limits

const KIB = 1024;

export interface GraphPromptTemplateLimits {
  /** Template source, in UTF-8 bytes. The node guard holds templates to 32 KiB. */
  maxBytes: number;
  /** Nested sections. */
  maxDepth: number;
  maxSections: number;
  /** Tags of every kind; the rest of a longer template renders as text. */
  maxTags: number;
  /** Characters of one variable name. */
  maxNameChars: number;
  /** Dotted segments in one name. */
  maxSegments: number;
}

export const GRAPH_PROMPT_TEMPLATE_LIMITS: Readonly<GraphPromptTemplateLimits> = Object.freeze({
  maxBytes: 64 * KIB,
  maxDepth: 8,
  maxSections: 256,
  maxTags: 2048,
  maxNameChars: 256,
  maxSegments: 16,
});

export interface GraphPromptRenderLimits {
  /** Output, in UTF-8 bytes; rendering stops there with a diagnostic. */
  maxOutputBytes: number;
  /** Section body executions over the whole render. */
  maxIterations: number;
}

export const GRAPH_PROMPT_RENDER_LIMITS: Readonly<GraphPromptRenderLimits> = Object.freeze({
  maxOutputBytes: 8 * 1024 * KIB,
  maxIterations: 100_000,
});

// ------------------------------------------------------------------- AST

export type GraphPromptNode =
  | { kind: "text"; text: string; offset: number }
  | {
      kind: "variable";
      /** Dotted segments; `["."]` for the current element. */
      path: string[];
      /** The tag as written, rendered when the name does not resolve. */
      raw: string;
      offset: number;
    }
  | {
      kind: "section";
      inverted: boolean;
      path: string[];
      raw: string;
      offset: number;
      children: GraphPromptNode[];
    }
  | { kind: "partial"; port: string; raw: string; offset: number };

export interface GraphPromptTemplate {
  nodes: GraphPromptNode[];
  diagnostics: GraphPromptDiagnostic[];
  /** UTF-8 bytes of the source. */
  bytes: number;
}

export interface GraphPromptParseOptions {
  /** `{{> input.<port>}}` is allowed (node templates); type markdown templates take none. */
  allowPartials?: boolean;
  limits?: Partial<GraphPromptTemplateLimits>;
}

const SEGMENT = /^(?:[A-Za-z_][A-Za-z0-9_-]*|0|[1-9][0-9]*)$/;
const PORT_KEY = /^[a-z][A-Za-z0-9_]*$/;

/** Parse `a.b.c` or `.`; null when it is not a name in the subset. */
export function parseGraphPromptPath(
  name: string,
  limits: Pick<
    GraphPromptTemplateLimits,
    "maxNameChars" | "maxSegments"
  > = GRAPH_PROMPT_TEMPLATE_LIMITS,
): string[] | null {
  if (name === ".") return ["."];
  if (name.length === 0 || name.length > limits.maxNameChars) return null;
  const segments = name.split(".");
  if (segments.length > limits.maxSegments) return null;
  return segments.every((segment) => SEGMENT.test(segment)) ? segments : null;
}

type Token =
  | { type: "text"; text: string; offset: number }
  | {
      type: "tag";
      sigil: "" | "#" | "^" | "/" | ">" | "!";
      body: string;
      raw: string;
      offset: number;
    };

const STANDALONE_SIGILS = new Set(["#", "^", "/", "!"]);

function tokenize(
  source: string,
  limits: GraphPromptTemplateLimits,
  diagnostics: GraphPromptDiagnostics,
): Token[] {
  const tokens: Token[] = [];
  let cursor = 0;
  let tags = 0;
  const pushText = (text: string, offset: number) => {
    if (text.length > 0) tokens.push({ type: "text", text, offset });
  };
  while (cursor < source.length) {
    const open = source.indexOf("{{", cursor);
    if (open < 0) break;
    const close = source.indexOf("}}", open + 2);
    if (close < 0) {
      diagnostics.add({
        code: "prompt-template-unclosed-tag",
        severity: "warning",
        message: "A `{{` has no closing `}}`; the rest of the template renders as written",
        offset: open,
        length: source.length - open,
      });
      break;
    }
    if (tags >= limits.maxTags) {
      diagnostics.add({
        code: "prompt-template-too-many-tags",
        severity: "error",
        message: `More than ${limits.maxTags} tags; the rest of the template renders as written`,
        offset: open,
      });
      break;
    }
    tags++;
    pushText(source.slice(cursor, open), cursor);
    const raw = source.slice(open, close + 2);
    const inner = source.slice(open + 2, close);
    const first = inner.trimStart()[0] ?? "";
    if (first === "#" || first === "^" || first === "/" || first === ">" || first === "!") {
      const body = inner.trimStart().slice(1).trim();
      tokens.push({ type: "tag", sigil: first, body, raw, offset: open });
    } else {
      tokens.push({ type: "tag", sigil: "", body: inner.trim(), raw, offset: open });
    }
    cursor = close + 2;
  }
  pushText(source.slice(cursor), cursor);
  return tokens;
}

/**
 * Mustache's standalone rule: a section, inverted, close or comment tag alone
 * on its line (whitespace aside) removes that line. Decided on the original
 * text first, then applied, so adjacent standalone lines both qualify.
 */
function stripStandaloneLines(tokens: Token[]): Token[] {
  const cutStart = new Map<number, number>();
  const cutEnd = new Map<number, number>();
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index]!;
    if (token.type !== "tag" || !STANDALONE_SIGILS.has(token.sigil)) continue;
    const previous = index > 0 ? tokens[index - 1]! : undefined;
    const next = index + 1 < tokens.length ? tokens[index + 1]! : undefined;
    let left: number | undefined;
    if (!previous) left = undefined;
    else if (previous.type !== "text") continue;
    else {
      const newline = previous.text.lastIndexOf("\n");
      const tail = previous.text.slice(newline + 1);
      if (!/^[ \t]*$/.test(tail)) continue;
      if (newline < 0 && index - 1 !== 0) continue;
      left = newline + 1;
    }
    let right: number | undefined;
    if (!next) right = undefined;
    else if (next.type !== "text") continue;
    else {
      const newline = next.text.indexOf("\n");
      const head = newline < 0 ? next.text : next.text.slice(0, newline);
      if (!/^[ \t\r]*$/.test(head)) continue;
      if (newline < 0 && index + 1 !== tokens.length - 1) continue;
      right = newline < 0 ? next.text.length : newline + 1;
    }
    if (previous && left !== undefined) cutEnd.set(index - 1, left);
    if (next && right !== undefined) cutStart.set(index + 1, right);
  }
  if (cutStart.size === 0 && cutEnd.size === 0) return tokens;
  return tokens.map((token, index) => {
    if (token.type !== "text") return token;
    const start = cutStart.get(index) ?? 0;
    const end = cutEnd.get(index) ?? token.text.length;
    return {
      ...token,
      text: token.text.slice(start, Math.max(start, end)),
      offset: token.offset + start,
    };
  });
}

interface OpenSection {
  node: Extract<GraphPromptNode, { kind: "section" }>;
  name: string;
  parent: GraphPromptNode[];
}

/** Parse a template. Never throws; problems are diagnostics, and odd tags render as written. */
export function parseGraphPromptTemplate(
  source: string,
  options: GraphPromptParseOptions = {},
): GraphPromptTemplate {
  const limits = { ...GRAPH_PROMPT_TEMPLATE_LIMITS, ...options.limits };
  const diagnostics = new GraphPromptDiagnostics();
  if (typeof source !== "string") {
    diagnostics.add({
      code: "prompt-template-too-large",
      severity: "error",
      message: "The template is not text",
    });
    return { nodes: [], diagnostics: diagnostics.list, bytes: 0 };
  }
  const bytes = graphUtf8Bytes(source);
  if (bytes > limits.maxBytes) {
    diagnostics.add({
      code: "prompt-template-too-large",
      severity: "error",
      message: `The template is ${bytes} bytes; the limit is ${limits.maxBytes}`,
    });
    return { nodes: [], diagnostics: diagnostics.list, bytes };
  }
  const tokens = stripStandaloneLines(tokenize(source, limits, diagnostics));
  const root: GraphPromptNode[] = [];
  const stack: OpenSection[] = [];
  let current = root;
  let sections = 0;
  const literal = (text: string, offset: number) => {
    const last = current.at(-1);
    if (last?.kind === "text") last.text += text;
    else current.push({ kind: "text", text, offset });
  };
  for (const token of tokens) {
    if (token.type === "text") {
      if (token.text.length > 0) literal(token.text, token.offset);
      continue;
    }
    const { sigil, body, raw, offset } = token;
    if (sigil === "!") continue;
    if (sigil === ">") {
      const port = body.startsWith("input.") ? body.slice("input.".length) : "";
      if (!options.allowPartials || !PORT_KEY.test(port)) {
        diagnostics.add({
          code: "prompt-template-invalid-partial",
          severity: options.allowPartials ? "warning" : "error",
          message: options.allowPartials
            ? "A partial must be `{{> input.<port>}}`; this one renders as written"
            : "This template takes no partials; the tag renders as written",
          offset,
          length: raw.length,
          path: body.slice(0, 64),
        });
        literal(raw, offset);
        continue;
      }
      current.push({ kind: "partial", port, raw, offset });
      continue;
    }
    if (body.startsWith("{") || body.startsWith("&") || body.startsWith("=")) {
      diagnostics.add({
        code: "prompt-template-unsupported-tag",
        severity: "info",
        message:
          "Unescaped and delimiter tags are not part of the template language; the tag renders as written",
        offset,
        length: raw.length,
      });
      literal(raw, offset);
      continue;
    }
    const path = parseGraphPromptPath(body, limits);
    if (!path) {
      diagnostics.add({
        code: "prompt-template-invalid-tag",
        severity: "info",
        message: "Not a variable name; the tag renders as written",
        offset,
        length: raw.length,
      });
      literal(raw, offset);
      continue;
    }
    const name = path.join(".");
    if (sigil === "") {
      current.push({ kind: "variable", path, raw, offset });
      continue;
    }
    if (sigil === "/") {
      const top = stack.at(-1);
      if (!top || top.name !== name) {
        diagnostics.add({
          code: "prompt-template-unexpected-close",
          severity: "warning",
          message: top
            ? `\`{{/${name}}}\` does not close \`{{#${top.name}}}\`; it renders as written`
            : `\`{{/${name}}}\` closes no section; it renders as written`,
          offset,
          length: raw.length,
          path: name,
        });
        literal(raw, offset);
        continue;
      }
      stack.pop();
      current = top.parent;
      continue;
    }
    // `#` or `^`.
    if (stack.length >= limits.maxDepth) {
      diagnostics.add({
        code: "prompt-template-too-deep",
        severity: "error",
        message: `Sections nest more than ${limits.maxDepth} deep; this one renders as written`,
        offset,
        length: raw.length,
        path: name,
      });
      literal(raw, offset);
      continue;
    }
    if (sections >= limits.maxSections) {
      diagnostics.add({
        code: "prompt-template-too-many-sections",
        severity: "error",
        message: `More than ${limits.maxSections} sections; this one renders as written`,
        offset,
        length: raw.length,
        path: name,
      });
      literal(raw, offset);
      continue;
    }
    sections++;
    const node: Extract<GraphPromptNode, { kind: "section" }> = {
      kind: "section",
      inverted: sigil === "^",
      path,
      raw,
      offset,
      children: [],
    };
    current.push(node);
    stack.push({ node, name, parent: current });
    current = node.children;
  }
  // Unclosed sections render their open tag as written; their contents stay.
  while (stack.length > 0) {
    const open = stack.pop()!;
    diagnostics.add({
      code: "prompt-template-unclosed-section",
      severity: "warning",
      message: `\`${open.node.raw}\` is never closed; it renders as written`,
      offset: open.node.offset,
      length: open.node.raw.length,
      path: open.name,
    });
    const index = open.parent.indexOf(open.node);
    open.parent.splice(
      index,
      1,
      { kind: "text", text: open.node.raw, offset: open.node.offset },
      ...open.node.children,
    );
  }
  return { nodes: mergeText(root), diagnostics: diagnostics.list, bytes };
}

function mergeText(nodes: GraphPromptNode[]): GraphPromptNode[] {
  const merged: GraphPromptNode[] = [];
  for (const node of nodes) {
    if (node.kind === "section") node.children = mergeText(node.children);
    const last = merged.at(-1);
    if (node.kind === "text" && last?.kind === "text") last.text += node.text;
    else if (node.kind !== "text" || node.text.length > 0) merged.push(node);
  }
  return merged;
}

/** Visit every node, depth first, in source order. */
export function walkGraphPromptNodes(
  nodes: readonly GraphPromptNode[],
  visit: (node: GraphPromptNode, depth: number) => void,
  depth = 0,
): void {
  for (const node of nodes) {
    visit(node, depth);
    if (node.kind === "section") walkGraphPromptNodes(node.children, visit, depth + 1);
  }
}

// ---------------------------------------------------------------- lookup

export type GraphPromptLookup = { found: true; value: unknown } | { found: false };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/** One step of a path: own properties of plain objects, in-range indices of arrays. */
export function graphPromptOwnValue(value: unknown, segment: string): GraphPromptLookup {
  if (Array.isArray(value)) {
    if (!/^(?:0|[1-9][0-9]*)$/.test(segment)) return { found: false };
    const index = Number(segment);
    return index < value.length ? { found: true, value: value[index] } : { found: false };
  }
  if (isPlainObject(value) && Object.hasOwn(value, segment)) {
    return { found: true, value: value[segment] };
  }
  return { found: false };
}

/** How the root of a context stack is read. */
export interface GraphPromptLookupOptions {
  /** Exact dotted names resolved at the root first (`item.index`). */
  aliases?: ReadonlyMap<string, unknown>;
  /**
   * Root names that hold other names rather than a value (`input`, `params`):
   * `{{input}}` alone, and `{{.}}` at the root, do not resolve.
   */
  containers?: ReadonlySet<string>;
}

/** Where a lookup found its value: the context level, and whether a root alias answered. */
type GraphPromptLocatedLookup =
  { found: true; value: unknown; level: number; alias: boolean } | { found: false };

function locateGraphPromptPath(
  stack: readonly unknown[],
  path: readonly string[],
  options: GraphPromptLookupOptions,
): GraphPromptLocatedLookup {
  if (path.length === 1 && path[0] === ".") {
    if (stack.length === 0 || (stack.length === 1 && options.containers)) return { found: false };
    return { found: true, value: stack.at(-1), level: stack.length - 1, alias: false };
  }
  for (let level = stack.length - 1; level >= 0; level--) {
    if (level === 0) {
      const name = path.join(".");
      if (options.aliases?.has(name)) {
        return { found: true, value: options.aliases.get(name), level, alias: true };
      }
      if (path.length === 1 && options.containers?.has(name)) return { found: false };
    }
    const first = graphPromptOwnValue(stack[level], path[0]!);
    if (!first.found) continue;
    let value = first.value;
    for (const segment of path.slice(1)) {
      const next = graphPromptOwnValue(value, segment);
      if (!next.found) return { found: false };
      value = next.value;
    }
    return { found: true, value, level, alias: false };
  }
  return { found: false };
}

/** Resolve a path against a context stack (innermost last). */
export function lookupGraphPromptPath(
  stack: readonly unknown[],
  path: readonly string[],
  options: GraphPromptLookupOptions = {},
): GraphPromptLookup {
  const found = locateGraphPromptPath(stack, path, options);
  return found.found ? { found: true, value: found.value } : { found: false };
}

/**
 * Where an interpolated value came from: its path from the root context
 * (`["input", "notes", "2", "title"]` for `{{title}}` inside
 * `{{#input.notes}}`), or a root alias (`item.index`), which names no part
 * of any value.
 */
export interface GraphPromptValueOrigin {
  path: readonly string[];
  alias: boolean;
}

/** Mustache falsiness: missing, null, false, `""`, `0`, `NaN` and `[]`. */
export function isGraphPromptFalsy(value: unknown): boolean {
  return (
    value === undefined ||
    value === null ||
    value === false ||
    value === "" ||
    value === 0 ||
    Number.isNaN(value) ||
    (Array.isArray(value) && value.length === 0)
  );
}

/**
 * A value as one interpolation writes it: text as is, numbers and booleans as
 * text, null as nothing, objects and lists as framed JSON (`<` and `>`
 * escaped). Null when the value cannot be written.
 */
export function graphPromptValueText(value: unknown): string | null {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  try {
    return serializeFramedEvidence(value) ?? "";
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- render

export interface GraphPromptRenderOptions {
  /** Applied to every interpolated value (the renderer's `<`/`>` escape). */
  escapeValue?: (text: string) => string;
  /**
   * The inline evidence frame an interpolated value is written in, from where
   * it came (invariant 5): attributes to frame it, or undefined to write it
   * bare. Node templates frame every value taken from an input artifact.
   */
  frameValue?: (
    origin: GraphPromptValueOrigin,
  ) => readonly (readonly [string, string])[] | undefined;
  /** Applied to template text, and to tags rendered as written. */
  escapeText?: (text: string) => string;
  /** Expands `{{> input.<port>}}`; undefined renders the tag as written. */
  partial?: (port: string) => string | undefined;
  /** Root aliases and containers (see {@link GraphPromptLookupOptions}). */
  lookup?: GraphPromptLookupOptions;
  limits?: Partial<GraphPromptRenderLimits>;
}

export interface GraphPromptRenderResult {
  text: string;
  /** UTF-8 bytes of `text`. */
  bytes: number;
  truncated: boolean;
  diagnostics: GraphPromptDiagnostic[];
}

class OutputLimitReached extends Error {}

/** Render a parsed template against a root context. Never throws. */
export function renderGraphPromptTemplate(
  template: GraphPromptTemplate,
  context: unknown,
  options: GraphPromptRenderOptions = {},
): GraphPromptRenderResult {
  const limits = { ...GRAPH_PROMPT_RENDER_LIMITS, ...options.limits };
  const escapeValue = options.escapeValue ?? ((text: string) => text);
  const escapeText = options.escapeText ?? ((text: string) => text);
  const diagnostics = new GraphPromptDiagnostics();
  const parts: string[] = [];
  let bytes = 0;
  let iterations = 0;
  let truncated = false;
  const missing = new Set<string>();

  const emit = (text: string) => {
    if (text.length === 0) return;
    const size = graphUtf8Bytes(text);
    if (bytes + size > limits.maxOutputBytes) {
      truncated = true;
      throw new OutputLimitReached();
    }
    parts.push(text);
    bytes += size;
  };
  const noteMissing = (node: { raw: string; offset: number }, path: string) => {
    if (missing.has(path)) return;
    missing.add(path);
    diagnostics.add({
      code: "prompt-value-missing",
      severity: "info",
      message: `\`${path}\` has no value here; the tag renders as written`,
      offset: node.offset,
      length: node.raw.length,
      path,
    });
  };

  const lookup = options.lookup ?? {};
  // Each context level's origin, aligned with the stack: the root is `[]`.
  const origins: GraphPromptValueOrigin[] = [{ path: [], alias: false }];
  const originOf = (
    found: Extract<GraphPromptLocatedLookup, { found: true }>,
    path: readonly string[],
  ): GraphPromptValueOrigin => {
    if (found.alias) return { path, alias: true };
    const base = origins[found.level]!;
    return path.length === 1 && path[0] === "."
      ? base
      : { path: [...base.path, ...path], alias: base.alias };
  };

  const renderNodes = (nodes: readonly GraphPromptNode[], stack: unknown[]) => {
    for (const node of nodes) {
      switch (node.kind) {
        case "text":
          emit(escapeText(node.text));
          break;
        case "variable": {
          const found = locateGraphPromptPath(stack, node.path, lookup);
          const text = found.found ? graphPromptValueText(found.value) : null;
          if (text === null || !found.found) {
            noteMissing(node, node.path.join("."));
            emit(escapeText(node.raw));
            break;
          }
          const frame = options.frameValue?.(originOf(found, node.path));
          emit(frame ? wrapGraphInlineEvidenceFrame(frame, escapeValue(text)) : escapeValue(text));
          break;
        }
        case "partial": {
          const text = options.partial?.(node.port);
          if (text === undefined) {
            noteMissing(node, `input.${node.port}`);
            emit(escapeText(node.raw));
          } else {
            emit(text);
          }
          break;
        }
        case "section": {
          const found = locateGraphPromptPath(stack, node.path, lookup);
          const value = found.found ? found.value : undefined;
          const falsy = isGraphPromptFalsy(value);
          if (node.inverted) {
            if (falsy) {
              iterations++;
              if (iterations > limits.maxIterations) throw new OutputLimitReached();
              renderNodes(node.children, stack);
            }
            break;
          }
          if (falsy || !found.found) break;
          const origin = originOf(found, node.path);
          const list = Array.isArray(value);
          const elements = list ? value : [value];
          for (const [index, element] of elements.entries()) {
            iterations++;
            if (iterations > limits.maxIterations) {
              truncated = true;
              throw new OutputLimitReached();
            }
            stack.push(element);
            origins.push(
              list ? { path: [...origin.path, String(index)], alias: origin.alias } : origin,
            );
            try {
              renderNodes(node.children, stack);
            } finally {
              stack.pop();
              origins.pop();
            }
          }
          break;
        }
      }
    }
  };

  try {
    renderNodes(template.nodes, [context]);
  } catch (error) {
    // A limit, or a throwing partial callback: either way the render stops
    // here with what it has, and says so.
    truncated = true;
    diagnostics.add({
      code: "prompt-output-truncated",
      severity: "error",
      message:
        error instanceof OutputLimitReached
          ? `Rendering stopped at ${limits.maxOutputBytes} bytes or ${limits.maxIterations} section repetitions`
          : "Rendering stopped: an input could not be expanded",
    });
  }
  return { text: parts.join(""), bytes, truncated, diagnostics: diagnostics.list };
}

/** Parse and render in one step (type markdown templates, tests). */
export function renderGraphPromptSource(
  source: string,
  context: unknown,
  options: GraphPromptRenderOptions & GraphPromptParseOptions = {},
): GraphPromptRenderResult {
  const template = parseGraphPromptTemplate(source, options);
  const result = renderGraphPromptTemplate(template, context, options);
  return { ...result, diagnostics: [...template.diagnostics, ...result.diagnostics] };
}
