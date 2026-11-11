/**
 * Orkestrator's own system-level instructions, delivered to every agent
 * provider through its native channel: Claude's appended system prompt, Codex
 * developer instructions, an instruction entry on each OpenCode session, Pi's appended system
 * prompt, Grok's `--rules`, and a system-instructions frame on Cursor prompts
 * (Cursor has no channel that adds to its system prompt).
 *
 * Two blocks, so the providers differ only where they have to:
 *
 * - `GENERAL_AGENT_INSTRUCTIONS` describe Orkestrator itself and are the same
 *   for every provider. Add a rule here unless it only makes sense for one.
 * - Provider-specific lines (Claude's tool and connector rules) live in that
 *   provider's bridge and are passed to `agentSystemInstructions`.
 *
 * Read-only coordinator sessions do not receive the general block: its rules
 * ask the agent to write a file or publish a visual, which a coordinator
 * delegates to a worker.
 *
 * The repository's own AGENTS.md is a third block. Every provider reads it,
 * coordinators included: natively where the provider loads it (OpenCode, Pi,
 * and the others when the session turns project resources on), otherwise
 * from `repositoryInstructionsBlock` through the same channel as the general
 * block. Loading it never trusts the checkout's executable configuration
 * (hooks, MCP servers, settings), which stays behind project resources.
 */

import { STATIC_PRESENTATION_POLICY } from "./rich-content-policy.js";

/**
 * Markdown images render inline in the transcript, but only from storage the
 * host preview may read. Project-home checkouts are excluded even when they are
 * the working directory, so the storage boundary is stated explicitly.
 */
export const AGENT_IMAGE_PREVIEW_INSTRUCTION =
  "Orkestrator renders Markdown images inline in the transcript. When you show the user an image in your reply (a photograph, screenshot, rendered preview, or a requested image file) using Markdown image syntax, reference it by its absolute path. In a managed worktree or container environment, save the file inside the working directory, preferably in a git-ignored folder so preview files stay out of the change set. Local image previews are limited to Orkestrator-managed workspace storage or the container's /workspace. Project-home checkouts are excluded from host preview reads, even when they are the working directory, so images saved there cannot be previewed from a local Markdown path. Paths outside previewable storage, such as /tmp, also show a placeholder.";

/** Orkestrator shows files in the working directory; it opens no remote document service. */
export const AGENT_DOCUMENT_INSTRUCTION =
  "When the user asks for a document (a report, design doc, plan, analysis, guide, or other writing to keep), prefer writing it as a Markdown file in a `docs/` folder at the root of the working directory, and tell the user the file's path. Project instructions (such as AGENTS.md or CLAUDE.md), local skills, and the user's own request take priority over this default when they say where or how to write documents.";

/**
 * The fields of each chart kind, beside the common `schemaVersion`, `kind`,
 * `title` and `description`. One example alone is not enough: given only a donut,
 * a real session guessed a bar chart's fields and failed validation.
 */
export const AGENT_CHART_SPEC_SHAPES =
  "bar adds xAxis:{kind:'category',label}, yAxis:{label,unit?}, categories:[{id,label}], series:[{id,label,points:[{categoryId,value|null}]}] (one point per category); " +
  "line/area/scatter add xAxis:{kind:'number'|'utc-time',label,unit?}, yAxis:{label,unit?}, series:[{id,label,points:[{x,y|null}]}]; " +
  "donut adds valueLabel, unit?, slices:[{id,label,value}]";

/** A small valid `chart` fence body; a test parses it with the real validator. */
export const AGENT_CHART_FENCE_EXAMPLE =
  '{"schemaVersion":1,"kind":"bar","title":"Passing tests","description":"Passing tests per suite.","xAxis":{"kind":"category","label":"Suite"},"yAxis":{"label":"Tests"},"categories":[{"id":"unit","label":"Unit"},{"id":"browser","label":"Browser"}],"series":[{"id":"passed","label":"Passed","points":[{"categoryId":"unit","value":40},{"categoryId":"browser","value":8}]}]}';

