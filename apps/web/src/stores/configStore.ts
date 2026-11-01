import { create } from "zustand";
import { deepEqualJson } from "@/lib/chat/message-identity";
import type { AppConfig, GlobalConfig, RepositoryConfig } from "@/types";
import { createDefaultAppConfig } from "@orkestrator/protocol/app-config-defaults";

// The same builder the backend persists on first run, so what renders before
// the backend's config arrives is exactly what a new install would load.
const DEFAULT_CONFIG: AppConfig = createDefaultAppConfig();

interface ConfigState {
  // State
  config: AppConfig;
  /** Whether the backend's config has arrived; `config` holds defaults until then. */
  hasLoaded: boolean;
  isLoading: boolean;
  error: string | null;

  // Actions
  setConfig: (config: AppConfig) => void;
  updateGlobalConfig: (updates: Partial<GlobalConfig>) => void;
  setRepositoryConfig: (repoId: string, config: RepositoryConfig) => void;
  removeRepositoryConfig: (repoId: string) => void;
  setLoading: (isLoading: boolean) => void;
  setError: (error: string | null) => void;

  // Selectors
  getRepositoryConfig: (repoId: string) => RepositoryConfig | undefined;
}

export const useConfigStore = create<ConfigState>()((set, get) => ({
  // Initial state
  config: DEFAULT_CONFIG,
  hasLoaded: false,
  isLoading: false,
  error: null,

  // Actions
  // Structural, not serialized: JSON.stringify is key-order sensitive (a
  // reordered but identical config would republish and rerender every
  // subscriber) and erases undefined-valued fields, which this store treats as
  // distinct from absent ones (see updateGlobalConfig's reviewInstruction).
  setConfig: (config) =>
    set((state) =>
      deepEqualJson(state.config, config)
        ? state.hasLoaded
          ? state
          : { hasLoaded: true }
        : { config, hasLoaded: true },
    ),

  updateGlobalConfig: (updates) =>
    set((state) => {
      const global = { ...state.config.global, ...updates };
      if ("reviewInstruction" in updates && updates.reviewInstruction === undefined) {
        delete global.reviewInstruction;
      }
      return {
        config: {
          ...state.config,
          global,
        },
      };
    }),

  setRepositoryConfig: (repoId, repoConfig) =>
    set((state) => ({
      config: {
        ...state.config,
        repositories: {
          ...state.config.repositories,
          [repoId]: repoConfig,
        },
      },
    })),

  removeRepositoryConfig: (repoId) =>
    set((state) => {
      const { [repoId]: _, ...rest } = state.config.repositories;
      return {
        config: {
          ...state.config,
          repositories: rest,
        },
      };
    }),

  setLoading: (isLoading) => set({ isLoading }),

  setError: (error) => set({ error }),

  // Selectors
  getRepositoryConfig: (repoId) => get().config.repositories[repoId],
}));
