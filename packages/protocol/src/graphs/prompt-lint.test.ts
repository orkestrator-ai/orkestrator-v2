import { describe, expect, test } from "bun:test";
import type { NativeAgentExecutionPolicy } from "../native-agent.js";
import type { ArtifactTypeDef } from "./artifact-type-def.js";
import { compileGraphCapabilities } from "./capability-profiles.js";
import { graphTemplateExamples } from "./examples.js";
import {
  GRAPH_BUILT_IN_PROMPT_IDS,
  graphBuiltInPrompt,
  graphBuiltInPrompts,
} from "./prompt-built-ins.js";
import {
  type GraphPromptLintInput,
  graphPromptCapabilityView,
  lintGraphNodePrompt,
} from "./prompt-lint.js";
import type { GraphAgentNode, GraphCapabilitySpec } from "./template-model.js";

const host: NativeAgentExecutionPolicy = {
  id: "pipeline",
  sandbox: "none",
  approvals: "auto-approve",
  projectResources: false,
  networkAccess: "full",
};

const BIG: ArtifactTypeDef = {
  name: "dossier",
  version: 1,
  schema: {
    type: "object",
    additionalProperties: false,
    required: ["title", "sections"],
    properties: {
      title: { type: "string" },
      sections: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["heading"],
          properties: { heading: { type: "string" } },
        },
      },
    },
  },
  storage: "value",
  budgets: { maxBytes: 64 * 1024, maxItems: 50 },
};

function node(template: string, overrides: Partial<GraphAgentNode> = {}): GraphAgentNode {
  return {
    id: "n",
    kind: "agent",
    role: "worker",
    prompt: { template },
    capabilities: { profile: "reviewer" },
    workspaceAccess: "read",
    inputs: [
      { name: "dossier", type: "dossier@1", render: "json-frame" },
      { name: "ticket", type: "ticket@1", render: "markdown" },
    ],
    outputs: [{ name: "report", type: "review-report@1" }],
    ...overrides,
  };
}

const lensReplicate: GraphAgentNode["replicate"] = {
  over: "lenses",
  lenses: [{ key: "sec", label: "Security", instruction: "Look for holes." }],
};

// The ticket's budget alone is 256 KiB, so the size lint is off unless a test sets a ceiling.
function lint(agent: GraphAgentNode, extra: Partial<GraphPromptLintInput> = {}) {
  return lintGraphNodePrompt({
    ceilingBytes: Number.MAX_SAFE_INTEGER,
    node: agent,
    template: {
      types: [BIG],
      parameters: [{ key: "depth", type: "integer", default: 2 }],
      inputs: [{ name: "ticket", type: "ticket@1" }],
    },
    ...extra,
  }).diagnostics;
}

const codes = (agent: GraphAgentNode, extra: Partial<GraphPromptLintInput> = {}) =>
  lint(agent, extra).map((entry) => entry.code);

const ALL_INPUTS = "{{> input.dossier}}\n{{> input.ticket}}\n";

