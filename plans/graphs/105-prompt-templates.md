---
id: 105
title: "Prompt templates"
phase: 1
plan: "P1.5"
status: in-progress
depends_on: [101, 102, 106]
blocked_by: ""
owner: "Claude Opus 5.5 (implement-graph-tasks)"
branch: "graphs-106-capabilities"
pr: ""
updated: 2026-10-29
---

# 105 · Prompt templates

- **Plan:** [P1.5 Prompt templates](../composable-graphs.md#p15-prompt-templates)
- **Decisions:** D13
- **Depends on:** [101](101-template-schema.md), [102](102-type-library.md), [106](106-capability-profiles.md)
- **How to keep this file current:** [AGENTS.md](AGENTS.md)

## Goal

Node prompts are user templates with no executable logic, rendered behind a locked system contract.

## Work

- [x] A logic-less engine: variables, list sections and input partials, nothing executable.
- [x] The five render modes: `json-frame`, `markdown`, `summary`, `file`, `on-demand`. Evidence frames reuse `review-evidence-frames.ts`.
- [x] A size estimator based on type budgets.
- [x] Lints: unbound variables; per-branch variables before large shared inputs; prose output requested when output ports exist; instructions that contradict the profile (advisory).
- [x] The locked system contract from `withUnattendedPolicy`, `workflowResultInstruction` and a capability statement generated from the node's profile ([106](106-capability-profiles.md)).

## Tests

- [x] Rendering per mode, including escaping inside frames.
- [x] Each lint fires and stays quiet on the right inputs.
- [x] Templates that look like code (`{{constructor}}`, prototype names) render literally.
- [x] Size estimates bound the actual rendered size.

## Done when

- [x] Prompt templates are merged with tests and used by [107](107-compiler.md).
- [x] Prompt templates are used by [204](204-agent-node-executor.md).

## Notes

**2026-10-29 · Files and exports.** One package export, `./graphs/prompts` (`graphs/prompts.ts`),
re-exports every module, all browser-safe in `packages/protocol/src/graphs/`: `prompt-template.ts`
(engine, diagnostic codes), `prompt-scope.ts` (variables, static bounds, run context),
`prompt-analysis.ts` (static resolution and the size bound), `prompt-render.ts` (render modes),
`prompt-size.ts` (estimator), `prompt-built-ins.ts` (registry), `prompt-lint.ts`,
`system-contract.ts`, `prompt-node.ts` (`renderGraphNodePrompt`, preview values). Tests beside each.

**2026-10-29 · What moved (behaviour unchanged, old names re-exported).**
`serializeFramedEvidence` (from backend `review-consolidation-evidence.ts`) and `promptCarrierJson`
(from backend `build-pipeline-handoff.ts`, and a private copy in protocol `multi-review.ts`) are now in
protocol `review-evidence-frames.ts`, beside new `escapeFramedEvidenceText`,
`GRAPH_EVIDENCE_FRAME_TAG`/`_CLOSE`, `graphEvidenceFrameOpen` and `wrapGraphEvidenceFrame`.
`UNATTENDED_POLICY_INSTRUCTION` and `withUnattendedPolicy` (from backend
`build-pipeline-service-helpers.ts`) are in protocol `agent-interactions.ts`, plus
`unattendedPolicyFrame()`. `workflowResultInstruction` now delegates to the new
`workflowResultSlotInstruction({noun, submitTool, validateTool, statusTool, resultKey, capability?,
progress?})` (output byte-identical for every kind, checked against the old function); its shared
sentences are exported (`WORKFLOW_RESULT_INSTRUCTION_PREAMBLE`, `WORKFLOW_RESULT_ARGUMENT_GUIDANCE`,
`WORKFLOW_RESULT_INSTRUCTION_CLOSING`, `workflowResultCapabilityArgument`). Backend suites for every
file code moved out of pass unchanged.

**2026-10-29 · Engine.** `parseGraphPromptTemplate(source, {allowPartials?, limits?})` →
`{nodes, diagnostics, bytes}`; `renderGraphPromptTemplate(template, context, {escapeValue?, escapeText?,
partial?, lookup: {aliases?, containers?}, limits?})` → `{text, bytes, truncated, diagnostics}`;
`renderGraphPromptSource` does both. Mustache subset: `{{a.b}}`, `{{.}}`, `{{#x}}…{{/x}}` (lists repeat,
other truthy values render once with the value as context), `{{^x}}`, `{{> input.<port>}}` (node templates
only), `{{! comment}}`; standalone section/comment lines are removed. Lookup is Mustache's (first segment
searched outwards, the rest followed without fallback) over own properties of plain objects and in-range
array indices only. Anything else (`{{{x}}}`, `{{&x}}`, `{{=…=}}`, `{{each x}}`, `{{a + b}}`, unresolved
names, `{{constructor}}`, `{{list.length}}`) renders as written. Falsy: missing, null, false, `""`, 0,
NaN, `[]`. Objects interpolate as framed JSON. Limits `GRAPH_PROMPT_TEMPLATE_LIMITS` (64 KiB, depth 8,
256 sections, 2048 tags, names ≤ 256 chars and 16 segments) and `GRAPH_PROMPT_RENDER_LIMITS` (8 MiB
output, 100 000 section repetitions). Never throws; ≤ 64 diagnostics per call.

