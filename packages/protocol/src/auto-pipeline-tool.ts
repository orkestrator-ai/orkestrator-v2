/**
 * The Orkestrator tool an interactive agent tab calls to hand its work to
 * Auto-pipeline. Dependency-free on purpose: every bridge lists it among the
 * tools a person is never asked about, and the bridges must not pull the draft
 * schema (`auto-pipeline.ts`) into their bundles for a name.
 */

/** The same name on every provider. */
export const AUTO_PIPELINE_TOOL_NAME = "convert_to_pipeline";

/**
 * Never prompts for approval. The tool only records a draft for the user to
 * review: it creates no ticket and starts no pipeline, and it writes nothing
 * but Orkestrator's own draft store, never the workspace.
 */
export const AGENT_AUTO_PIPELINE_TOOL_NAMES = Object.freeze([AUTO_PIPELINE_TOOL_NAME] as const);