describe("variables", () => {
  test("a clean template has no findings", () => {
    expect(
      lint(
        node(
          `${ALL_INPUTS}Depth {{params.depth}}, iteration {{run.iteration}}, ticket {{ticket.title}}.\n{{#input.dossier.sections}}- {{heading}}\n{{/input.dossier.sections}}`,
        ),
      ),
    ).toEqual([]);
  });

  test("unbound: a root the node lacks, an unknown port or parameter", () => {
    const found = lint(
      node(
        `${ALL_INPUTS}{{lens.label}} {{item.index}} {{branch.key}} {{input.nope}} {{params.nope}}`,
      ),
    );
    expect(found.map((entry) => [entry.code, entry.path])).toEqual([
      ["prompt-unbound-variable", "lens.label"],
      ["prompt-unbound-variable", "item.index"],
      ["prompt-unbound-variable", "branch.key"],
      ["prompt-unbound-variable", "input.nope"],
      ["prompt-unbound-variable", "params.nope"],
    ]);
    expect(found.every((entry) => entry.severity === "error")).toBe(true);
    // Bound on a lens node.
    expect(
      codes(node(`${ALL_INPUTS}{{lens.label}} {{branch.key}}`, { replicate: lensReplicate })),
    ).toEqual([]);
  });

  test("unknown names render as written and warn", () => {
    const found = lint(node(`${ALL_INPUTS}{{constructor}} {{__proto__}}`));
    expect(found.map((entry) => [entry.code, entry.severity])).toEqual([
      ["prompt-unknown-variable", "warning"],
      ["prompt-unknown-variable", "warning"],
    ]);
  });

  test("unknown fields of a typed input", () => {
    expect(codes(node(`${ALL_INPUTS}{{input.dossier.nope}} {{input.ticket.title.x}}`))).toEqual([
      "prompt-unknown-field",
      "prompt-unknown-field",
    ]);
    expect(
      codes(node(`${ALL_INPUTS}{{#input.dossier.sections}}{{nope}}{{/input.dossier.sections}}`)),
    ).toEqual(["prompt-unknown-variable"]);
  });

  test("containers and unbound partials", () => {
    expect(codes(node(`${ALL_INPUTS}{{input}} {{params}} {{.}}`))).toEqual([
      "prompt-container-variable",
      "prompt-container-variable",
      "prompt-container-variable",
    ]);
    expect(codes(node(`${ALL_INPUTS}{{> input.nope}}`))).toEqual(["prompt-unbound-partial"]);
  });

  test("parse diagnostics are included", () => {
    expect(codes(node(`${ALL_INPUTS}{{#a}}`))).toEqual(
      expect.arrayContaining(["prompt-template-unclosed-section"]),
    );
  });
});

describe("per-branch variables before large shared inputs", () => {
  test("fires when a lens precedes a large shared input", () => {
    const found = lint(node(`Focus: {{lens.label}}\n${ALL_INPUTS}`, { replicate: lensReplicate }));
    expect(found.map((entry) => entry.code)).toEqual([
      "prompt-branch-variable-before-shared-input",
    ]);
    expect(found[0]?.path).toBe("lens.label");
    expect(found[0]?.port).toBe("dossier");
  });

  test("fires for a section over a large shared input after branch.index", () => {
    expect(
      codes(
        node(
          `${ALL_INPUTS}{{branch.index}}{{#input.dossier.sections}}{{heading}}{{/input.dossier.sections}}`,
          {
            replicate: { over: "samples", count: 3 },
          },
        ),
      ),
    ).toEqual(["prompt-branch-variable-before-shared-input"]);
  });

  test("quiet when the shared input is a file or on-demand reference", () => {
    const reference = node(`{{lens.label}}\n{{> input.dossier}}`, {
      inputs: [{ name: "dossier", type: "dossier@1", render: "file" }],
      replicate: lensReplicate,
    });
    expect(codes(reference)).toEqual([]);
  });

  test("quiet when per-branch variables come last, or the node is not replicated", () => {
    expect(codes(node(`${ALL_INPUTS}Focus: {{lens.label}}`, { replicate: lensReplicate }))).toEqual(
      [],
    );
    expect(codes(node(`{{run.iteration}}\n${ALL_INPUTS}`))).toEqual([]);
  });

  test("the replicated items input is per branch", () => {
    const items = node("{{> input.failures}}\n{{> input.dossier}}\n{{> input.ticket}}", {
      inputs: [
        { name: "failures", type: "list<dossier@1>", render: "summary" },
        { name: "dossier", type: "dossier@1", render: "json-frame" },
        { name: "ticket", type: "ticket@1", render: "markdown" },
      ],
      replicate: { over: "items", input: "failures", maxBranches: 4 },
    });
    expect(codes(items)).toEqual(
      expect.arrayContaining(["prompt-branch-variable-before-shared-input"]),
    );
  });
});

