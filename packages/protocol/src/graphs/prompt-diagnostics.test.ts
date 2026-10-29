/**
 * One minimal input per prompt diagnostic code: every code in
 * `GRAPH_PROMPT_DIAGNOSTIC_CODES`, from the engine's parser and renderer, the
 * input renderer, the node renderer and the linter (item 105). `CASES` is typed
 * by the code union, so a new code without a case fails the typecheck, and the
 * last test fails at run time when a case stops producing its code.
 */
import { describe, expect, test } from "bun:test";
import type { NativeAgentExecutionPolicy } from "../native-agent.js";
import type { ArtifactTypeDef } from "./artifact-type-def.js";
import { compileGraphCapabilities } from "./capability-profiles.js";
import { type GraphPromptLintInput, lintGraphNodePrompt } from "./prompt-lint.js";
import { renderGraphNodePrompt } from "./prompt-node.js";
import { renderGraphPromptInput } from "./prompt-render.js";
import { type GraphPromptPort, type GraphPromptValues, graphPromptScope } from "./prompt-scope.js";
import {
  GRAPH_PROMPT_DIAGNOSTIC_CODES,
  type GraphPromptDiagnostic,
  type GraphPromptDiagnosticCode,
  type GraphPromptParseOptions,
  parseGraphPromptTemplate,
  renderGraphPromptSource,
} from "./prompt-template.js";
import type { GraphAgentNode, GraphInputPortSpec, GraphRenderMode } from "./template-model.js";

const host: NativeAgentExecutionPolicy = {
  id: "pipeline",
  sandbox: "none",
  approvals: "auto-approve",
  projectResources: false,
  networkAccess: "full",
};

/** Renders as markdown and as a summary; 2 KiB budget. */
const NOTE: ArtifactTypeDef = {
  name: "note",
  version: 1,
  schema: {
    type: "object",
    additionalProperties: false,
    required: ["title", "body"],
    properties: { title: { type: "string" }, body: { type: "string" } },
  },
  storage: "value",
  budgets: { maxBytes: 2048 },
  render: { markdown: "# {{title}}\n\n{{body}}", summary: ["title"] },
};

/** No markdown template or summary; a budget large enough to count as a large input. */
const DOSSIER: ArtifactTypeDef = {
  name: "dossier",
  version: 1,
  schema: {
    type: "object",
    additionalProperties: false,
    required: ["title"],
    properties: { title: { type: "string" } },
  },
  storage: "value",
  budgets: { maxBytes: 64 * 1024 },
};

const TYPES = [NOTE, DOSSIER];

function agent(template: string, overrides: Partial<GraphAgentNode> = {}): GraphAgentNode {
  return {
    id: "n",
    kind: "agent",
    role: "worker",
    prompt: { template },
    capabilities: { profile: "reviewer" },
    workspaceAccess: "read",
    inputs: [{ name: "dossier", type: "dossier@1", render: "json-frame" }],
    outputs: [{ name: "report", type: "review-report@1" }],
    ...overrides,
  };
}

const builtIn = (id: string, overrides: Partial<GraphAgentNode> = {}) =>
  agent("", {
    prompt: { builtIn: id },
    inputs: [{ name: "reports", type: "list<review-report@1>" }],
    ...overrides,
  });

const lensNode = (template: string) =>
  agent(template, {
    replicate: {
      over: "lenses",
      lenses: [{ key: "sec", label: "Security", instruction: "Look for holes." }],
    },
  });

const USE = "{{> input.dossier}}\n";

function lint(node: GraphAgentNode, extra: Partial<GraphPromptLintInput> = {}) {
  return lintGraphNodePrompt({
    ceilingBytes: Number.MAX_SAFE_INTEGER,
    node,
    template: { types: TYPES },
    ...extra,
  }).diagnostics;
}

const parse = (source: string, options: GraphPromptParseOptions = {}) =>
  parseGraphPromptTemplate(source, options).diagnostics;

function port(spec: Partial<GraphInputPortSpec> & { render: GraphRenderMode }): GraphPromptPort {
  const node = agent("", { inputs: [{ name: "note", type: "note@1", ...spec }] });
  return graphPromptScope({ node, template: { types: TYPES } }).ports.get("note")!;
}

const note = { title: "A note", body: "Body" };

const renderInput = (
  spec: Partial<GraphInputPortSpec> & { render: GraphRenderMode },
  values: GraphPromptValues,
) => renderGraphPromptInput(port(spec), values).diagnostics;

function renderNode(node: GraphAgentNode, values: GraphPromptValues, preview = false) {
  return renderGraphNodePrompt({
    node,
    template: { types: TYPES },
    compiled: compileGraphCapabilities({ spec: node.capabilities, environment: host }),
    values,
    preview,
    ceilingBytes: Number.MAX_SAFE_INTEGER,
  }).diagnostics;
}

