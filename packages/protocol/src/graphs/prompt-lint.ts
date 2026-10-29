/**
 * Prompt lints (item 105, report §7.3). The compiler (107) folds these into
 * its diagnostics; the prompt editor (212) shows them as the author types.
 *
 * | Code | Severity | When |
 * | --- | --- | --- |
 * | `prompt-template-*` | per code | the template does not parse cleanly (`prompt-template.ts`) |
 * | `prompt-unbound-variable` | error | a known root this node does not have (`lens` without lenses), an unknown port or parameter |
 * | `prompt-unknown-variable` | warning | a name no root knows (`{{constructor}}`); it renders as written |
 * | `prompt-unknown-field` | error | a field the type's schema does not have |
 * | `prompt-container-variable` | error | `{{input}}`, `{{params}}` or a root `{{.}}` |
 * | `prompt-unbound-partial` | error | `{{> input.x}}` for a port the node lacks |
 * | `prompt-branch-variable-before-shared-input` | warning | a per-branch variable precedes a large shared input, breaking the shared cache prefix |
 * | `prompt-prose-output` | warning | the text asks for the result in prose although the node has output ports |
 * | `prompt-profile-contradiction` | warning (advisory) | the text asks for something the capabilities deny (push, pull requests and GitHub writes always, D12) |
 * | `prompt-reserved-marker` | warning | the text spells a frame marker; it is neutralized |
 * | `prompt-input-unused` | info | an input the prompt never shows (workspace inputs excepted) |
 * | `prompt-markdown-unavailable`, `prompt-summary-unavailable` | warning | the type has no markdown template or summary fields; `json-frame` is used |
 * | `prompt-size-over-ceiling` | warning | a template's rendered inputs exceed the ceiling (160 KiB nominal) |
 * | `prompt-built-in-unknown` | error | an unknown built-in prompt id |
 * | `prompt-built-in-input`, `prompt-built-in-output` | error | the node lacks a port the built-in needs |
 * | `prompt-built-in-extra-input` | info | an input the built-in does not read; it is appended as a frame |
 * | `prompt-built-in-profile` | info | the built-in is written for other profiles |
 *
 * Keyword lints skip a match negated earlier in its sentence ("do not push").
 * Browser-safe.
 */
import {
  type CompiledGraphCapabilities,
  GRAPH_CAPABILITY_PROFILE_DEFINITIONS,
  GRAPH_REMOTE_WRITE_CAPABILITIES,
} from "./capability-profiles.js";
import { parseGraphTypeRef } from "./grammar.js";
import { type GraphPromptOccurrence, analyzeGraphPromptTemplate } from "./prompt-analysis.js";
import {
  type GraphBuiltInPromptDefinition,
  type GraphBuiltInPromptPort,
  graphBuiltInPrompt,
} from "./prompt-built-ins.js";
import { graphPromptEffectiveMode, neutralizeGraphPromptText } from "./prompt-render.js";
import {
  GRAPH_PROMPT_INPUT_CEILING_BYTES,
  GRAPH_PROMPT_LARGE_INPUT_BYTES,
  estimateGraphPromptInput,
  estimateGraphPromptTemplateSize,
} from "./prompt-size.js";
import {
  type GraphPromptNodeContext,
  type GraphPromptPort,
  type GraphPromptScope,
  graphPromptScope,
} from "./prompt-scope.js";
import {
  type GraphPromptDiagnostic,
  GraphPromptDiagnostics,
  type GraphPromptTemplate,
  parseGraphPromptTemplate,
} from "./prompt-template.js";
import type { GraphOutputPortSpec } from "./template-model.js";

// ------------------------------------------------------------ capabilities

/** What the contradiction lint needs to know about a node's capabilities. */
export interface GraphPromptCapabilityView {
  denied: ReadonlySet<string>;
  readOnly: boolean;
  webSearch: boolean;
}

/**
 * From the compiled capabilities when given (item 106); otherwise from the
 * profile and the node's overrides alone (no environment or ceiling).
 */