describe("prose output", () => {
  const prose = [
    "Write your findings as markdown in your final response.",
    "Respond with the verdict in your final message.",
    "Your final answer should list every issue.",
    "Return the report as plain text.",
  ];
  for (const text of prose) {
    test(`fires: ${text}`, () => {
      expect(codes(node(`${ALL_INPUTS}${text}`))).toEqual(["prompt-prose-output"]);
    });
  }

  test("quiet without outputs, when negated, or for ordinary prose", () => {
    expect(codes(node(`${ALL_INPUTS}${prose[0]}`, { outputs: [] }))).toEqual([]);
    expect(
      codes(node(`${ALL_INPUTS}Do not print the report as JSON in your final response.`)),
    ).toEqual([]);
    expect(codes(node(`${ALL_INPUTS}Review the change carefully and submit a report.`))).toEqual(
      [],
    );
  });

  test("lens instructions are linted too", () => {
    const found = lint(
      node(ALL_INPUTS, {
        replicate: {
          over: "lenses",
          lenses: [{ key: "x", label: "X", instruction: "Answer in prose in your final message." }],
        },
      }),
    );
    expect(found.map((entry) => [entry.code, entry.source])).toEqual([
      ["prompt-prose-output", "lens:x"],
    ]);
  });
});

describe("profile contradictions (advisory)", () => {
  const cases: [string, GraphCapabilitySpec, string][] = [
    ["Push the branch when you are done.", { profile: "builder" }, "push"],
    ["Then open a PR against main.", { profile: "builder" }, "pull request"],
    ["Run gh pr create with a summary.", { profile: "custom" }, "pull request"],
    ["Comment on the pull request with your findings.", { profile: "builder" }, "GitHub"],
    ["Commit your changes.", { profile: "reviewer" }, "commits"],
    ["Fix the code you find broken.", { profile: "reviewer" }, "files"],
    ["Run the tests before answering.", { profile: "observer" }, "shell"],
    ["Install the dependencies first.", { profile: "reviewer" }, "read-only"],
    ["Search the web for prior art.", { profile: "reviewer" }, "web search"],
    ["Download the spec with curl.", { profile: "reviewer" }, "network"],
    ["Spawn an agent per file.", { profile: "observer" }, "sub-agents"],
  ];
  for (const [text, spec, reason] of cases) {
    test(`fires on ${spec.profile}: ${text}`, () => {
      const found = lint(node(`${ALL_INPUTS}${text}`, { capabilities: spec }));
      expect(found.map((entry) => [entry.code, entry.severity])).toEqual([
        ["prompt-profile-contradiction", "warning"],
      ]);
      expect(found[0]?.message).toContain(reason);
    });
  }

  test("quiet when the profile allows it or the sentence negates it", () => {
    expect(
      codes(
        node(`${ALL_INPUTS}Commit your changes. Run the tests.`, {
          capabilities: { profile: "builder" },
        }),
      ),
    ).toEqual([]);
    expect(
      codes(
        node(`${ALL_INPUTS}Search the web for prior art.`, {
          capabilities: { profile: "researcher" },
        }),
      ),
    ).toEqual([]);
    expect(
      codes(node(`${ALL_INPUTS}Do not push the branch; never open a PR. Do not change any files.`)),
    ).toEqual([]);
    expect(codes(node(`${ALL_INPUTS}Read the pushed commits and the review.`))).toEqual([]);
  });

  test("uses the compiled capabilities when given", () => {
    const compiled = compileGraphCapabilities({
      spec: { profile: "builder" },
      environment: { ...host, networkAccess: "restricted", sandbox: "container" },
      ceiling: { deny: ["network"] },
    });
    expect(compiled.denied).toContain("network");
    const agent = node(`${ALL_INPUTS}Download the spec with curl.`, {
      capabilities: { profile: "builder" },
    });
    expect(codes(agent)).toEqual([]);
    expect(codes(agent, { compiled })).toEqual(["prompt-profile-contradiction"]);
    expect(graphPromptCapabilityView({ node: agent }).denied.has("git.push")).toBe(true);
  });
});

