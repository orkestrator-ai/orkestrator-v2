/**
 * How one input reaches a prompt: the five render modes (D13, report §5.6).
 *
 * | Mode | Body of the evidence frame |
 * | --- | --- |
 * | `json-frame` | the value as compact JSON, `<` and `>` written as JSON unicode escapes |
 * | `markdown` | the type's markdown template rendered over the value, `<`/`>` as `&lt;`/`&gt;` |
 * | `summary` | one `path: value` line per summary field of the type |
 * | `file` | the path and SHA-256 of the file the runtime wrote, and a hint to read it |
 * | `on-demand` | the artifact ids and top-level fields, and a hint to call `read_artifact` |
 *
 * Every mode writes one frame (`review-evidence-frames.ts`):
 * `<orkestrator-evidence port="…" type="…" render="…">`, the body, then
 * `</orkestrator-evidence>`. A list input renders its elements one after
 * another, separated by {@link GRAPH_PROMPT_ELEMENT_SEPARATOR}. A type with no
 * markdown template or summary fields renders as `json-frame` (and the linter
 * says so). An optional input with no value renders one line, no frame.
 *
 * ## Item ids and failed branches (item 205)
 *
 * When the runtime supplies {@link GraphPromptValues.elements}, every item of
 * a type with `items` shows its stable id, so a consolidator can cite it
 * (§5.9; the provenance check accepts exactly these ids): `json-frame` adds
 * `"sourceId"` to each item object; `markdown` and `summary` follow each
 * element with a `Source ids:` line, one id per item in order. A failed
 * branch's `error@1` marker in a fan-in list (`includeFailures`) renders as
 * `{"branchFailed": …}` in JSON and as a `Branch failed` line otherwise.
 *
 * The designer's preview and the agent executor both call these, so a
 * preview is byte for byte what the agent gets, apart from what only the
 * runtime knows (file paths, artifact ids, result keys). Browser-safe.
 */
import {
  escapeFramedEvidenceText,
  serializeFramedEvidence,
  wrapGraphEvidenceFrame,
} from "../review-evidence-frames.js";
import { graphUtf8Bytes } from "./grammar.js";
import {
  GRAPH_PROMPT_ARTIFACT_ID_MAX_BYTES,
  GRAPH_PROMPT_FILE_PATH_MAX_BYTES,
  type GraphPromptElement,
  type GraphPromptPort,
  type GraphPromptValues,
} from "./prompt-scope.js";
import {
  type GraphPromptDiagnostic,
  GraphPromptDiagnostics,
  graphPromptValueText,
  lookupGraphPromptPath,
  renderGraphPromptSource,
} from "./prompt-template.js";
import type { GraphRenderMode } from "./template-model.js";

/** Between the elements of a list input. */
export const GRAPH_PROMPT_ELEMENT_SEPARATOR = "\n\n---\n\n";
/** A summary field the value does not have. */
export const GRAPH_PROMPT_SUMMARY_MISSING = "(missing)";
/** Stand-ins the preview shows for what only the runtime knows. */
export const GRAPH_PROMPT_PREVIEW_FILE_PATH = "(written to the workspace when the node runs)";
export const GRAPH_PROMPT_PREVIEW_SHA256 = "(computed when the node runs)";
export const GRAPH_PROMPT_PREVIEW_ARTIFACT_ID = "(assigned when the node runs)";

export const GRAPH_PROMPT_FILE_HINT =
  "The input is in this file, not in the prompt. Read it from the workspace when you need it.";

/** The hint under an `on-demand` input. */
export function graphPromptOnDemandHint(firstField: string | undefined): string {
  const example = firstField ? `, such as "${firstField}"` : "";
  return `Nothing from this input is in the prompt. Call read_artifact with one of these ids, and optionally a field path${example}, to read what you need.`;
}

/** The line an optional input with no value renders as. */
export function graphPromptAbsentInputText(port: string): string {
  return `(No ${escapeFramedEvidenceText(port)} input for this run.)`;
}

