/**
 * One node's settings, per node scope (plan item 3005, report §9).
 *
 * `config` is always the effective view the scope's node shows: its own
 * settings with its settings parent's inherited preferences laid over
 * (`effectiveConfig`). On the command node it is simply the node's config.
 * Under a parent scope (an in-tree leaf) the store keeps both layers and
 * re-lays them whenever the parent's config changes, so readers of `config`
 * never see a leaf's stale copy of an inherited preference.
 */
import { INHERITED_GLOBAL_SETTING_KEYS } from "@orkestrator/protocol/controller-settings";
import { createDefaultAppConfig } from "@orkestrator/protocol/app-config-defaults";
import { deepEqualJson } from "@/lib/chat/message-identity";
import type { NodeScope } from "@/lib/node-scope/node-scope";
import { defineScopedStore, type ScopedStoreDef } from "@/lib/node-scope/scoped-store";
import { scopedStoreHook } from "@/lib/node-scope/scoped-store";
import {
  configTargetsForScopes,
  layerConfig,
  runConfigCommandLayers,
  settingsParent,
} from "@/lib/portal/command-node-config";
import type { AppConfig, GlobalConfig, RepositoryConfig } from "@/types";

// The same builder the backend persists on first run, so what renders before
// the backend's config arrives is exactly what a new install would load.
const DEFAULT_CONFIG: AppConfig = createDefaultAppConfig();

const INHERITED_KEYS: ReadonlySet<string> = new Set(INHERITED_GLOBAL_SETTING_KEYS);

/** The two configs a layered scope's `config` is built from. */
export interface ConfigLayers {
  /** The scope's node's own stored config. */
  readonly node: AppConfig;
  /** The settings parent's (command node's) config. */
  readonly inherited: AppConfig;
}

export interface ConfigState {
  // State
  /** The effective config: `layers` laid together, or the node's own config when unlayered. */
  config: AppConfig;
  /**
   * Set while `config` is layered here from a parent's config. `null`:
   * `config` is the node's own config, or an effective config already
   * layered by the command that read it (`runConfigCommand`).
   */
  layers: ConfigLayers | null;
  /** Whether the backend's config has arrived; `config` holds defaults until then. */
  hasLoaded: boolean;
  isLoading: boolean;
  error: string | null;

  // Actions
  /** Installs the node's config (or an effective one read through the layering). */
  setConfig: (config: AppConfig) => void;
  /** Installs the node's own config and the parent's it inherits from (`null`: none). */
  setLayers: (node: AppConfig, inherited: AppConfig | null) => void;
  /** Replaces only the parent's layer, keeping the node's own config. */
  setInheritedConfig: (inherited: AppConfig | null) => void;
  updateGlobalConfig: (updates: Partial<GlobalConfig>) => void;
  setRepositoryConfig: (repoId: string, config: RepositoryConfig) => void;
  removeRepositoryConfig: (repoId: string) => void;
  setLoading: (isLoading: boolean) => void;
  setError: (error: string | null) => void;

  // Selectors
  getRepositoryConfig: (repoId: string) => RepositoryConfig | undefined;
}

function withGlobalUpdates(config: AppConfig, updates: Partial<GlobalConfig>): AppConfig {
  const global = { ...config.global, ...updates };
  if ("reviewInstruction" in updates && updates.reviewInstruction === undefined) {
    delete global.reviewInstruction;
  }
  return { ...config, global };
}

function inheritedUpdates(updates: Partial<GlobalConfig>): Partial<GlobalConfig> | null {
  const picked = Object.fromEntries(
    Object.entries(updates).filter(([key]) => INHERITED_KEYS.has(key)),
  ) as Partial<GlobalConfig>;
  return Object.keys(picked).length > 0 ? picked : null;
}

function withRepositories(config: AppConfig, repositories: AppConfig["repositories"]): AppConfig {
  return { ...config, repositories };
}

/**
 * The state for `layers`, keeping the published `config` object when the
 * effective view did not change (a reordered or re-read copy must not
 * rerender every subscriber).
 */
function layeredState(
  state: ConfigState,
  layers: ConfigLayers | null,
  node: AppConfig,
): Partial<ConfigState> {
  const next = layers ? layerConfig(layers.inherited, layers.node) : node;
  return {
    layers,
    config: deepEqualJson(state.config, next) ? state.config : next,
  };
}