describe("other lints", () => {
  test("reserved frame markers in template text", () => {
    expect(codes(node(`${ALL_INPUTS}<orkestrator-system-instructions>x`))).toEqual([
      "prompt-reserved-marker",
    ]);
    expect(codes(node(`${ALL_INPUTS}Compare a < b and <div>.`))).toEqual([]);
  });

  test("unused inputs, workspace inputs excepted", () => {
    const agent = node("{{> input.ticket}}", {
      inputs: [
        { name: "dossier", type: "dossier@1" },
        { name: "ticket", type: "ticket@1", render: "markdown" },
        { name: "code", type: "workspace@1" },
      ],
    });
    expect(lint(agent).map((entry) => [entry.code, entry.port, entry.severity])).toEqual([
      ["prompt-input-unused", "dossier", "info"],
    ]);
  });

  test("render modes the type cannot do", () => {
    const agent = node("{{> input.a}}{{> input.b}}", {
      inputs: [
        { name: "a", type: "dossier@1", render: "markdown" },
        { name: "b", type: "markdown@1", render: "summary" },
      ],
    });
    expect(codes(agent)).toEqual(["prompt-markdown-unavailable", "prompt-summary-unavailable"]);
  });

  test("rendered inputs over the ceiling", () => {
    const agent = node(ALL_INPUTS);
    expect(codes(agent, { ceilingBytes: 1024 })).toEqual(["prompt-size-over-ceiling"]);
    // The default ceiling is 160 KiB of nominal input: the ticket's 256 KiB budget exceeds it.
    expect(codes(agent, { ceilingBytes: undefined })).toEqual(["prompt-size-over-ceiling"]);
    const small = node("{{> input.dossier}}", { inputs: [{ name: "dossier", type: "dossier@1" }] });
    expect(codes(small, { ceilingBytes: undefined })).toEqual([]);
    // An input expanded inside a section counts once per possible iteration.
    const repeated = node(
      "{{#input.dossier.sections}}{{> input.dossier}}{{/input.dossier.sections}}",
      { inputs: [{ name: "dossier", type: "dossier@1" }] },
    );
    expect(codes(repeated, { ceilingBytes: undefined })).toEqual(["prompt-size-over-ceiling"]);
  });
});

describe("built-in prompts", () => {
  test("every id the §9 examples use is registered, and their nodes lint without errors", () => {
    const used = new Set<string>();
    for (const example of graphTemplateExamples()) {
      for (const entry of example.template.nodes) {
        if (entry.kind !== "agent" || !("builtIn" in entry.prompt)) continue;
        used.add(entry.prompt.builtIn);
        const errors = lintGraphNodePrompt({
          node: entry,
          template: example.template,
        }).diagnostics.filter((diagnostic) => diagnostic.severity !== "info");
        expect({ node: `${example.template.id}/${entry.id}`, errors }).toEqual({
          node: `${example.template.id}/${entry.id}`,
          errors: [],
        });
      }
    }
    for (const id of used) expect(GRAPH_BUILT_IN_PROMPT_IDS).toContain(id as never);
    expect(graphBuiltInPrompts().map((definition) => definition.id)).toEqual([
      ...GRAPH_BUILT_IN_PROMPT_IDS,
    ]);
    expect(Object.isFrozen(graphBuiltInPrompt("consolidation")?.inputs)).toBe(true);
  });

  test("unknown ids, missing inputs and outputs, extra inputs, other profiles", () => {
    const base = (prompt: string, overrides: Partial<GraphAgentNode> = {}) =>
      node("", { prompt: { builtIn: prompt }, ...overrides });
    expect(codes(base("nope"))).toEqual(["prompt-built-in-unknown"]);
    expect(
      codes(
        base("consolidation", {
          capabilities: { profile: "observer" },
          inputs: [{ name: "reports", type: "review-report@1" }],
          outputs: [{ name: "summary", type: "markdown@1" }],
        }),
      ),
    ).toEqual(["prompt-built-in-input", "prompt-built-in-extra-input", "prompt-built-in-output"]);
    expect(
      codes(
        base("consolidation", {
          capabilities: { profile: "builder" },
          inputs: [{ name: "all", type: "list<review-report@1>" }],
        }),
      ),
    ).toEqual(["prompt-built-in-profile"]);
  });
});