**2026-10-29 · Variables** (`prompt-scope.ts`). Roots: `input.<port>` (a list port is a list; on an
`items` node the replicated port is the branch's element), `params.<key>` (launch value, else default),
`run.iteration` (1-based, always bound), `lens.{key,label,instruction}` (lens nodes), `item` and
`item.index` (items nodes; `item.index` is reserved for the branch index), `branch.{index,key,count}`
(replicated nodes; 1-based), `ticket` (bound when the template has a `ticket@N` run input; its value).
`lens`, `item`, `branch` and the items input are per branch. `{{input}}`, `{{params}}` and a root `{{.}}`
never resolve. Runtime values: `GraphPromptValues {inputs, params?, run?, lens?, branch?, ticket?, files?
{port: {path ≤ 1 KiB, sha256, bytes?}}, artifacts? {port: [{id ≤ 128 B, bytes?}]}, resultKeys?
{port: key}, capability?}`.

**2026-10-29 · Render modes** (`renderGraphPromptInput(port, values, {preview?})`). One frame per
input: `<orkestrator-evidence port="…" type="…" render="…">`, body, `</orkestrator-evidence>`
(attributes escaped). `json-frame`: `serializeFramedEvidence` (the consolidation serializer).
`markdown`: the type's `render.markdown` template over the value, then `<`/`>` → `&lt;`/`&gt;` over the
body. `summary`: `field: value` lines for `render.summary`. `file`: `path:`, `sha256:`, `bytes:` and a
hint; `on-demand`: ids, `Fields:` and a `read_artifact` hint. Lists render element by element joined by
`\n\n---\n\n`. Default mode when a port sets none: `file` for reference types, else `json-frame`. A type
without a markdown template or summary fields renders `json-frame` (lint warns). Absent inputs render
`(No <port> input for this run.)`. Decisions: the markdown mode uses the type's logic-less template,
not `formatter` (`formatStructuredReviewReport` cannot be bounded from budgets and throws on invalid
input); `&` is not escaped. Template text is the author's and is not escaped, but `<` before a backend
frame name (`orkestrator-…`, the Multi Review frames) becomes `&lt;` (`neutralizeGraphPromptText`);
interpolated values are text-escaped.

**2026-10-29 · Size** (`prompt-size.ts`). Every figure has `nominalBytes` (inputs at their type
budgets, nothing to escape; compare with the ceiling) and `maxBytes` (hard bound including escaping,
×6 for values). `estimateGraphPromptInput(port)`, `estimateGraphPromptTemplateSize(scope, template)`,
`estimateGraphPromptUserSize(context)`, `estimateGraphNodePromptSize({…context, compiled, actions?})` →
`{nominalBytes, maxBytes, bounded, user, systemBytes, inputs [{port, mode, nominalBytes, maxBytes,
expansions}], inputNominalBytes}`. The bound is a static walk: each tag's possible resolutions, weights
for values re-read inside loops, and the heaviest path of each source's access trie times its byte
budget; property tests check it over random and adversarial values, and mutation checks showed the
tests fail without the escape factor or the loop weights. `GRAPH_PROMPT_INPUT_CEILING_BYTES` = 160 KiB.
List ports assume 32 elements unless the caller passes `listItems`; 107 should pass `portTypes` (after
transforms) and `listItems` (the producer's fan-out). Built-in prompts are `bounded: false`: a per-id
text allowance plus each input once.

**2026-10-29 · Lint codes** (`lintGraphNodePrompt(context, parsed?)` → `{diagnostics, omitted}`;
diagnostics `{code, severity, message, offset?, length?, path?, port?, source?}`).
`prompt-unbound-variable` (error), `prompt-unknown-variable` (warning, renders as written),
`prompt-unknown-field` (error), `prompt-container-variable` (error), `prompt-unbound-partial` (error),
`prompt-branch-variable-before-shared-input` (warning; a per-branch tag before a shared partial ≥ 1 KiB
nominal that is not `file`/`on-demand`, or a section over a large shared input),
`prompt-prose-output` (warning; node has outputs), `prompt-profile-contradiction` (warning, advisory;
push, pull requests and GitHub writes always (D12); commits, file edits, shell, installs, web search,
network and sub-agents per the compiled capabilities, or the profile and overrides without them),
`prompt-reserved-marker` (warning), `prompt-input-unused` (info; workspace inputs excepted),
`prompt-markdown-unavailable` / `prompt-summary-unavailable` (warning), `prompt-size-over-ceiling`
(warning; user templates only, built-ins rely on their builders' own budgets), `prompt-built-in-unknown`,
`prompt-built-in-input`, `prompt-built-in-output` (errors), `prompt-built-in-extra-input`,
`prompt-built-in-profile` (info). Keyword lints skip matches negated earlier in the sentence and also
scan lens instructions (`source: "lens:<key>"`). Engine codes `prompt-template-*` (too-large,
too-deep, too-many-sections, too-many-tags, unclosed-tag, unclosed-section, unexpected-close,
unsupported-tag, invalid-tag, invalid-partial) and render codes (`prompt-output-truncated`,
`prompt-value-missing`, `prompt-input-missing`, `prompt-input-not-json`, `prompt-input-over-budget`,
`prompt-file-ref-invalid`, `prompt-artifact-ref-invalid`, `prompt-result-key-invalid`,
`prompt-capability-invalid`, `prompt-built-in-preview`) are listed in `GRAPH_PROMPT_DIAGNOSTIC_CODES`.

**2026-10-29 · Built-in prompts (for 107, 108, 204).** `GRAPH_BUILT_IN_PROMPT_IDS`:
`review-package-preparation`, `discovery-review`, `consolidation`, `fix-review-issues`,
`address-review`, `build`, `pipeline-fix`, `verify`, `pull-request-description`, `resolve-conflicts`.
Each `GraphBuiltInPromptDefinition` has inputs and outputs (matched by type name or family, not port
name), profiles, `backend` (the builder 204 binds) and `textMaxBytes`. Bindings: preparation →
`createMultiReviewPreparationPrompt` / `reviewValidationDiscoveryPrompt`; review →
`createPackagedMultiReviewerPrompt` / `reviewPrompt`; consolidation →
`createMultiReviewConsolidationPrompt`; fix → `addressPrompt` / `multiReviewCustomFixPrompt`; address →
`addressPrompt` + `addressValidationInstruction`; build → `buildPrompt`; pipeline-fix → `fixPrompt`;
verify → `verificationPrompt`. **Gap for 204/108:** `prPrompt` pushes and opens the PR and
`resolveConflictsPrompt` pushes; no agent node may (D12), so `pull-request-description` and
`resolve-conflicts` need push-free builders. 204 passes the builder's text as `builtInText`; inputs the
built-in does not read (`graphBuiltInPromptBindings(...).extra`) are appended as frames after it.

**2026-10-29 · System contract and entry point.** `renderGraphNodePrompt({node, template?, library?,
portTypes?, listItems?, compiled, actions?, enforcement?, values, builtInText?, preview?,
ceilingBytes?})` → `{system, user, prompt, bytes, diagnostics, omittedDiagnostics}`; `prompt` =
`user + "\n\n" + system` is what the provider gets, and `bytes` its UTF-8 size. The contract goes after
the user part, as today's workflows append theirs, so the template's shared prefix stays cacheable
(result keys differ per activation): a frame with `describeGraphCapabilities` and
`GRAPH_UNTRUSTED_EVIDENCE_INSTRUCTION`, then `unattendedPolicyFrame()`, then
`graphOutputResultInstruction` (one required output: `workflowResultSlotInstruction` with
`submit_<port>`, `validate_<port>`, `result_status`; otherwise one line per port).
`report_progress` guidance names the argument `item` (one entry of the type's `items.path` list): 204
should mint the tool with that argument. Result keys must match `^[A-Za-z0-9_-]{1,128}$` and the
capability `^[A-Za-z0-9._~:+/=-]{1,256}$`, else an error diagnostic and a stand-in. Preview: pass
`graphNodePromptPreviewValues(context)` (type examples, two elements per list, first lens, branch 1,
ticket example) and `preview: true` (stand-ins for paths, ids, keys, built-in text; missing examples
warn). The unattended policy text is today's verbatim ("non-interactive build session"); `ask_human`
nodes still get it, since it concerns provider input requests, and their capability statement offers
`ask_human`.

**2026-10-29 · Fixture change.** The §9.3 `design-brief@1` type in `graphs/examples.ts` gains a
markdown template: `describe-pr` reads the brief in `markdown` mode, which otherwise fell back to
`json-frame` with a warning.

**2026-10-29 · Open box.** "Done when" stays unticked: 107 and 204 have not started, and there is no PR.

**2026-10-29 · Used by 107; box split.** `graphs/lint.ts` runs `lintGraphNodePrompt` on every agent
node with the compiler's `portTypes` (delivered types after transforms) and `listItems` (the
producers' worst-case fan-out, so a three-lens fan-in is sized as three, not 32), the compiled
capabilities and the caller's ceiling (`promptCeilingBytes`, default 160 KiB). `prompt-*` codes
pass through unchanged, pinned to `nodes[i].prompt(.template)` with `offset`/`length`/`port`. The
plan's input `render` is `graphPromptEffectiveMode` of the same scope. The Done-when box is split:
the 107 half is ticked, the 204 half stays open.

**2026-10-29 · Changed by 108.** Built-in definitions corrected to match their builders, so the
built-in templates compile cleanly: `consolidation` takes an optional `package` input and lists
`reviewer` among its profiles; `address-review` and `verify` take an optional `package` input
(recorded validation); `build` and `pipeline-fix` declare their `fix-result` output optional
(today's Build and Fix turns submit none). See [108](108-builtin-templates.md) Notes.

**2026-10-29 · Used by 204.** The agent executor renders every activation through
`renderGraphNodePrompt` (`graph-agent-prompt.ts`), with built-in prompt text from today's builders
(`graph-agent-builtins.ts`; `pull-request-description` and `resolve-conflicts` bind the new push-free
`pullRequestDescriptionPrompt` and `resolveConflictsLocallyPrompt`). Changed here for 204:
`GRAPH_RESULT_STATUS_TOOL` is the real `get_workflow_result_status` (106's names were provisional),
`graphNodeResultSlots` skips `workspace@N` outputs (the runtime fills them from Git; no tool is
minted), and `renderGraphNodePrompt`/`graphSystemContract` take `resultTools: "broker"` for
OpenCode's generic `submit_graph_output`/`validate_workflow_result`. The registry's `backend`
strings name the push-free builders. The Done-when box is ticked.

## Progress log

Newest last: `YYYY-MM-DD · who · what changed · next step`.

- 2026-10-29 · plan · Created from the plan. · Not started.
- 2026-10-29 · Claude Opus 5.5 (implement-graph-tasks) · Template engine, variables, five render modes in shared evidence frames, size estimator with bound tests, lints, built-in prompt registry, system contract and `renderGraphNodePrompt`; framing, unattended policy and result-instruction pieces moved to the protocol. · Work and tests done; the Done-when box waits for 107/204 and the PR.
- 2026-10-29 · Claude Opus 5.5 (implement-graph-tasks) · 107 runs the lints and size estimate; Done-when split, 107 half ticked. · 204 half open.
- 2026-10-29 · Claude Opus 5.5 (implement-graph-tasks) · 204 renders agent prompts through `renderGraphNodePrompt`; status tool, workspace slots and broker tools settled for it. · complete; awaiting PR
