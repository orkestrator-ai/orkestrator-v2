/**
 * Prompt size from type budgets (item 105, report §5.6 and §5.11).
 *
 * Every figure comes in two forms:
 *
 * - `nominalBytes`: every input at its type budget, with nothing to escape.
 *   This is the estimate to hold against the node's ceiling (the report's
 *   160 KiB of rendered inputs per node).
 * - `maxBytes`: a hard upper bound, with escaping at its worst (`<` becomes
 *   six bytes in JSON, four in text). A user template's render never exceeds
 *   it for inputs within their budgets and schemas; tests check that.
 *
 * A built-in prompt's text comes from the backend, so its size is an
 * allowance per built-in (`textMaxBytes`) plus its inputs, and `bounded` is
 * false. Browser-safe.
 */
import {
  GRAPH_EVIDENCE_FRAME_CLOSE,
  escapeFramedEvidenceText,
  graphEvidenceFrameOpen,
} from "../review-evidence-frames.js";
import { WORKFLOW_RESULT_KEY_MAX_LENGTH } from "../workflow-results.js";
import type { CompiledGraphCapabilities, GraphGrantedActions } from "./capability-profiles.js";
import { graphUtf8Bytes } from "./grammar.js";
import {
  GRAPH_PROMPT_ESCAPE_FACTOR,
  type GraphPromptSizeBound,
  analyzeGraphPromptTemplate,
  graphPromptHeaviestPath,
  graphPromptTemplateBound,
} from "./prompt-analysis.js";
import { graphBuiltInPrompt } from "./prompt-built-ins.js";
import {
  GRAPH_PROMPT_ELEMENT_SEPARATOR,
  GRAPH_PROMPT_FILE_HINT,
  GRAPH_PROMPT_PREVIEW_ARTIFACT_ID,
  GRAPH_PROMPT_PREVIEW_FILE_PATH,
  GRAPH_PROMPT_PREVIEW_SHA256,
  GRAPH_PROMPT_SUMMARY_MISSING,
  graphPromptAbsentInputText,
  graphPromptEffectiveMode,
  graphPromptFrameAttributes,
  graphPromptOnDemandFields,
  graphPromptOnDemandHint,
  graphPromptOnDemandMaxArtifacts,
  neutralizeGraphPromptText,
} from "./prompt-render.js";
import {
  GRAPH_PROMPT_ARTIFACT_ID_MAX_BYTES,
  GRAPH_PROMPT_FILE_PATH_MAX_BYTES,
  type GraphPromptNodeContext,
  type GraphPromptPort,
  type GraphPromptScope,
  graphPromptScope,
} from "./prompt-scope.js";
import { type GraphPromptTemplate, parseGraphPromptTemplate } from "./prompt-template.js";
import {
  graphNodeGrantedActions,
  graphNodeResultSlots,
  graphSystemContract,
} from "./system-contract.js";
import type { GraphRenderMode } from "./template-model.js";
import { GraphTypeLibrary } from "./types.js";

export type { GraphPromptSizeBound } from "./prompt-analysis.js";

const KIB = 1024;

/** Rendered inputs per node (report §5.11): compare `inputNominalBytes` with it. */
export const GRAPH_PROMPT_INPUT_CEILING_BYTES = 160 * KIB;
/** A shared input this large or larger should precede per-branch variables (cache prefix). */
export const GRAPH_PROMPT_LARGE_INPUT_BYTES = 1 * KIB;
/** Characters of an activation capability a prompt may carry. */
export const GRAPH_PROMPT_CAPABILITY_MAX_CHARS = 256;
/** Digits of the largest safe integer (byte counts in file and artifact lines). */
const COUNT_DIGITS = String(Number.MAX_SAFE_INTEGER).length;

const utf8 = graphUtf8Bytes;
const escapedBytes = (text: string) => utf8(escapeFramedEvidenceText(text));

function scale(bound: GraphPromptSizeBound, count: number): GraphPromptSizeBound {
  return { nominalBytes: bound.nominalBytes * count, maxBytes: bound.maxBytes * count };
}

function add(...bounds: GraphPromptSizeBound[]): GraphPromptSizeBound {
  return bounds.reduce(
    (total, bound) => ({
      nominalBytes: total.nominalBytes + bound.nominalBytes,
      maxBytes: total.maxBytes + bound.maxBytes,
    }),
    { nominalBytes: 0, maxBytes: 0 },
  );
}

const exact = (bytes: number): GraphPromptSizeBound => ({ nominalBytes: bytes, maxBytes: bytes });

/** Elements a list input renders: one for a single artifact. */
function elementCount(port: GraphPromptPort): number {
  return Math.max(1, port.listDepth === 0 ? 1 : port.listItems ** port.listDepth);
}