export function graphPromptCapabilityView(
  context: Pick<GraphPromptNodeContext, "node"> & { compiled?: CompiledGraphCapabilities },
): GraphPromptCapabilityView {
  if (context.compiled) {
    return {
      denied: new Set(context.compiled.denied),
      readOnly: context.compiled.readOnly,
      webSearch: context.compiled.webSearch,
    };
  }
  const spec = context.node.capabilities;
  const profile = GRAPH_CAPABILITY_PROFILE_DEFINITIONS[spec.profile];
  const denied = new Set<string>([...(profile?.deny ?? []), ...(spec.deny ?? [])]);
  for (const name of spec.allow ?? []) {
    if (!(GRAPH_REMOTE_WRITE_CAPABILITIES as readonly string[]).includes(name)) denied.delete(name);
  }
  for (const name of GRAPH_REMOTE_WRITE_CAPABILITIES) denied.add(name);
  const fileDenied = denied.has("file.write") && denied.has("file.patch");
  const searchAllowed =
    (profile?.allow as readonly string[] | undefined)?.includes("web.search") ||
    (spec.allow ?? []).includes("web.search");
  return {
    denied,
    readOnly: fileDenied && (denied.has("shell") || denied.has("shell.mutate")),
    webSearch: !denied.has("web.search") && (!denied.has("network") || searchAllowed === true),
  };
}

// ---------------------------------------------------------- keyword lints

const NEGATION =
  /\b(?:do\s+not|don['’]?t|never|must\s+not|mustn['’]?t|should\s+not|shouldn['’]?t|cannot|can['’]?t|without|no\s+need\s+to|avoid|refrain\s+from|instead\s+of|not)\b/i;

/** True when the sentence holding `index` negates before it. */
function negated(text: string, index: number): boolean {
  const before = text.slice(0, index);
  const start = Math.max(
    before.lastIndexOf("."),
    before.lastIndexOf("!"),
    before.lastIndexOf("?"),
    before.lastIndexOf("\n"),
    before.lastIndexOf(";"),
  );
  return NEGATION.test(before.slice(start + 1));
}

interface KeywordRule {
  id: string;
  pattern: RegExp;
  applies: (view: GraphPromptCapabilityView) => boolean;
  reason: string;
}

const CONTRADICTION_RULES: readonly KeywordRule[] = [
  {
    id: "push",
    pattern:
      /\b(?:git\s+push|force[- ]push|push(?:es|ing)?\s+(?:the\s+|your\s+|this\s+|these\s+|all\s+|our\s+)?(?:branch|branches|changes|commits?|code|work|fix(?:es)?|it|them)\b)/i,
    applies: () => true,
    reason: "agent nodes cannot push; a system step pushes after the node (D12)",
  },
  {
    id: "pull-request",
    pattern:
      /\b(?:(?:open|create|raise|submit|file|update|merge|close)\s+(?:a\s+|the\s+|an?\s+new\s+)?(?:pull\s+request|PR)\b|gh\s+pr\s+(?:create|edit|merge|close|comment|review|reopen)\b)/i,
    applies: () => true,
    reason: "agent nodes cannot open or change pull requests; a system step does (D12)",
  },
  {
    id: "github-write",
    pattern:
      /\b(?:(?:comment|post|reply)\s+on\s+(?:the\s+)?(?:pull\s+request|PR|issue|GitHub)\b|gh\s+(?:issue|release|label)\s+(?:create|edit|comment|close|delete)\b)/i,
    applies: () => true,
    reason: "agent nodes cannot write to GitHub (D12)",
  },
  {
    id: "commit",
    pattern:
      /\b(?:git\s+commit|commit\s+(?:your\s+|the\s+|all\s+|these\s+|any\s+|each\s+|this\s+)?(?:changes|work|fix(?:es)?|code|files?|result)|(?:make|create)\s+(?:a\s+)?commits?)\b/i,
    applies: (view) => view.denied.has("git.commit"),
    reason: "this node cannot create commits",
  },
  {
    id: "edit",
    pattern:
      /\b(?:(?:edit|modify|change|update|rewrite|refactor|create|delete|remove|fix|patch|write\s+to)\s+(?:the\s+|any\s+|a\s+|these\s+|those\s+|this\s+|that\s+|all\s+)?(?:files?|code|source|tests?|implementation|repository|repo|codebase)|implement\s+(?:the\s+|this\s+|a\s+)?(?:fix|change|feature|ticket))\b/i,
    applies: (view) =>
      view.readOnly || (view.denied.has("file.write") && view.denied.has("file.patch")),
    reason: "this node cannot change files",
  },
  {
    id: "shell",
    pattern:
      /\b(?:run\s+(?:the\s+)?(?:tests?|test\s+suite|build|linter|lint|typecheck|commands?|scripts?|bun|npm|pnpm|yarn|make|cargo|pytest)|execute\s+(?:the\s+)?(?:commands?|scripts?|tests?))\b/i,
    applies: (view) => view.denied.has("shell"),
    reason: "this node has no shell",
  },
  {
    id: "install",
    pattern:
      /\b(?:install\s+(?:the\s+)?(?:dependencies|packages?)|(?:npm|bun|pnpm|yarn|pip)\s+(?:install|add))\b/i,
    applies: (view) => !view.denied.has("shell") && view.denied.has("shell.mutate"),
    reason: "this node's shell is read-only",
  },
  {
    id: "web-search",
    pattern:
      /\b(?:search\s+the\s+(?:web|internet)|web\s+search|look\s+(?:it\s+|this\s+|that\s+)?up\s+online)\b/i,
    applies: (view) => !view.webSearch,
    reason: "this node has no web search",
  },
  {
    id: "network",
    pattern:
      /\b(?:browse\s+(?:the\s+)?(?:web|internet)|fetch\s+(?:the\s+)?(?:url|page|website|web\s+page|docs?)|download|curl|wget)\b/i,
    applies: (view) => view.denied.has("network"),
    reason: "this node has no network access",
  },
  {
    id: "subagents",
    pattern:
      /\b(?:sub-?agents?|spawn\s+(?:an?\s+)?(?:new\s+)?agents?|delegate\s+(?:this\s+|it\s+)?to\s+(?:an?\s+)?(?:agent|sub-?agent))\b/i,
    applies: (view) => view.denied.has("subagents"),
    reason: "this node cannot start sub-agents",
  },
];

