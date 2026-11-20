/**
 * Agent tool names of rich interactions, kept in a tiny module so bridges can
 * auto-approve them without bundling the interaction registry. They write
 * only to Orkestrator's own bounded interaction store and never touch the
 * workspace; a user's decision still arrives as an ordinary follow-up.
 */
export const RICH_INTERACTION_TOOL_NAMES = Object.freeze([
  "present_interaction",
  "update_interaction",
  "read_interaction_result",
  "list_interactions",
] as const);
export type RichInteractionToolName = (typeof RICH_INTERACTION_TOOL_NAMES)[number];