function perElement(port: GraphPromptPort, element: GraphPromptSizeBound): GraphPromptSizeBound {
  const count = elementCount(port);
  return add(scale(element, count), exact((count - 1) * utf8(GRAPH_PROMPT_ELEMENT_SEPARATOR)));
}

function markdownBody(port: GraphPromptPort): GraphPromptSizeBound {
  const template = parseGraphPromptTemplate(port.definition!.render!.markdown!);
  const analysis = analyzeGraphPromptTemplate(template, { kind: "value", source: port.element });
  const element = graphPromptTemplateBound(analysis, new Map([[port.element.key, port.element]]), {
    textBytes: escapedBytes,
  });
  return perElement(port, element);
}

function summaryBody(port: GraphPromptPort): GraphPromptSizeBound {
  const fields = port.definition!.render!.summary!;
  // A line per field, `field: value`; a field the value lacks reads `(missing)`.
  let fixed = Math.max(0, fields.length - 1);
  for (const field of fields) fixed += escapedBytes(field) + 2 + utf8(GRAPH_PROMPT_SUMMARY_MISSING);
  const values =
    graphPromptHeaviestPath(fields.map((field) => ({ path: field.split("."), weight: 1 }))) *
    port.element.bytes;
  return perElement(port, {
    nominalBytes: fixed + values,
    maxBytes: fixed + values * GRAPH_PROMPT_ESCAPE_FACTOR,
  });
}

function fileBody(): GraphPromptSizeBound {
  // A path may hold `<`, escaped to four bytes; the hash and count cannot.
  const path = (factor: number) =>
    utf8("path: ") +
    Math.max(utf8(GRAPH_PROMPT_PREVIEW_FILE_PATH), factor * GRAPH_PROMPT_FILE_PATH_MAX_BYTES);
  const rest =
    1 +
    utf8("sha256: ") +
    Math.max(64, utf8(GRAPH_PROMPT_PREVIEW_SHA256)) +
    1 +
    utf8("bytes: ") +
    COUNT_DIGITS +
    1 +
    escapedBytes(GRAPH_PROMPT_FILE_HINT);
  return { nominalBytes: path(1) + rest, maxBytes: path(4) + rest };
}

function onDemandBody(port: GraphPromptPort): GraphPromptSizeBound {
  const id = Math.max(GRAPH_PROMPT_ARTIFACT_ID_MAX_BYTES, utf8(GRAPH_PROMPT_PREVIEW_ARTIFACT_ID));
  const line = utf8("- ") + id + utf8(" (") + COUNT_DIGITS + utf8(" bytes)") + 1;
  const fields = graphPromptOnDemandFields(port);
  const fieldsLine = fields.length > 0 ? escapedBytes(`Fields: ${fields.join(", ")}`) + 1 : 0;
  return exact(
    Math.max(1, graphPromptOnDemandMaxArtifacts(port)) * line +
      fieldsLine +
      escapedBytes(graphPromptOnDemandHint(fields[0])),
  );
}

/** The bound for one expansion of `{{> input.<port>}}`. */
export function estimateGraphPromptInput(port: GraphPromptPort): GraphPromptSizeBound & {
  mode: GraphRenderMode;
} {
  const mode = graphPromptEffectiveMode(port);
  const frame =
    utf8(graphEvidenceFrameOpen(graphPromptFrameAttributes(port, mode))) +
    2 +
    utf8(GRAPH_EVIDENCE_FRAME_CLOSE);
  let body: GraphPromptSizeBound;
  switch (mode) {
    case "markdown":
      body = markdownBody(port);
      break;
    case "summary":
      body = summaryBody(port);
      break;
    case "file":
      body = fileBody();
      break;
    case "on-demand":
      body = onDemandBody(port);
      break;
    default:
      body = {
        nominalBytes: port.bound.bytes,
        maxBytes: port.bound.bytes * GRAPH_PROMPT_ESCAPE_FACTOR,
      };
  }
  // A missing value renders one line instead of a frame.
  const absent = utf8(graphPromptAbsentInputText(port.name));
  return {
    mode,
    nominalBytes: Math.max(absent, frame + body.nominalBytes),
    maxBytes: Math.max(absent, frame + body.maxBytes),
  };
}

export interface GraphPromptInputEstimate extends GraphPromptSizeBound {
  port: string;
  mode: GraphRenderMode;
  /** Times the template expands it (0 when unused). */
  expansions: number;
}

export interface GraphPromptUserSizeEstimate extends GraphPromptSizeBound {
  /** False for built-in prompts, whose text the backend writes. */
  bounded: boolean;
  inputs: GraphPromptInputEstimate[];
  /** Rendered inputs, nominally: hold this against {@link GRAPH_PROMPT_INPUT_CEILING_BYTES}. */
  inputNominalBytes: number;
}

