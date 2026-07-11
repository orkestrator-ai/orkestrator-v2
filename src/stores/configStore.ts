import { create } from "zustand";
import type { AppConfig, EnvironmentType, GlobalConfig, RepositoryConfig } from "@/types";
import { DEFAULT_TERMINAL_SCROLLBACK, TERMINAL_BACKGROUND_COLOR } from "@/constants/terminal";

const DEFAULT_CONFIG: AppConfig = {
  version: "1.0",
  global: {
    containerResources: {
      cpuCores: 2,
      memoryGb: 4,
    },
    envFilePatterns: [".env.local", ".env"],
    allowedDomains: [
      // Package registries and runtimes
      "registry.npmjs.org",
      "npmjs.org",
      "nodejs.org",
      "bun.sh",

      // AI providers
      "opencode.ai",
      "api.anthropic.com",
      "anthropic.com",
      "openai.com",
      "googleapis.com",
      "api.openrouter.ai",
      "openrouter.ai",
      "huggingface.co",
      "groq.com",
      "deepseek.com",
      "moonshot.ai",
      "ollama.com",
      "api.ollama.com",
      "together.ai",
      "x.ai",
      "bedrock.amazonaws.com",

      // Cloud providers
      "vercel.com",
      "cloudflare.com",
      "microsoft.com",
      "azure.com",
      "sap.com",
      "account.hana.ondemand.com",

      // Analytics and monitoring
      "sentry.io",
      "statsig.anthropic.com",
      "statsig.com",
      "helicone.ai",

      // VS Code and extensions
      "marketplace.visualstudio.com",
      "vscode.blob.core.windows.net",
      "update.code.visualstudio.com",

      // Other services
      "github.com",
      "api.github.com",
      "mcp.context7.com",
      "cdn.jsdelivr.net",
    ],
    defaultAgent: "claude",
    opencodeModel: "opencode/claude-sonnet-5",
    claudeModel: "claude-sonnet-5",
    codexModel: "gpt-5.4",
    codexReasoningEffort: "medium",
    opencodeMode: "terminal",
    claudeMode: "terminal",
    claudeNativeBackend: "sdk",
    claudeNativeFastModeDefault: false,
    codexMode: "native",
    codexNativeFastModeDefault: false,
    terminalAppearance: {
      fontFamily: "FiraCode Nerd Font",
      fontSize: 14,
      backgroundColor: TERMINAL_BACKGROUND_COLOR,
    },
    terminalScrollback: DEFAULT_TERMINAL_SCROLLBACK,
    experimentalCodexRawEventLogging: true,
    webClientEnabled: true,
  },
  repositories: {},
};

interface ConfigState {
  // State
  config: AppConfig;
  isLoading: boolean;
  error: string | null;

  // Actions
  setConfig: (config: AppConfig) => void;
  updateGlobalConfig: (updates: Partial<GlobalConfig>) => void;
  setRepositoryConfig: (repoId: string, config: RepositoryConfig) => void;
  setRepositoryLastEnvironmentType: (repoId: string, environmentType: EnvironmentType) => void;
  removeRepositoryConfig: (repoId: string) => void;
  setLoading: (isLoading: boolean) => void;
  setError: (error: string | null) => void;

  // Selectors
  getRepositoryConfig: (repoId: string) => RepositoryConfig | undefined;
}

export const useConfigStore = create<ConfigState>()((set, get) => ({
  // Initial state
  config: DEFAULT_CONFIG,
  isLoading: false,
  error: null,

  // Actions
  setConfig: (config) => set({ config }),

  updateGlobalConfig: (updates) =>
    set((state) => ({
      config: {
        ...state.config,
        global: { ...state.config.global, ...updates },
      },
    })),

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

  setRepositoryLastEnvironmentType: (repoId, environmentType) =>
    set((state) => {
      const existing = state.config.repositories[repoId] ?? {
        defaultBranch: "main",
        prBaseBranch: "main",
      };

      return {
        config: {
          ...state.config,
          repositories: {
            ...state.config.repositories,
            [repoId]: {
              ...existing,
              lastEnvironmentType: environmentType,
            },
          },
        },
      };
    }),

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