/**
 * Which visual to use for what. The artifact half is conditional because some
 * sessions have no artifact tools; a session's own tool list and the tool
 * server's instructions say whether they are present and whether verification
 * is available right now.
 */
export const AGENT_VISUAL_OUTPUT_INSTRUCTION = [
  "Orkestrator displays rich visuals directly in the conversation; choose one when it helps answer the question.",
  `Flows, architecture, sequences and relationships: a \`mermaid\` code fence. Standard bar, line, area, scatter and donut charts: a \`chart\` code fence holding one ChartSpecV1 JSON object with schemaVersion 1, kind, title and description; ${AGENT_CHART_SPEC_SHAPES}. For example: ${AGENT_CHART_FENCE_EXAMPLE}.`,
  "When this session has the Orkestrator artifact tools, use them for durable visuals: create_artifact, preview_artifact, get_artifact_operation to inspect the diagnostics and capture, then publish_artifact, and respect their repair limits.",
  `A custom report, timeline or layout combining text and graphics is an html-static artifact: self-contained HTML, CSS and inline SVG, with no scripts or network resources. Its verified document is displayed in the transcript as real, selectable content, so keep it within ${STATIC_PRESENTATION_POLICY.maxDocumentBytes / 1024} KiB and ${STATIC_PRESENTATION_POLICY.maxElements} elements, use fluid widths, let content set the height (no 100vh on the root), and colour it with the --ork-foreground, --ork-muted-foreground, --ork-background, --ork-border, --ork-primary and --ork-chart-1 to --ork-chart-8 CSS variables, which follow the application theme. Always give them a fallback, such as var(--ork-foreground, #18181b), because the preview defines none of them.`,
  "Behaviour that needs authored JavaScript, such as a calculator or a filterable dashboard, is an html-interactive artifact; it runs when the reader activates it.",
  "Use ordinary images only for photographs, screenshots and requested image files.",
  "HTML, SVG and JavaScript code fences are shown as source and a file path alone publishes nothing: a visual is in the conversation only once publish_artifact succeeds. If verification is unavailable, say so and use a supported form such as a Mermaid or chart fence.",
].join(" ");

/** The block every provider receives, in order. */
export const GENERAL_AGENT_INSTRUCTIONS: readonly string[] = [
  AGENT_VISUAL_OUTPUT_INSTRUCTION,
  AGENT_IMAGE_PREVIEW_INSTRUCTION,
  AGENT_DOCUMENT_INSTRUCTION,
];

/**
 * The general block followed by a provider's own lines, as one text.
 * Blank provider lines are dropped so an optional rule can be passed as "".
 */
export function agentSystemInstructions(providerSpecific: readonly string[] = []): string {
  return [...GENERAL_AGENT_INSTRUCTIONS, ...providerSpecific]
    .filter((line) => line.trim().length > 0)
    .join("\n\n");
}

/** The repository instruction file every provider reads. */
export const REPOSITORY_INSTRUCTIONS_FILE = "AGENTS.md";

/**
 * A repository's AGENTS.md as system-level instructions, for a session whose
 * provider does not load it itself. `truncated` says the file was longer than
 * the channel holds, and the block then tells the agent where the rest is.
 */
export function repositoryInstructionsBlock(
  path: string,
  content: string,
  truncated: boolean,
): string {
  return [
    `# Repository instructions (${REPOSITORY_INSTRUCTIONS_FILE})`,
    `This session does not load the repository's ${REPOSITORY_INSTRUCTIONS_FILE} on its own, so Orkestrator includes it here. Follow it as project instructions. Contents of ${path}:`,
    content.trimEnd(),
    ...(truncated
      ? [
          `[${REPOSITORY_INSTRUCTIONS_FILE} is longer than this session can hold, so it is cut here. Read the rest from ${path} before relying on anything it may say.]`,
        ]
      : []),
  ].join("\n\n");
}
