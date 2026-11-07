import type { InitialPromptImageAttachment } from "@/lib/initial-prompt-attachments";
import { defineScopedStore } from "@/lib/node-scope/scoped-store";
import { scopedStoreHook } from "@/lib/node-scope/scoped-store";

export type AgentType = "claude" | "opencode" | "codex" | "cursor" | "grok" | "pi";

export interface ClaudeOptions {
  launchAgent: boolean;
  agentType: AgentType;
  initialPrompt: string;
  initialPromptAttachments?: InitialPromptImageAttachment[];
  model?: string;
  reasoningEffort?: string;
  fastMode?: boolean;
}

export interface ClaudeOptionsState {
  // Map of environmentId to Claude options
  options: Record<string, ClaudeOptions>;

  // Actions
  setOptions: (environmentId: string, options: ClaudeOptions) => void;
  getOptions: (environmentId: string) => ClaudeOptions | undefined;
  clearOptions: (environmentId: string) => void;
}

/**
 * One-shot launch options per environment, held per node: environment ids
 * belong to the node that owns the environment (plan item 3001, the worked
 * example of a scoped store; recipe in docs/development/node-scopes.md).
 */
export const claudeOptionsStore = defineScopedStore<ClaudeOptionsState>(
  "claude-options",
  () => (set, get) => ({
    options: {},

    setOptions: (environmentId, options) =>
      set((state) => ({
        options: { ...state.options, [environmentId]: options },
      })),

    getOptions: (environmentId) => get().options[environmentId],

    clearOptions: (environmentId) =>
      set((state) => {
        const { [environmentId]: _, ...rest } = state.options;
        return { options: rest };
      }),
  }),
);

/**
 * Reads the nearest node scope's launch options; other code uses
 * `scope.store(claudeOptionsStore)`.
 */
export const useClaudeOptionsStore = scopedStoreHook(claudeOptionsStore);