/** Size of a parsed user template against a scope. */
export function estimateGraphPromptTemplateSize(
  scope: GraphPromptScope,
  template: GraphPromptTemplate,
): GraphPromptUserSizeEstimate {
  const perPort = new Map(
    [...scope.ports.values()].map((port) => [port.name, estimateGraphPromptInput(port)]),
  );
  const analysis = analyzeGraphPromptTemplate(template, { kind: "scope", scope });
  const expansions = new Map<string, number>();
  for (const occurrence of analysis.occurrences) {
    if (occurrence.kind !== "partial" || occurrence.port === undefined) continue;
    if (!perPort.has(occurrence.port)) continue;
    expansions.set(occurrence.port, (expansions.get(occurrence.port) ?? 0) + occurrence.executions);
  }
  const bound = graphPromptTemplateBound(analysis, scope.sources, {
    textBytes: (text) => utf8(neutralizeGraphPromptText(text)),
    partial: (port) => perPort.get(port),
  });
  const inputs = [...perPort].map(([port, estimate]) => ({
    port,
    mode: estimate.mode,
    nominalBytes: estimate.nominalBytes,
    maxBytes: estimate.maxBytes,
    expansions: expansions.get(port) ?? 0,
  }));
  return {
    ...bound,
    bounded: true,
    inputs,
    inputNominalBytes: inputs.reduce(
      (total, input) => total + input.nominalBytes * input.expansions,
      0,
    ),
  };
}

/** Size of a built-in prompt: its text allowance plus every input once, joined by blank lines. */
export function estimateGraphBuiltInPromptSize(
  scope: GraphPromptScope,
  builtIn: string,
): GraphPromptUserSizeEstimate {
  const text = graphBuiltInPrompt(builtIn)?.textMaxBytes ?? 32 * KIB;
  const inputs = [...scope.ports.values()].map((port) => {
    const estimate = estimateGraphPromptInput(port);
    return {
      port: port.name,
      mode: estimate.mode,
      nominalBytes: estimate.nominalBytes,
      maxBytes: estimate.maxBytes,
      expansions: 1,
    };
  });
  const joined = add(exact(text), ...inputs.map((input) => add(input, exact(2))));
  return {
    ...joined,
    bounded: false,
    inputs,
    inputNominalBytes: inputs.reduce((total, input) => total + input.nominalBytes, 0),
  };
}

/** The user part of a node's prompt (template or built-in). */
export function estimateGraphPromptUserSize(
  context: GraphPromptNodeContext,
  scope: GraphPromptScope = graphPromptScope(context),
): GraphPromptUserSizeEstimate {
  const prompt = context.node.prompt;
  if ("builtIn" in prompt) return estimateGraphBuiltInPromptSize(scope, prompt.builtIn);
  return estimateGraphPromptTemplateSize(
    scope,
    parseGraphPromptTemplate(prompt.template, { allowPartials: true }),
  );
}

export interface GraphNodePromptSizeInput extends GraphPromptNodeContext {
  compiled: CompiledGraphCapabilities;
  /** Defaults to the node's granted actions (item 106). */
  actions?: GraphGrantedActions;
}

export interface GraphPromptSizeEstimate extends GraphPromptSizeBound {
  bounded: boolean;
  user: GraphPromptUserSizeEstimate;
  /** The system contract at its longest (result keys and capability at their limits). */
  systemBytes: number;
  inputs: GraphPromptInputEstimate[];
  inputNominalBytes: number;
}

/** The longest system contract this node can get. */
export function graphPromptSystemMaxBytes(input: GraphNodePromptSizeInput): number {
  const library = input.library ?? new GraphTypeLibrary(input.template?.types ?? []);
  const actions = input.actions ?? graphNodeGrantedActions(input.node, library, input.compiled);
  const key = "x".repeat(WORKFLOW_RESULT_KEY_MAX_LENGTH);
  return utf8(
    graphSystemContract({
      compiled: input.compiled,
      actions,
      enforcement: { tier: "advisory" },
      slots: graphNodeResultSlots(input.node, library, actions, () => key),
      capability: "x".repeat(GRAPH_PROMPT_CAPABILITY_MAX_CHARS),
    }),
  );
}

/** The whole prompt: user part, a blank line, the system contract. */
export function estimateGraphNodePromptSize(
  input: GraphNodePromptSizeInput,
): GraphPromptSizeEstimate {
  const user = estimateGraphPromptUserSize(input);
  const systemBytes = graphPromptSystemMaxBytes(input);
  return {
    nominalBytes: user.nominalBytes + 2 + systemBytes,
    maxBytes: user.maxBytes + 2 + systemBytes,
    bounded: user.bounded,
    user,
    systemBytes,
    inputs: user.inputs,
    inputNominalBytes: user.inputNominalBytes,
  };
}
