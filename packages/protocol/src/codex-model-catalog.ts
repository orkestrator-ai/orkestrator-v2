/**
 * Codex's shipped model catalogue, used only until a live catalogue arrives
 * (the bridge's app-server `model/list`, or the backend's cached copy of it).
 *
 * The Codex bridge, the backend's stored default and the renderer's launch and
 * settings surfaces all project this one list, so a model bump is one edit.
 *
 * The ids are the ones Orkestrator has always shipped. They are not the pinned
 * Codex CLI's own bundled catalogue (0.166.0 lists the gpt-6 family first and
 * no longer carries gpt-5.4); the runtime already replaces an inherited default
 * the login's live catalogue does not offer (`session-held-model.ts`). Moving
 * the default needs live evidence of what API-key and ChatGPT logins serve.
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
    id: "gpt-5.4",
    name: "gpt-5.4",
    description: "Latest frontier agentic coding model.",
    reasoningEfforts: ["low", "medium", "high", "xhigh"],
    defaultReasoningEffort: "high",
  },
  {
    id: "gpt-5.4-mini",
    name: "GPT-5.4-Mini",
    description: "Smaller frontier agentic coding model.",
    reasoningEfforts: ["low", "medium", "high", "xhigh"],
    defaultReasoningEffort: "high",
  },
];

/** The model a new install stores as its Codex default. */
export const DEFAULT_CODEX_MODEL_ID = "gpt-5.4";

/** The reasoning effort a new install stores as its Codex default. */
export const DEFAULT_CODEX_REASONING_EFFORT: CodexFallbackReasoningEffort = "high";
