/**
 * One agent node's whole prompt (item 105): the user part (the node's
 * template, or a built-in prompt's text) followed by the locked system
 * contract. The designer's preview (212) and the agent executor (204) both
 * call {@link renderGraphNodePrompt}, so the preview is what the agent gets.
 * Browser-safe.
 */
import { escapeFramedEvidenceText } from "../review-evidence-frames.js";
import type {
  AgentEnforcementJudgement,
  CompiledGraphCapabilities,
  GraphGrantedActions,
} from "./capability-profiles.js";
import { graphUtf8Bytes } from "./grammar.js";
import { graphBuiltInPrompt } from "./prompt-built-ins.js";
import { graphBuiltInPromptBindings, lintGraphNodePrompt } from "./prompt-lint.js";
import { neutralizeGraphPromptText, renderGraphPromptInput } from "./prompt-render.js";
import { GRAPH_PROMPT_CAPABILITY_MAX_CHARS } from "./prompt-size.js";
import {
  type GraphPromptNodeContext,
  type GraphPromptScope,
  type GraphPromptValues,
  graphPromptNodeLenses,
  graphPromptRenderContext,
  graphPromptScope,
} from "./prompt-scope.js";
import {
  type GraphPromptDiagnostic,
  GraphPromptDiagnostics,
  parseGraphPromptTemplate,
  renderGraphPromptTemplate,
} from "./prompt-template.js";
import {
  graphNodeGrantedActions,
  graphNodeResultSlots,
  graphSystemContract,
} from "./system-contract.js";
import { GraphTypeLibrary, type GraphValueType } from "./types.js";

const RESULT_KEY = /^[A-Za-z0-9_-]{1,128}$/;
const CAPABILITY = new RegExp(`^[A-Za-z0-9._~:+/=-]{1,${GRAPH_PROMPT_CAPABILITY_MAX_CHARS}}$`);
const CONTAINERS: ReadonlySet<string> = new Set(["input", "params"]);

/** The result key a preview shows for an output port. */
export const graphPromptPreviewResultKey = (port: string) => `preview-${port}`;

/** The stand-in a preview shows for a built-in prompt's text. */
export function graphBuiltInPromptPreviewText(builtIn: string): string {
  const definition = graphBuiltInPrompt(builtIn);
  return definition
    ? `[Built-in prompt: ${definition.label}. ${definition.description} Orkestrator writes this text when the node runs.]`
    : `[Unknown built-in prompt ${escapeFramedEvidenceText(builtIn)}.]`;
}

export interface GraphNodePromptRenderInput extends GraphPromptNodeContext {
  compiled: CompiledGraphCapabilities;
  /** Defaults to the node's granted actions (item 106). */
  actions?: GraphGrantedActions;
  /** The tier on the provider this activation runs on, when known. */
  enforcement?: Pick<AgentEnforcementJudgement, "tier">;
  values: GraphPromptValues;
  /**
   * For `{ builtIn }` prompts: the text the backend's builder wrote (204),
   * sent as is. Without it the user part is a stand-in describing the
   * built-in.
   */
  builtInText?: string;
  /** A designer preview: runtime-only values (files, ids, result keys) become stand-ins without errors. */
  preview?: boolean;
  /** For the size lint; default 160 KiB of rendered inputs. */
  ceilingBytes?: number;
}

export interface GraphNodePromptRender {
  /** The locked system contract. */
  system: string;
  /** The template (or built-in text) with its inputs. */
  user: string;
  /** What the provider receives: `user`, a blank line, `system`. */
  prompt: string;
  /** UTF-8 bytes of `prompt`. */
  bytes: number;
  /** Lints, then render problems. */
  diagnostics: GraphPromptDiagnostic[];
  omittedDiagnostics: number;
}

function renderUser(
  input: GraphNodePromptRenderInput,
  scope: GraphPromptScope,
  diagnostics: GraphPromptDiagnostics,
  template: ReturnType<typeof parseGraphPromptTemplate> | undefined,
): string {
  const options = { preview: input.preview === true };
  const inputs = new Map<string, string>();
  const expand = (port: string): string | undefined => {
    const cached = inputs.get(port);
    if (cached !== undefined) return cached;
    const spec = scope.ports.get(port);
    if (!spec) return undefined;
    const rendered = renderGraphPromptInput(spec, input.values, options);
    diagnostics.addAll(rendered.diagnostics);
    inputs.set(port, rendered.text);
    return rendered.text;
  };
  const prompt = input.node.prompt;
  if ("builtIn" in prompt) {
    let text = input.builtInText;
    if (text === undefined) {
      text = graphBuiltInPromptPreviewText(prompt.builtIn);
      diagnostics.add({
        code: "prompt-built-in-preview",
        severity: "info",
        message:
          "The built-in prompt's text is written by the backend when the node runs; this is a stand-in",
      });
    }
    const definition = graphBuiltInPrompt(prompt.builtIn);
    const extra = definition
      ? graphBuiltInPromptBindings(definition, scope).extra
      : [...scope.ports.keys()];
    return [text, ...extra.map((port) => expand(port)!)].join("\n\n");
  }
  const { context, aliases } = graphPromptRenderContext(scope, input.values);
  const rendered = renderGraphPromptTemplate(template!, context, {
    escapeValue: escapeFramedEvidenceText,
    escapeText: neutralizeGraphPromptText,
    partial: expand,
    lookup: { aliases, containers: CONTAINERS },
  });
  diagnostics.addAll(rendered.diagnostics);
  return rendered.text;
}

