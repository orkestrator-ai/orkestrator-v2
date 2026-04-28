import { create } from "zustand";
import type { InitialPromptImageAttachment } from "@/lib/initial-prompt-attachments";

export type AgentType = "claude" | "opencode" | "codex";

export interface ClaudeOptions {
  launchAgent: boolean;
  agentType: AgentType;
  initialPrompt: string;
  initialPromptAttachments?: InitialPromptImageAttachment[];
}

export interface PendingNativeAgentLaunch {
  containerId: string | null;
  environmentId: string;
  initialPrompt?: string;
  targetPaneId: string;
  agentType: AgentType;
}

interface ClaudeOptionsState {
  // Map of environmentId to Claude options
  options: Record<string, ClaudeOptions>;
  pendingNativeLaunches: Record<string, PendingNativeAgentLaunch>;

  // Actions
  setOptions: (environmentId: string, options: ClaudeOptions) => void;
  getOptions: (environmentId: string) => ClaudeOptions | undefined;
  clearOptions: (environmentId: string) => void;
  setPendingNativeLaunch: (environmentId: string, launch: PendingNativeAgentLaunch) => void;
  getPendingNativeLaunch: (environmentId: string) => PendingNativeAgentLaunch | undefined;
  clearPendingNativeLaunch: (environmentId: string) => void;
}

export const useClaudeOptionsStore = create<ClaudeOptionsState>()((set, get) => ({
  options: {},
  pendingNativeLaunches: {},

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

  setPendingNativeLaunch: (environmentId, launch) =>
    set((state) => ({
      pendingNativeLaunches: {
        ...state.pendingNativeLaunches,
        [environmentId]: launch,
      },
    })),

  getPendingNativeLaunch: (environmentId) =>
    get().pendingNativeLaunches[environmentId],

  clearPendingNativeLaunch: (environmentId) =>
    set((state) => {
      const { [environmentId]: _, ...rest } = state.pendingNativeLaunches;
      return { pendingNativeLaunches: rest };
    }),
}));