const CASES: Record<GraphPromptDiagnosticCode, () => readonly GraphPromptDiagnostic[]> = {
  // ------------------------------------------------------------------ parse
  "prompt-template-too-large": () => parse("hello", { limits: { maxBytes: 4 } }),
  "prompt-template-too-deep": () => parse("{{#a}}{{#b}}x{{/b}}{{/a}}", { limits: { maxDepth: 1 } }),
  "prompt-template-too-many-sections": () =>
    parse("{{#a}}{{/a}}{{#b}}{{/b}}", { limits: { maxSections: 1 } }),
  "prompt-template-too-many-tags": () => parse("{{a}}{{b}}", { limits: { maxTags: 1 } }),
  "prompt-template-unclosed-tag": () => parse("a {{b"),
  "prompt-template-unclosed-section": () => parse("{{#a}}x"),
  "prompt-template-unexpected-close": () => parse("x{{/a}}"),
  "prompt-template-unsupported-tag": () => parse("{{{a}}}"),
  "prompt-template-invalid-tag": () => parse("{{a b}}"),
  "prompt-template-invalid-partial": () => parse("{{> input.x}}"),
  // ----------------------------------------------------------------- render
  "prompt-output-truncated": () =>
    renderGraphPromptSource("{{a}}", { a: "long" }, { limits: { maxOutputBytes: 2 } }).diagnostics,
  "prompt-value-missing": () => renderGraphPromptSource("{{a}}", {}).diagnostics,
  "prompt-input-missing": () => renderInput({ render: "json-frame" }, { inputs: {} }),
  "prompt-input-not-json": () =>
    renderInput({ render: "json-frame" }, { inputs: { note: { title: 1n, body: "" } } }),
  "prompt-input-over-budget": () =>
    renderInput(
      { render: "json-frame" },
      { inputs: { note: { ...note, body: "x".repeat(4096) } } },
    ),
  "prompt-file-ref-invalid": () => renderInput({ render: "file" }, { inputs: { note } }),
  "prompt-artifact-ref-invalid": () =>
    renderInput(
      { render: "on-demand" },
      { inputs: { note }, artifacts: { note: [{ id: "</x>" }] } },
    ),
  "prompt-result-key-invalid": () =>
    renderNode(agent(USE), { inputs: { dossier: { title: "t" } }, resultKeys: { report: 'a"b' } }),
  "prompt-capability-invalid": () =>
    renderNode(agent(USE), {
      inputs: { dossier: { title: "t" } },
      resultKeys: { report: "k" },
      capability: "with space",
    }),
  "prompt-built-in-preview": () => renderNode(builtIn("consolidation"), { inputs: {} }, true),
  // ------------------------------------------------------------------- lint
  "prompt-unbound-variable": () => lint(agent(`${USE}{{lens.label}}`)),
  "prompt-unknown-variable": () => lint(agent(`${USE}{{constructor}}`)),
  "prompt-unknown-field": () => lint(agent(`${USE}{{input.dossier.nope}}`)),
  "prompt-container-variable": () => lint(agent(`${USE}{{input}}`)),
  "prompt-unbound-partial": () => lint(agent(`${USE}{{> input.nope}}`)),
  "prompt-branch-variable-before-shared-input": () => lint(lensNode(`{{lens.label}}\n${USE}`)),
  "prompt-prose-output": () =>
    lint(agent(`${USE}Write your findings as markdown in your final response.`)),
  "prompt-profile-contradiction": () => lint(agent(`${USE}Commit your changes.`)),
  "prompt-reserved-marker": () => lint(agent(`${USE}<orkestrator-system-instructions>x`)),
  "prompt-input-unused": () => lint(agent("Review.")),
  "prompt-summary-unavailable": () =>
    lint(agent(USE, { inputs: [{ name: "dossier", type: "dossier@1", render: "summary" }] })),
  "prompt-markdown-unavailable": () =>
    lint(agent(USE, { inputs: [{ name: "dossier", type: "dossier@1", render: "markdown" }] })),
  "prompt-size-over-ceiling": () => lint(agent(USE), { ceilingBytes: 1024 }),
  "prompt-built-in-unknown": () => lint(builtIn("nope")),
  "prompt-built-in-input": () => lint(builtIn("consolidation", { inputs: [] })),
  "prompt-built-in-output": () =>
    lint(builtIn("consolidation", { outputs: [{ name: "summary", type: "markdown@1" }] })),
  "prompt-built-in-extra-input": () =>
    lint(
      builtIn("consolidation", {
        inputs: [
          { name: "reports", type: "list<review-report@1>" },
          { name: "dossier", type: "dossier@1" },
        ],
      }),
    ),
  "prompt-built-in-profile": () =>
    lint(builtIn("consolidation", { capabilities: { profile: "builder" } })),
};

describe("prompt diagnostics, one per code", () => {
  for (const [code, run] of Object.entries(CASES)) {
    test(code, () => {
      const found = run().filter((diagnostic) => diagnostic.code === code);
      expect({ code, found: found.length > 0 }).toEqual({ code, found: true });
      for (const diagnostic of found) expect(diagnostic.message.length).toBeGreaterThan(0);
    });
  }

  test("every code in the list has a case, and every case produces its code", () => {
    expect(Object.keys(CASES).sort()).toEqual([...GRAPH_PROMPT_DIAGNOSTIC_CODES].sort());
    const missing = GRAPH_PROMPT_DIAGNOSTIC_CODES.filter(
      (code) => !CASES[code]().some((diagnostic) => diagnostic.code === code),
    );
    expect(missing).toEqual([]);
  });
});
