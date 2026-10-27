// Codex model catalogue shapes and the bundled fallback catalogue.
//
// Codex Native is driven by the backend; the renderer only keeps the model
// catalogue for launchers and settings, hydrated from the backend cache.

export type CodexReasoningEffort =
  "minimal" | "low" | "medium" | "high" | "xhigh" | "max" | "ultra";

export interface CodexReasoningOption {
  effort: CodexReasoningEffort;
  label: string;
  description?: string;
}

export interface CodexModel {
  id: string;
  name: string;
  description?: string;
  reasoningEfforts?: CodexReasoningEffort[];
  reasoningOptions?: CodexReasoningOption[];
  defaultReasoningEffort?: CodexReasoningEffort;
}

export const CODEX_MODELS: CodexModel[] = [
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