export const configStore: ScopedStoreDef<ConfigState> = defineScopedStore<ConfigState>(
  "config",
  (scope) => (set, get) => {
    // An in-tree leaf follows its parent scope's config.
    const parent = settingsParent(scope)?.scope ?? null;
    let inherited: AppConfig | null = null;
    if (parent) {
      const parentStore = parent.store(configStore);
      inherited = parentStore.getState().config;
      const stop = parentStore.subscribe((next, previous) => {
        if (next.config !== previous.config) get().setInheritedConfig(next.config);
      });
      scope.onDispose("config.inherited", stop);
    }

    return {
      // Initial state
      config: inherited ? layerConfig(inherited, DEFAULT_CONFIG) : DEFAULT_CONFIG,
      layers: inherited ? { node: DEFAULT_CONFIG, inherited } : null,
      hasLoaded: false,
      isLoading: false,
      error: null,

      // Actions
      // Structural, not serialized: JSON.stringify is key-order sensitive (a
      // reordered but identical config would republish and rerender every
      // subscriber) and erases undefined-valued fields, which this store treats as
      // distinct from absent ones (see updateGlobalConfig's reviewInstruction).
      setConfig: (config) =>
        set((state) => {
          if (state.layers) {
            return {
              ...layeredState(state, { node: config, inherited: state.layers.inherited }, config),
              hasLoaded: true,
            };
          }
          return deepEqualJson(state.config, config)
            ? state.hasLoaded
              ? state
              : { hasLoaded: true }
            : { config, hasLoaded: true };
        }),

      setLayers: (node, inheritedConfig) =>
        set((state) => ({
          ...layeredState(
            state,
            inheritedConfig ? { node, inherited: inheritedConfig } : null,
            node,
          ),
          hasLoaded: true,
        })),

      setInheritedConfig: (inheritedConfig) =>
        set((state) => {
          const node = state.layers?.node ?? state.config;
          return layeredState(
            state,
            inheritedConfig ? { node, inherited: inheritedConfig } : null,
            node,
          );
        }),

      updateGlobalConfig: (updates) =>
        set((state) => {
          if (!state.layers) return { config: withGlobalUpdates(state.config, updates) };
          // Optimistic: an inherited preference shows at once, before the
          // command node's save comes back.
          const parentUpdates = inheritedUpdates(updates);
          return layeredState(
            state,
            {
              node: withGlobalUpdates(state.layers.node, updates),
              inherited: parentUpdates
                ? withGlobalUpdates(state.layers.inherited, parentUpdates)
                : state.layers.inherited,
            },
            state.layers.node,
          );
        }),

      setRepositoryConfig: (repoId, repoConfig) =>
        set((state) => {
          const node = state.layers?.node ?? state.config;
          const next = withRepositories(node, { ...node.repositories, [repoId]: repoConfig });
          if (!state.layers) return { config: next };
          return layeredState(state, { ...state.layers, node: next }, next);
        }),

      removeRepositoryConfig: (repoId) =>
        set((state) => {
          const node = state.layers?.node ?? state.config;
          const { [repoId]: _, ...rest } = node.repositories;
          const next = withRepositories(node, rest);
          if (!state.layers) return { config: next };
          return layeredState(state, { ...state.layers, node: next }, next);
        }),

      setLoading: (isLoading) => set({ isLoading }),

      setError: (error) => set({ error }),

      // Selectors
      getRepositoryConfig: (repoId) => get().config.repositories[repoId],
    };
  },
);

/** Reads the nearest node scope's config; other code uses `scope.store(configStore)`. */
export const useConfigStore = scopedStoreHook(configStore);

/**
 * `layer(commandScope.config, scope.config)` (report §9): `scope`'s own
 * settings under `commandScope`'s inherited preferences. `commandScope`
 * defaults to `scope`'s settings parent; with none, or the same scope, it is
 * `scope`'s own config.
 */
export function effectiveConfig(
  scope: NodeScope,
  commandScope: NodeScope | null = settingsParent(scope)?.scope ?? null,
): AppConfig {
  const state = scope.store(configStore).getState();
  if (!commandScope || commandScope === scope) return state.config;
  return layerConfig(
    commandScope.store(configStore).getState().config,
    state.layers?.node ?? state.config,
  );
}

/**
 * A config read or save for `scope` under `commandScope`, both named: the
 * inherited part goes to `commandScope`'s node and the machine part to
 * `scope`'s (`runConfigCommandLayers`). Each scope's store then holds what
 * its node answered. Resolves with the effective config.
 */
export async function runScopedConfigCommand(
  scopes: { readonly scope: NodeScope; readonly commandScope: NodeScope | null },
  command: string,
  args?: Record<string, unknown>,
): Promise<AppConfig> {
  const { scope, commandScope } = scopes;
  const result = await runConfigCommandLayers(
    configTargetsForScopes(scope, commandScope),
    command,
    args,
  );
  if (!result.node || !commandScope || commandScope === scope) {
    scope.store(configStore).getState().setConfig(result.config);
    return result.config;
  }
  commandScope.store(configStore).getState().setConfig(result.commandNode);
  scope.store(configStore).getState().setLayers(result.node, result.commandNode);
  return result.config;
}