const PROSE_OUTPUT_PATTERNS: readonly RegExp[] = [
  /\b(?:reply|respond|answer|write|output|return|give|report|summari[sz]e|present|provide|list)\b[^.\n]{0,60}?\b(?:in\s+prose|as\s+prose|in\s+plain\s+text|as\s+plain\s+text|as\s+(?:a\s+)?markdown|in\s+markdown|in\s+(?:your|the)\s+(?:final\s+)?(?:response|reply|message|answer)|as\s+your\s+(?:final\s+)?(?:response|reply|message|answer))\b/i,
  /\b(?:print|output|return|respond\s+with|reply\s+with)\s+(?:the\s+|your\s+)?(?:result|report|answer|json|verdict|findings|decision)\b[^.\n]{0,40}?\b(?:as\s+json|in\s+json|as\s+text|in\s+(?:your\s+|the\s+)?(?:final\s+)?(?:response|message|reply))\b/i,
  /\b(?:your\s+)?final\s+(?:response|message|answer)\s+(?:should|must)\s+(?:be|contain|include|list)\b/i,
];

interface TextPiece {
  text: string;
  offset: number;
}

function firstMatch(
  pieces: readonly TextPiece[],
  pattern: RegExp,
): { index: number; match: string } | undefined {
  const global = new RegExp(
    pattern.source,
    pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`,
  );
  for (const piece of pieces) {
    global.lastIndex = 0;
    let found: RegExpExecArray | null;
    while ((found = global.exec(piece.text)) !== null) {
      if (!negated(piece.text, found.index)) {
        return { index: piece.offset + found.index, match: found[0].slice(0, 60) };
      }
      if (found[0].length === 0) global.lastIndex++;
    }
  }
  return undefined;
}

function keywordLints(
  pieces: readonly TextPiece[],
  view: GraphPromptCapabilityView,
  outputs: readonly GraphOutputPortSpec[],
  diagnostics: GraphPromptDiagnostics,
  source?: string,
): void {
  const where = source ? { source } : {};
  if (outputs.length > 0) {
    for (const pattern of PROSE_OUTPUT_PATTERNS) {
      const hit = firstMatch(pieces, pattern);
      if (!hit) continue;
      const tools = outputs.map((port) => `submit_${port.name}`).join(", ");
      diagnostics.add({
        code: "prompt-prose-output",
        severity: "warning",
        message: `"${hit.match}" asks for prose, but this node returns its result through its outputs (${tools}); the final message is not read`,
        offset: hit.index,
        length: hit.match.length,
        ...where,
      });
      break;
    }
  }
  for (const rule of CONTRADICTION_RULES) {
    if (!rule.applies(view)) continue;
    const hit = firstMatch(pieces, rule.pattern);
    if (!hit) continue;
    diagnostics.add({
      code: "prompt-profile-contradiction",
      severity: "warning",
      message: `Advisory: "${hit.match}" contradicts the node's capabilities: ${rule.reason}`,
      offset: hit.index,
      length: hit.match.length,
      ...where,
    });
  }
}