const SHA256 = /^[a-f0-9]{64}$/;
const ARTIFACT_ID = /^[A-Za-z0-9][A-Za-z0-9._:#/@-]*$/;
// Control characters and bidirectional overrides never reach a prompt line.
const UNSAFE_TEXT = /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u;

/**
 * Template text is the author's, not evidence, so it is not escaped. It still
 * cannot spell a frame the backend writes (`<orkestrator-…>`, the Multi Review
 * frames): the `<` before one becomes `&lt;`, so a template cannot hide text
 * from the transcript or fake an evidence frame.
 */
const RESERVED_FRAME =
  /<(?=\/?(?:orkestrator-|multi-review-reports-json|structured-review-findings-json))/gi;

export function neutralizeGraphPromptText(text: string): string {
  return text.includes("<") ? text.replace(RESERVED_FRAME, "&lt;") : text;
}

/** The mode a port actually renders in: `json-frame` when its type cannot do markdown or summary. */
export function graphPromptEffectiveMode(port: GraphPromptPort): GraphRenderMode {
  if (port.mode === "markdown" && !port.definition?.render?.markdown) return "json-frame";
  if (port.mode === "summary" && !(port.definition?.render?.summary?.length ?? 0)) {
    return "json-frame";
  }
  return port.mode;
}

/** The frame's attributes. */
export function graphPromptFrameAttributes(
  port: GraphPromptPort,
  mode: GraphRenderMode = graphPromptEffectiveMode(port),
): [string, string][] {
  return [
    ["port", port.name],
    ["type", port.typeLabel],
    ["render", mode],
  ];
}

/** Top-level fields an `on-demand` input lists. */
export function graphPromptOnDemandFields(port: GraphPromptPort): string[] {
  const schema = port.element.schema;
  const properties = schema?.type === "object" ? schema.properties : undefined;
  return properties && typeof properties === "object" ? Object.keys(properties) : [];
}

/** At most this many artifacts are listed for an `on-demand` input. */
export function graphPromptOnDemandMaxArtifacts(port: GraphPromptPort): number {
  return port.listDepth === 0 ? 1 : port.listItems ** port.listDepth;
}

function elementsOf(value: unknown, depth: number): unknown[] {
  if (depth === 0 || !Array.isArray(value)) return [value];
  return value.flatMap((element) => elementsOf(element, depth - 1));
}

/** The JSON key an item's stable id is shown under in a `json-frame`. */
export const GRAPH_PROMPT_SOURCE_ID_KEY = "sourceId";
/** The JSON key a failed branch's marker is wrapped in. */
export const GRAPH_PROMPT_BRANCH_FAILED_KEY = "branchFailed";

/** The line after an element whose items have ids. */
export function graphPromptSourceIdsLine(itemIds: readonly string[]): string {
  return `Source ids (one per item, in order): ${itemIds.join(", ")}`;
}

/** The text a failed branch's `error@1` marker renders as outside JSON. */
export function graphPromptBranchFailedText(marker: unknown): string {
  const record =
    marker && typeof marker === "object" && !Array.isArray(marker)
      ? (marker as Record<string, unknown>)
      : {};
  const cause = typeof record.cause === "string" ? record.cause : "failed";
  const message = typeof record.message === "string" ? record.message : "No result.";
  return `Branch failed (${cause}): ${message}`;
}

/**
 * The runtime's element facts for a port, aligned with its elements, or
 * undefined when there are none (a preview) or they cannot be aligned (lists
 * of lists: item ids belong to the innermost artifacts).
 */
function elementFacts(
  port: GraphPromptPort,
  value: unknown,
  values: GraphPromptValues,
): (GraphPromptElement | undefined)[] | undefined {
  const facts = values.elements?.[port.name];
  if (!facts || facts.length === 0 || port.listDepth > 1) return undefined;
  const count = port.listDepth === 0 ? 1 : Array.isArray(value) ? value.length : 0;
  return Array.from({ length: count }, (_, index) => facts[index]);
}

/** One element with each item's id added, or the failure wrapper. */
function decoratedElement(
  port: GraphPromptPort,
  element: unknown,
  facts: GraphPromptElement | undefined,
): unknown {
  if (facts?.failure) return { [GRAPH_PROMPT_BRANCH_FAILED_KEY]: element };
  const ids = facts?.itemIds;
  const items = port.definition?.items;
  if (!ids || ids.length === 0 || !items) return element;
  if (!element || typeof element !== "object" || Array.isArray(element)) return element;
  const segments = items.path.split(".");
  const copy = structuredClone(element) as Record<string, unknown>;
  let holder: Record<string, unknown> | undefined = copy;
  for (const segment of segments.slice(0, -1)) {
    const next: unknown = holder?.[segment];
    holder =
      next && typeof next === "object" && !Array.isArray(next)
        ? (next as Record<string, unknown>)
        : undefined;
  }
  const last = segments.at(-1)!;
  const list = holder?.[last];
  if (!holder || !Array.isArray(list)) return element;
  holder[last] = list.map((item, index) => {
    const id = ids[index];
    if (id === undefined || !item || typeof item !== "object" || Array.isArray(item)) return item;
    // The id first, so it reads as the item's name.
    return { [GRAPH_PROMPT_SOURCE_ID_KEY]: id, ...(item as Record<string, unknown>) };
  });
  return copy;
}

/** The value a `json-frame` serialises: elements decorated when the runtime supplied facts. */
function decoratedValue(port: GraphPromptPort, value: unknown, values: GraphPromptValues): unknown {
  const facts = elementFacts(port, value, values);
  if (!facts) return value;
  if (port.listDepth === 0) return decoratedElement(port, value, facts[0]);
  return (value as unknown[]).map((element, index) =>
    decoratedElement(port, element, facts[index]),
  );
}

/** Renders each element, a failed branch as its line and item ids after the element. */
function perElement(
  port: GraphPromptPort,
  value: unknown,
  values: GraphPromptValues,
  render: (element: unknown) => string,
): string {
  const facts = elementFacts(port, value, values);
  const parts = elementsOf(value, port.listDepth).map((element, index) => {
    const fact = facts?.[index];
    if (fact?.failure) return graphPromptBranchFailedText(element);
    const text = render(element);
    return fact?.itemIds && fact.itemIds.length > 0
      ? `${text}\n\n${graphPromptSourceIdsLine(fact.itemIds)}`
      : text;
  });
  return escapeFramedEvidenceText(parts.join(GRAPH_PROMPT_ELEMENT_SEPARATOR));
}

function markdownBody(
  port: GraphPromptPort,
  value: unknown,
  values: GraphPromptValues,
  diagnostics: GraphPromptDiagnostics,
): string {
  const template = port.definition!.render!.markdown!;
  return perElement(port, value, values, (element) => {
    const rendered = renderGraphPromptSource(template, element);
    for (const diagnostic of rendered.diagnostics) {
      if (diagnostic.severity !== "info") diagnostics.add({ ...diagnostic, port: port.name });
    }
    return rendered.text;
  });
}

function summaryBody(port: GraphPromptPort, value: unknown, values: GraphPromptValues): string {
  const fields = port.definition!.render!.summary!;
  return perElement(port, value, values, (element) =>
    fields
      .map((field) => {
        const found = lookupGraphPromptPath([element], field.split("."));
        const text = found.found ? graphPromptValueText(found.value) : null;
        return `${field}: ${text ?? GRAPH_PROMPT_SUMMARY_MISSING}`;
      })
      .join("\n"),
  );
}

function fileBody(
  port: GraphPromptPort,
  values: GraphPromptValues,
  preview: boolean,
  diagnostics: GraphPromptDiagnostics,
): string {
  const ref = values.files?.[port.name];
  let path = GRAPH_PROMPT_PREVIEW_FILE_PATH;
  let sha256 = GRAPH_PROMPT_PREVIEW_SHA256;
  let bytes: number | undefined;
  const valid =
    ref !== undefined &&
    typeof ref.path === "string" &&
    ref.path.length > 0 &&
    graphUtf8Bytes(ref.path) <= GRAPH_PROMPT_FILE_PATH_MAX_BYTES &&
    !UNSAFE_TEXT.test(ref.path) &&
    typeof ref.sha256 === "string" &&
    SHA256.test(ref.sha256) &&
    (ref.bytes === undefined || (Number.isSafeInteger(ref.bytes) && ref.bytes >= 0));
  if (valid) {
    path = ref.path;
    sha256 = ref.sha256;
    bytes = ref.bytes;
  } else if (ref !== undefined || !preview) {
    diagnostics.add({
      code: "prompt-file-ref-invalid",
      severity: "error",
      message:
        ref === undefined
          ? `No file was supplied for the file input ${port.name}`
          : `The file supplied for ${port.name} needs a workspace path of at most ${GRAPH_PROMPT_FILE_PATH_MAX_BYTES} bytes and a SHA-256`,
      port: port.name,
    });
  }
  const lines = [`path: ${path}`, `sha256: ${sha256}`];
  if (bytes !== undefined) lines.push(`bytes: ${bytes}`);
  lines.push(GRAPH_PROMPT_FILE_HINT);
  return escapeFramedEvidenceText(lines.join("\n"));
}

function onDemandBody(
  port: GraphPromptPort,
  values: GraphPromptValues,
  preview: boolean,
  diagnostics: GraphPromptDiagnostics,
): string {
  const max = graphPromptOnDemandMaxArtifacts(port);
  const supplied = values.artifacts?.[port.name];
  const lines: string[] = [];
  if (supplied === undefined) {
    if (!preview) {
      diagnostics.add({
        code: "prompt-artifact-ref-invalid",
        severity: "error",
        message: `No artifacts were supplied for the on-demand input ${port.name}`,
        port: port.name,
      });
    }
    lines.push(`- ${GRAPH_PROMPT_PREVIEW_ARTIFACT_ID}`);
  } else {
    let invalid = supplied.length > max;
    for (const ref of supplied.slice(0, max)) {
      const ok =
        typeof ref?.id === "string" &&
        graphUtf8Bytes(ref.id) <= GRAPH_PROMPT_ARTIFACT_ID_MAX_BYTES &&
        ARTIFACT_ID.test(ref.id) &&
        (ref.bytes === undefined || (Number.isSafeInteger(ref.bytes) && ref.bytes >= 0));
      if (!ok) {
        invalid = true;
        continue;
      }
      lines.push(ref.bytes === undefined ? `- ${ref.id}` : `- ${ref.id} (${ref.bytes} bytes)`);
    }
    if (invalid) {
      diagnostics.add({
        code: "prompt-artifact-ref-invalid",
        severity: "error",
        message: `The artifacts for ${port.name} must be at most ${max} ids of at most ${GRAPH_PROMPT_ARTIFACT_ID_MAX_BYTES} bytes`,
        port: port.name,
      });
    }
    if (lines.length === 0) lines.push("- (none)");
  }
  const fields = graphPromptOnDemandFields(port);
  if (fields.length > 0) lines.push(`Fields: ${fields.join(", ")}`);
  lines.push(graphPromptOnDemandHint(fields[0]));
  return escapeFramedEvidenceText(lines.join("\n"));
}

export interface GraphPromptInputRenderOptions {
  /** A designer preview: runtime-only references fall back to stand-ins without errors. */
  preview?: boolean;
}

/** Render one input port in its mode. Never throws. */
export function renderGraphPromptInput(
  port: GraphPromptPort,
  values: GraphPromptValues,
  options: GraphPromptInputRenderOptions = {},
): { text: string; diagnostics: GraphPromptDiagnostic[] } {
  const diagnostics = new GraphPromptDiagnostics();
  const present = Object.hasOwn(values.inputs, port.name);
  const value = present ? values.inputs[port.name] : undefined;
  if (value === undefined || value === null) {
    if (port.required) {
      diagnostics.add({
        code: "prompt-input-missing",
        // A preview without an example or fixture is expected, not an error.
        severity: options.preview ? "warning" : "error",
        message: options.preview
          ? `The required input ${port.name} has no example or fixture to preview`
          : `The required input ${port.name} has no value`,
        port: port.name,
      });
    }
    return { text: graphPromptAbsentInputText(port.name), diagnostics: diagnostics.list };
  }
  const mode = graphPromptEffectiveMode(port);
  let body: string;
  if (mode === "file") body = fileBody(port, values, options.preview === true, diagnostics);
  else if (mode === "on-demand") {
    body = onDemandBody(port, values, options.preview === true, diagnostics);
  } else {
    let json: string | undefined;
    try {
      json = serializeFramedEvidence(
        mode === "json-frame" ? decoratedValue(port, value, values) : value,
      );
    } catch {
      json = undefined;
    }
    if (json === undefined) {
      diagnostics.add({
        code: "prompt-input-not-json",
        severity: "error",
        message: `The value of ${port.name} is not JSON`,
        port: port.name,
      });
      body = "null";
    } else {
      const bytes = graphUtf8Bytes(JSON.stringify(value));
      if (bytes > port.bound.bytes) {
        diagnostics.add({
          code: "prompt-input-over-budget",
          severity: "warning",
          message: `The value of ${port.name} is ${bytes} bytes; its type allows ${port.bound.bytes}`,
          port: port.name,
        });
      }
      body =
        mode === "markdown"
          ? markdownBody(port, value, values, diagnostics)
          : mode === "summary"
            ? summaryBody(port, value, values)
            : json;
    }
  }
  return {
    text: wrapGraphEvidenceFrame(graphPromptFrameAttributes(port, mode), body),
    diagnostics: diagnostics.list,
  };
}
