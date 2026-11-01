// Codex model catalogue shapes and the bundled fallback catalogue.
//
// Codex Native is driven by the backend; the renderer only keeps the model
// catalogue for launchers and settings, hydrated from the backend cache.

import { CODEX_FALLBACK_MODEL_CATALOG } from "@orkestrator/protocol/codex-model-catalog";

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

/** Projection of the shared fallback catalogue (`@orkestrator/protocol/codex-model-catalog`). */
export const CODEX_MODELS: CodexModel[] = CODEX_FALLBACK_MODEL_CATALOG.map((model) => ({
  ...model,
  reasoningEfforts: [...model.reasoningEfforts],
}));