// -------------------------------------------------------- template lints

function problemDiagnostic(
  occurrence: GraphPromptOccurrence,
  scope: GraphPromptScope,
): GraphPromptDiagnostic | undefined {
  const at = {
    offset: occurrence.node.offset,
    length: occurrence.node.raw.length,
    path: occurrence.name,
  };
  switch (occurrence.problem) {
    case undefined:
      return undefined;
    case "unknown-root":
      return {
        code: "prompt-unknown-variable",
        severity: "warning",
        message: `\`${occurrence.name}\` is not a variable (roots are input, params, run, lens, item, branch and ticket); it renders as written`,
        ...at,
      };
    case "unbound-root": {
      const root = occurrence.name.split(".")[0];
      const why =
        root === "lens"
          ? "the node does not replicate over lenses"
          : root === "item"
            ? "the node does not replicate over items"
            : root === "branch"
              ? "the node is not replicated"
              : "the template has no ticket run input";
      return {
        code: "prompt-unbound-variable",
        severity: "error",
        message: `\`${occurrence.name}\` is not bound here: ${why}`,
        ...at,
      };
    }
    case "unknown-port":
      if (occurrence.kind === "partial") {
        return {
          code: "prompt-unbound-partial",
          severity: "error",
          message: `The node has no input port ${occurrence.port ?? ""}`,
          ...at,
          ...(occurrence.port !== undefined ? { port: occurrence.port } : {}),
        };
      }
      return {
        code: "prompt-unbound-variable",
        severity: "error",
        message: `The node has no input port ${occurrence.name.split(".")[1] ?? ""}`,
        ...at,
      };
    case "unknown-param":
      return {
        code: "prompt-unbound-variable",
        severity: "error",
        message: `The template has no parameter ${occurrence.name.split(".")[1] ?? ""}`,
        ...at,
      };
    case "container":
      return {
        code: "prompt-container-variable",
        severity: "error",
        message: `\`${occurrence.name}\` names a group of variables, not a value; name one (\`input.<port>\`, \`params.<key>\`)`,
        ...at,
      };
    case "unknown-field": {
      const port = occurrence.name.startsWith("input.")
        ? scope.ports.get(occurrence.name.split(".")[1]!)
        : undefined;
      return {
        code: "prompt-unknown-field",
        severity: "error",
        message: port
          ? `${port.typeLabel} has no field at \`${occurrence.name}\``
          : `No such field: \`${occurrence.name}\``,
        ...at,
      };
    }
  }
}

function sourcePort(source: string): string | undefined {
  return source.startsWith("input.") ? source.slice("input.".length) : undefined;
}

function branchOrderLint(
  analysis: ReturnType<typeof analyzeGraphPromptTemplate>,
  scope: GraphPromptScope,
  diagnostics: GraphPromptDiagnostics,
): void {
  if (!scope.replicated) return;
  const ordered = [...analysis.occurrences].sort(
    (left, right) => left.node.offset - right.node.offset,
  );
  const firstPerBranch = ordered.find((occurrence) => occurrence.perBranch);
  if (!firstPerBranch) return;
  const large = ordered.find((occurrence) => {
    if (occurrence.node.offset <= firstPerBranch.node.offset || occurrence.perBranch) return false;
    if (occurrence.kind === "partial") {
      const port = occurrence.port !== undefined ? scope.ports.get(occurrence.port) : undefined;
      if (!port) return false;
      // A file or on-demand input renders a few reference lines, not content.
      const estimate = estimateGraphPromptInput(port);
      return (
        estimate.mode !== "file" &&
        estimate.mode !== "on-demand" &&
        estimate.nominalBytes >= GRAPH_PROMPT_LARGE_INPUT_BYTES
      );
    }
    if (occurrence.kind !== "section") return false;
    return occurrence.uses.some(
      (use) =>
        sourcePort(use.source) !== undefined &&
        (scope.sources.get(use.source)?.bytes ?? 0) >= GRAPH_PROMPT_LARGE_INPUT_BYTES,
    );
  });
  if (!large) return;
  const port = large.port ?? sourcePort(large.uses[0]?.source ?? "");
  diagnostics.add({
    code: "prompt-branch-variable-before-shared-input",
    severity: "warning",
    message: `\`${firstPerBranch.name}\` differs per branch but comes before the shared input ${port ?? large.name}; move per-branch variables after shared inputs so every branch shares one cached prompt prefix`,
    offset: firstPerBranch.node.offset,
    length: firstPerBranch.node.raw.length,
    path: firstPerBranch.name,
    ...(port !== undefined ? { port } : {}),
  });
}

