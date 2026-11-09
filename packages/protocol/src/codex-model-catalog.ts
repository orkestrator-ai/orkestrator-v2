/**
 * Codex's shipped model catalogue, used only until a live catalogue arrives
 * (the bridge's app-server `model/list`, or the backend's cached copy of it).
 *
 * The Codex bridge, the backend's stored default and the renderer's launch and
 * settings surfaces all project this one list, so a model bump is one edit.
 *
 * These are the first rows of the pinned Codex CLI's own catalogue (0.167.0:
 * `gpt-6.1-sol`, then `gpt-6-luna`), which a ChatGPT login also served on
 * 2026-11-08. The previous `gpt-5.4` rows were refused by ChatGPT logins
 * ("not supported when using Codex with a ChatGPT account"). Efforts stop at
 * `xhigh`, the ladder every surface here labels; the live catalogue replaces
 * this list as soon as it arrives, with its full ladder.
 */
export type CodexFallbackReasoningEffort = "low" | "medium" | "high" | "xhigh";

export interface CodexFallbackModel {
  id: string;
  name: string;
  description: string;
  reasoningEfforts: readonly CodexFallbackReasoningEffort[];
  defaultReasoningEffort: CodexFallbackReasoningEffort;
}

export const CODEX_FALLBACK_MODEL_CATALOG: readonly CodexFallbackModel[] = [
  {
    id: "gpt-6.1-sol",
    name: "GPT-6.1-Sol",
    description: "Latest workhorse model for coding and everyday work.",
    reasoningEfforts: ["low", "medium", "high", "xhigh"],
    defaultReasoningEffort: "high",
  },
  {
    id: "gpt-6-luna",
    name: "GPT-6-Luna",
    description: "Fast and affordable model for easier tasks.",
    reasoningEfforts: ["low", "medium", "high", "xhigh"],
    defaultReasoningEffort: "high",
  },
];

/** The model a new install stores as its Codex default. */
export const DEFAULT_CODEX_MODEL_ID = "gpt-6.1-sol";

/** The reasoning effort a new install stores as its Codex default. */
export const DEFAULT_CODEX_REASONING_EFFORT: CodexFallbackReasoningEffort = "high";