/** Render one agent node's prompt. Never throws. */
export function renderGraphNodePrompt(input: GraphNodePromptRenderInput): GraphNodePromptRender {
  const library = input.library ?? new GraphTypeLibrary(input.template?.types ?? []);
  const context = { ...input, library };
  const scope = graphPromptScope(context);
  const template =
    "template" in input.node.prompt
      ? parseGraphPromptTemplate(input.node.prompt.template, { allowPartials: true })
      : undefined;
  const lint = lintGraphNodePrompt(context, { scope, ...(template ? { template } : {}) });
  const diagnostics = new GraphPromptDiagnostics();
  diagnostics.addAll(lint.diagnostics);
  diagnostics.omitted += lint.omitted;

  const user = renderUser(input, scope, diagnostics, template);

  const actions = input.actions ?? graphNodeGrantedActions(input.node, library, input.compiled);
  const slots = graphNodeResultSlots(input.node, library, actions, (port) => {
    const key = input.values.resultKeys?.[port];
    if (typeof key === "string" && RESULT_KEY.test(key)) return key;
    if (key !== undefined || !input.preview) {
      diagnostics.add({
        code: "prompt-result-key-invalid",
        severity: "error",
        message: `Output ${port} needs a result key of 1 to 128 letters, digits, "_" or "-"`,
        port,
      });
    }
    return graphPromptPreviewResultKey(port);
  });
  let capability: string | undefined;
  if (input.values.capability !== undefined) {
    if (CAPABILITY.test(input.values.capability)) capability = input.values.capability;
    else {
      diagnostics.add({
        code: "prompt-capability-invalid",
        severity: "error",
        message: `The result capability must be 1 to ${GRAPH_PROMPT_CAPABILITY_MAX_CHARS} URL-safe characters; it is left out`,
      });
    }
  }
  const system = graphSystemContract({
    compiled: input.compiled,
    actions,
    ...(input.enforcement ? { enforcement: input.enforcement } : {}),
    slots,
    ...(capability ? { capability } : {}),
  });
  const prompt = `${user}\n\n${system}`;
  return {
    system,
    user,
    prompt,
    bytes: graphUtf8Bytes(prompt),
    diagnostics: diagnostics.list,
    omittedDiagnostics: diagnostics.omitted,
  };
}

// ---------------------------------------------------------------- preview

function exampleOf(type: GraphValueType | undefined, listItems: number): unknown {
  if (!type) return undefined;
  if (type.kind === "list") {
    const element = exampleOf(type.element, listItems);
    if (element === undefined) return undefined;
    return Array.from({ length: Math.max(1, Math.min(2, listItems)) }, () =>
      structuredClone(element),
    );
  }
  if (type.kind === "named" && type.definition.example !== undefined) {
    return structuredClone(type.definition.example);
  }
  return undefined;
}

/**
 * Values for a designer preview: each input's type example (two elements for
 * a list), the first lens and branch 1, the ticket type's example, and the
 * parameters' defaults. File paths, artifact ids and result keys are left to
 * the preview's stand-ins.
 */
export function graphNodePromptPreviewValues(context: GraphPromptNodeContext): GraphPromptValues {
  const library = context.library ?? new GraphTypeLibrary(context.template?.types ?? []);
  const scope = graphPromptScope({ ...context, library });
  const inputs: Record<string, unknown> = {};
  for (const port of scope.ports.values()) {
    const value = exampleOf(port.type, port.listItems);
    if (value !== undefined) inputs[port.name] = value;
  }
  const lenses = graphPromptNodeLenses(context.node);
  const replicate = context.node.replicate;
  const count =
    lenses.length > 0
      ? lenses.length
      : replicate?.over === "samples"
        ? replicate.count
        : replicate?.over === "items"
          ? replicate.maxBranches
          : 1;
  const values: GraphPromptValues = { inputs, run: { iteration: 1 } };
  if (scope.bound.has("lens") && lenses[0]) values.lens = lenses[0];
  if (scope.bound.has("branch")) {
    values.branch = { index: 1, key: lenses[0] ? `lens-${lenses[0].key}` : "branch-1", count };
  }
  if (scope.ticketInput !== undefined) {
    const ticket = context.template?.inputs?.find((entry) => entry.name === scope.ticketInput);
    const resolved = ticket ? library.resolve(ticket.type) : undefined;
    const example = resolved?.ok ? exampleOf(resolved.type, 1) : undefined;
    if (example !== undefined) values.ticket = example;
  }
  return values;
}