function unusedInputLint(
  analysis: ReturnType<typeof analyzeGraphPromptTemplate>,
  scope: GraphPromptScope,
  diagnostics: GraphPromptDiagnostics,
): void {
  const used = new Set<string>();
  for (const occurrence of analysis.occurrences) {
    if (occurrence.port !== undefined) used.add(occurrence.port);
    for (const use of occurrence.uses) {
      const port = sourcePort(use.source);
      if (port !== undefined) used.add(port);
      if (use.source === "item" && scope.itemsPort !== undefined) used.add(scope.itemsPort);
    }
  }
  for (const port of scope.ports.values()) {
    if (used.has(port.name) || port.definition?.family === "workspace") continue;
    diagnostics.add({
      code: "prompt-input-unused",
      severity: "info",
      message: `The prompt never shows the input ${port.name}; add {{> input.${port.name}}} or remove the port`,
      port: port.name,
    });
  }
}

function renderModeLints(scope: GraphPromptScope, diagnostics: GraphPromptDiagnostics): void {
  for (const port of scope.ports.values()) {
    if (graphPromptEffectiveMode(port) === port.mode) continue;
    diagnostics.add({
      code: port.mode === "markdown" ? "prompt-markdown-unavailable" : "prompt-summary-unavailable",
      severity: "warning",
      message: `${port.typeLabel} has no ${port.mode === "markdown" ? "markdown template" : "summary fields"}; ${port.name} renders as json-frame`,
      port: port.name,
    });
  }
}

function ceilingLint(
  inputNominalBytes: number,
  ceiling: number,
  diagnostics: GraphPromptDiagnostics,
): void {
  if (inputNominalBytes <= ceiling) return;
  diagnostics.add({
    code: "prompt-size-over-ceiling",
    severity: "warning",
    message: `Rendered inputs can reach ${inputNominalBytes} bytes; the ceiling is ${ceiling}. Render large inputs as file, summary or on-demand`,
  });
}

// --------------------------------------------------------- built-in lints

function acceptsPort(definition: GraphBuiltInPromptPort, port: GraphPromptPort): boolean {
  if (port.listDepth > 0 !== (definition.list === true)) return false;
  const name = port.definition?.name;
  if (name !== undefined && definition.types?.includes(name)) return true;
  const family = port.definition?.family;
  return family !== undefined && (definition.families ?? []).includes(family);
}

/** Which node inputs a built-in reads: built-in input name → node port name. */
export function graphBuiltInPromptBindings(
  definition: GraphBuiltInPromptDefinition,
  scope: GraphPromptScope,
): { bound: Map<string, string>; extra: string[] } {
  const bound = new Map<string, string>();
  const taken = new Set<string>();
  for (const input of definition.inputs) {
    const port =
      [...scope.ports.values()].find(
        (candidate) =>
          !taken.has(candidate.name) &&
          candidate.name === input.name &&
          acceptsPort(input, candidate),
      ) ??
      [...scope.ports.values()].find(
        (candidate) => !taken.has(candidate.name) && acceptsPort(input, candidate),
      );
    if (!port) continue;
    bound.set(input.name, port.name);
    taken.add(port.name);
  }
  return { bound, extra: [...scope.ports.keys()].filter((name) => !taken.has(name)) };
}

