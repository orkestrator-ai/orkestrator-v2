import { create } from "zustand";
import { CODEX_MODELS, type CodexModel } from "@/lib/codex-models";

/**
 * Codex model catalogue for launchers and settings.
 *
 * Codex Native sessions are owned by the backend and rendered from the
 * native-agent projection, so this store holds no session state. The catalogue
 * starts at the bundled fallback and is replaced by the backend cache at
 * startup.
 */
interface CodexState {
  models: CodexModel[];
  /** An empty catalogue falls back to the bundled models. */
  setModels: (models: CodexModel[]) => void;
}

export const useCodexStore = create<CodexState>()((set) => ({
  models: CODEX_MODELS,
  setModels: (models) => set({ models: models.length > 0 ? models : CODEX_MODELS }),
}));