function builtInLints(
  context: GraphPromptLintInput,
  scope: GraphPromptScope,
  builtIn: string,
  diagnostics: GraphPromptDiagnostics,
): void {
  const definition = graphBuiltInPrompt(builtIn);
  if (!definition) {
    diagnostics.add({
      code: "prompt-built-in-unknown",
      severity: "error",
      message: `There is no built-in prompt ${builtIn}`,
      path: builtIn,
    });
    return;
  }
  const { bound, extra } = graphBuiltInPromptBindings(definition, scope);
  for (const input of definition.inputs) {
    if (!input.required || bound.has(input.name)) continue;
    diagnostics.add({
      code: "prompt-built-in-input",
      severity: "error",
      message: `${definition.label} needs an input of type ${[...(input.types ?? []), ...(input.families ?? []).map((family) => `any ${family}`)].join(" or ")}${input.list ? " (a list)" : ""}: ${input.description}`,
      path: input.name,
    });
  }
  for (const name of extra) {
    diagnostics.add({
      code: "prompt-built-in-extra-input",
      severity: "info",
      message: `${definition.label} does not read ${name}; it is appended after the built-in text in its own frame`,
      port: name,
    });
  }
  const outputs = context.node.outputs ?? [];
  for (const output of definition.outputs) {
    if (!output.required) continue;
    const found = outputs.some((port) => {
      const parts = parseGraphTypeRef(port.type);
      return parts !== null && parts.listDepth === 0 && (output.types ?? []).includes(parts.name);
    });
    if (found) continue;
    diagnostics.add({
      code: "prompt-built-in-output",
      severity: "error",
      message: `${definition.label} fills an output of type ${(output.types ?? []).join(" or ")}; the node has none`,
      path: output.name,
    });
  }
  if (!definition.profiles.includes(context.node.capabilities.profile)) {
    diagnostics.add({
      code: "prompt-built-in-profile",
      severity: "info",
      message: `${definition.label} is written for the ${definition.profiles.join(" or ")} profile; this node uses ${context.node.capabilities.profile}`,
    });
  }
}

// ------------------------------------------------------------------ entry

export interface GraphPromptLintInput extends GraphPromptNodeContext {
  /** From `compileGraphCapabilities`; without it the profile and overrides are used. */
  compiled?: CompiledGraphCapabilities;
  /** Nominal bytes of rendered inputs; default {@link GRAPH_PROMPT_INPUT_CEILING_BYTES}. */
  ceilingBytes?: number;
}

export interface GraphPromptLintResult {
  diagnostics: GraphPromptDiagnostic[];
  /** Diagnostics beyond the cap, counted only. */
  omitted: number;
}

/** Every lint for one agent node's prompt. Never throws. */
export function lintGraphNodePrompt(
  input: GraphPromptLintInput,
  parsed?: { scope?: GraphPromptScope; template?: GraphPromptTemplate },
): GraphPromptLintResult {
  const diagnostics = new GraphPromptDiagnostics();
  const scope = parsed?.scope ?? graphPromptScope(input);
  const view = graphPromptCapabilityView(input);
  const outputs = input.node.outputs ?? [];
  const ceiling = input.ceilingBytes ?? GRAPH_PROMPT_INPUT_CEILING_BYTES;
  const prompt = input.node.prompt;
  renderModeLints(scope, diagnostics);

  if ("builtIn" in prompt) {
    // A built-in's inputs are sized by its backend builder, which holds its
    // own budgets (consolidation compacts evidence and fails before dispatch).
    builtInLints(input, scope, prompt.builtIn, diagnostics);
  } else {
    const template =
      parsed?.template ?? parseGraphPromptTemplate(prompt.template, { allowPartials: true });
    diagnostics.addAll(template.diagnostics);
    const analysis = analyzeGraphPromptTemplate(template, { kind: "scope", scope });
    for (const occurrence of analysis.occurrences) {
      const diagnostic = problemDiagnostic(occurrence, scope);
      if (diagnostic) diagnostics.add(diagnostic);
    }
    for (const text of analysis.texts) {
      if (neutralizeGraphPromptText(text.text) === text.text) continue;
      diagnostics.add({
        code: "prompt-reserved-marker",
        severity: "warning",
        message: "The text spells an Orkestrator frame marker; its `<` is written as `&lt;`",
        offset: text.offset,
      });
      break;
    }
    branchOrderLint(analysis, scope, diagnostics);
    unusedInputLint(analysis, scope, diagnostics);
    ceilingLint(
      estimateGraphPromptTemplateSize(scope, template).inputNominalBytes,
      ceiling,
      diagnostics,
    );
    const pieces = template.nodes.length === 0 ? [] : collectText(template);
    keywordLints(pieces, view, outputs, diagnostics);
  }
  for (const lens of scope.lenses) {
    keywordLints(
      [{ text: lens.instruction, offset: 0 }],
      view,
      outputs,
      diagnostics,
      `lens:${lens.key}`,
    );
  }
  return { diagnostics: diagnostics.list, omitted: diagnostics.omitted };
}

function collectText(template: GraphPromptTemplate): TextPiece[] {
  const pieces: TextPiece[] = [];
  const visit = (nodes: GraphPromptTemplate["nodes"]) => {
    for (const node of nodes) {
      if (node.kind === "text") pieces.push({ text: node.text, offset: node.offset });
      else if (node.kind === "section") visit(node.children);
    }
  };
  visit(template.nodes);
  return pieces;
}
