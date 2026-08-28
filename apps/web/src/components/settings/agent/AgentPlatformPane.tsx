/**
 * One platform's settings, rendered identically at all three tiers.
 *
 * The only difference between App, Repository and Environment is whether an
 * "Inherit" option is offered — the widest tier has nothing above it, so it
 * shows concrete choices only. Everything else (which controls exist, what they
 * are called, what order they appear in) is shared, which is the point: the
 * three dialogs used to expose different subsets of these settings under
 * different names.
 *
 * Speed is the same Fast/Normal axis the compose-bar picker uses. Platforms
 * that own a toggle (Cursor, Claude, Codex, Grok) persist it here so new
 * sessions start on that choice; OpenCode still encodes speed in the model id.
 */
import { useMemo } from "react";
import { Bot, Loader2, RefreshCw, Terminal } from "lucide-react";
import { AgentModelPicker } from "@/components/chat/AgentModelPicker";
import { Button } from "@/components/ui/button";
import { useAgentModelFavorites } from "@/hooks/useAgentModelFavorites";
import {
  effortLabel,
  modelsForAgent,
  platformOwnsSpeed,
  toPickerModel,
  type AgentModelCatalog,
} from "@/lib/agent-launch";
import { inheritedFrom, withPlatformField, TIER_LABELS } from "@/lib/agent-settings";
import { AGENT_PLATFORM_LABELS, type AgentPlatform } from "@orkestrator/protocol/agent-platforms";
import {
  resolveAgentPlatformSettings,
  SHIPPED_PLATFORM_MODES,
  type AgentLaunchMode,
  type AgentPlatformSettings,
  type AgentSettingsTier,
  type AgentSettingsTiers,
  type ClaudeNativeBackend,
} from "@orkestrator/protocol/agent-settings";
import type { AgentModel, AgentReasoningOption } from "@orkestrator/protocol/native-agent";
import { FALLBACK_CLAUDE_MODELS } from "@/lib/claude-fallback-models";
import { INHERIT, OptionCards } from "./InheritedValue";

export interface AgentPlatformPaneProps {
  platform: AgentPlatform;
  /** The tier being edited. */
  tier: AgentSettingsTier | undefined;
  onChange: (tier: AgentSettingsTier) => void;
  /**
   * All three tiers as currently stored, used to show what an unset control
   * resolves to. Includes the tier being edited.
   */
  tiers: AgentSettingsTiers;
  /** False at the application tier, which has nothing above it. */
  canInherit: boolean;
  catalog: AgentModelCatalog;
  disabled?: boolean;
  onRefreshModels?: () => void;
  refreshingModels?: boolean;
  refreshModelsDisabled?: boolean;
  modelCatalogScopeDescription?: string;
  /** Tier-specific extras, e.g. API keys and provider lists at the app tier. */
  children?: React.ReactNode;
}

const MODE_OPTIONS: Array<{
  value: AgentLaunchMode;
  label: string;
  hint: string;
  icon: React.ReactNode;
}> = [
  {
    value: "terminal",
    label: "Terminal",
    hint: "Runs the CLI in a terminal tab",
    icon: <Terminal className="h-4 w-4" />,
  },
  {
    value: "native",
    label: "Native",
    hint: "Opens a chat interface instead",
    icon: <Bot className="h-4 w-4" />,
  },
];

const CLAUDE_BACKEND_OPTIONS: Array<{
  value: ClaudeNativeBackend;
  label: string;
  hint: string;
}> = [
  { value: "sdk", label: "Agent SDK", hint: "Uses the Claude Agent SDK via bridge server" },
  { value: "tmux", label: "Tmux", hint: "Drives the Claude CLI under tmux (Max plan friendly)" },
];

export function AgentPlatformPane({
  platform,
  tier,
  onChange,
  tiers,
  canInherit,
  catalog,
  disabled,
  onRefreshModels,
  refreshingModels = false,
  refreshModelsDisabled = false,
  modelCatalogScopeDescription,
  children,
}: AgentPlatformPaneProps) {
  const favorites = useAgentModelFavorites();
  const label = AGENT_PLATFORM_LABELS[platform];
  const stored = tier?.platforms?.[platform];

  // What each control would show if left on Inherit. Resolved from the tiers
  // *above* this one, which is what the user is choosing between.
  const parentTiers = useMemo<AgentSettingsTiers>(() => {
    const withoutSelf = { ...tiers };
    if (tiers.environment === tier) delete withoutSelf.environment;
    else if (tiers.repository === tier) delete withoutSelf.repository;
    return withoutSelf;
  }, [tiers, tier]);
  const inherited = resolveAgentPlatformSettings(parentTiers, platform);

  const catalogModels = modelsForAgent(catalog, platform);
  // Claude is the only platform with a shipped catalogue, so it stays
  // selectable before any bridge has reported one.
  const models =
    platform === "claude" && catalogModels.length === 0
      ? FALLBACK_CLAUDE_MODELS.map((model) => ({
          id: model.id,
          name: model.name,
          description: model.description,
          reasoningEfforts: model.supportedEffortLevels ?? [],
          resolvedModel: model.resolvedModel,
          ...(model.supportsFastMode !== false ? { supportsSpeed: true as const } : {}),
        }))
      : catalogModels;
  const pickerModels = useMemo<AgentModel[]>(
    () =>
      models
        // A synthesised OpenCode `default` is a UI placeholder no server knows,
        // so offering it here would persist a selection that disappears.
        .filter((option) => !(platform === "opencode" && option.id === "default"))
        .map((option) => toPickerModel(platform, option)),
    [models, platform],
  );
  const selectedModel = stored?.model
    ? models.find((model) => model.id === stored.model || model.resolvedModel === stored.model)
    : undefined;
  const modelMissingFromCatalog = Boolean(stored?.model && !selectedModel);
  const effectiveModel = stored?.model ?? inherited.model;
  const reasoningModel = effectiveModel
    ? models.find((model) => model.id === effectiveModel || model.resolvedModel === effectiveModel)
    : models[0];

  const reasoningOptions = useMemo<AgentReasoningOption[]>(() => {
    const efforts = reasoningModel?.reasoningEfforts ?? [];
    // A stored level the catalog no longer lists stays selectable, so opening
    // this pane cannot quietly rewrite a saved choice to "inherit".
    const current = stored?.reasoningEffort;
    const ids = current && !efforts.includes(current) ? [...efforts, current] : efforts;
    if (ids.length === 0) return [];
    return [
      { id: INHERIT, label: canInherit ? "Inherit" : "Provider default" },
      ...ids.map((effort) => ({ id: effort, label: effortLabel(effort) })),
    ];
  }, [reasoningModel, stored?.reasoningEffort, canInherit]);

  const set = <K extends keyof AgentPlatformSettings>(
    field: K,
    value: AgentPlatformSettings[K] | undefined,
  ) => onChange(withPlatformField(tier, platform, field, value));
  const setModel = (modelId: string) => {
    let next = withPlatformField(tier, platform, "model", modelId);
    const nextModel = models.find(
      (model) => model.id === modelId || model.resolvedModel === modelId,
    );
    if (nextModel?.supportsSpeed !== true) {
      next = withPlatformField(next, platform, "fastMode", undefined);
    }
    onChange(next);
  };

  const modeSource = inheritedFrom(parentTiers, platform, "mode");
  const modelSource = inheritedFrom(parentTiers, platform, "model");
  const speedCapable = platformOwnsSpeed(platform);
  const selectedSupportsSpeed = reasoningModel?.supportsSpeed === true;

  return (
    <div className="max-w-2xl space-y-8">
      {platform === "cursor" ? (
        <div className="space-y-1">
          <h3 className="text-sm font-medium text-foreground">Mode</h3>
          <p className="text-xs text-muted-foreground">
            Cursor always runs in Native mode through its TypeScript SDK.
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          <div>
            <h3 className="text-sm font-medium text-foreground">Mode</h3>
            <p className="mt-1 text-xs text-muted-foreground">
              How {label} runs in environments. Native opens a chat interface instead of a terminal.
            </p>
          </div>
          <OptionCards
            ariaLabel={`${label} mode`}
            value={stored?.mode ?? INHERIT}
            onChange={(value) => set("mode", value === INHERIT ? undefined : value)}
            disabled={disabled}
            inherit={
              canInherit
                ? {
                    label: `Inherit — ${inherited.mode === "native" ? "Native" : "Terminal"} (from ${
                      TIER_LABELS[modeSource]
                    })`,
                  }
                : undefined
            }
            options={MODE_OPTIONS}
          />
          {!canInherit && !stored?.mode && (
            <p className="text-xs text-muted-foreground">
              Unset, so {label} uses its shipped default of{" "}
              {SHIPPED_PLATFORM_MODES[platform] === "native" ? "Native" : "Terminal"}.
            </p>
          )}
        </div>
      )}

      {platform === "claude" && (
        <div className="space-y-3">
          <div>
            <h3 className="text-sm font-medium text-foreground">Native backend</h3>
            <p className="mt-1 text-xs text-muted-foreground">
              The implementation behind Native mode. Only applies when the resolved mode is Native.
            </p>
          </div>
          <OptionCards
            ariaLabel="Claude native backend"
            value={stored?.claudeNativeBackend ?? INHERIT}
            onChange={(value) => set("claudeNativeBackend", value === INHERIT ? undefined : value)}
            disabled={disabled}
            columns="sm:grid-cols-2"
            inherit={
              canInherit
                ? {
                    label: `Inherit — ${
                      inherited.claudeNativeBackend === "tmux" ? "Tmux" : "Agent SDK"
                    } (from ${TIER_LABELS[inheritedFrom(parentTiers, "claude", "claudeNativeBackend")]})`,
                  }
                : undefined
            }
            options={CLAUDE_BACKEND_OPTIONS}
          />
          <p className="text-xs text-muted-foreground/60">
            With Tmux, Orkestrator merges a <code className="px-1 font-mono">hooks</code> block into
            the environment&apos;s{" "}
            <code className="px-1 font-mono">.claude/settings.local.json</code> while a session
            runs, and restores the original when it stops.
          </p>
        </div>
      )}

      <div className="space-y-3">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h3 className="text-sm font-medium text-foreground">Default model</h3>
            <p className="mt-1 text-xs text-muted-foreground">
              The model new {label} sessions start on. Changing it in a session&apos;s own picker
              does not change this.
            </p>
            {modelCatalogScopeDescription && (
              <p className="mt-1 text-xs text-muted-foreground/80">
                {modelCatalogScopeDescription}
              </p>
            )}
          </div>
          {onRefreshModels && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={onRefreshModels}
              disabled={disabled || refreshingModels || refreshModelsDisabled}
              title={
                refreshModelsDisabled ? "Add or select a repository to refresh models" : undefined
              }
              aria-label={`Refresh ${label} models`}
              className="shrink-0"
            >
              {refreshingModels ? (
                <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
              ) : (
                <RefreshCw className="mr-1.5 h-3.5 w-3.5" />
              )}
              Refresh models
            </Button>
          )}
        </div>
        {pickerModels.length > 0 ? (
          <AgentModelPicker
            id={`agent-model-${platform}`}
            ariaLabel={`${label} default model`}
            title={`Choose a default ${label} model`}
            disabled={disabled}
            models={pickerModels}
            enabledPlatforms={[platform]}
            selectedPlatform={platform}
            favorites={favorites.favorites}
            onToggleFavorite={favorites.toggleFavorite}
            onReorderFavorites={favorites.reorderFavorites}
            selectedModelId={selectedModel?.id}
            selectedModelLabel={
              stored?.model
                ? (selectedModel?.name ?? stored.model)
                : canInherit
                  ? `Inherit${inherited.model ? ` — ${inherited.model}` : ""} (from ${TIER_LABELS[modelSource]})`
                  : `${label} default`
            }
            onModelChange={setModel}
            onModelSelect={(nextModel) => setModel(nextModel.id)}
            reasoningOptions={reasoningOptions}
            selectedReasoningId={stored?.reasoningEffort ?? INHERIT}
            selectedReasoningLabel={
              reasoningOptions.find((option) => option.id === (stored?.reasoningEffort ?? INHERIT))
                ?.label
            }
            onReasoningChange={(nextId) =>
              set("reasoningEffort", nextId === INHERIT ? undefined : nextId)
            }
            speedCapable={speedCapable}
            fastModeAvailable={speedCapable && selectedSupportsSpeed}
            fastModeEnabled={
              speedCapable ? (stored?.fastMode ?? inherited.fastMode ?? null) : false
            }
            speedInherit={
              speedCapable
                ? {
                    label: canInherit ? "Inherit" : "Provider default",
                    selected: stored?.fastMode === undefined,
                  }
                : undefined
            }
            onFastModeChange={speedCapable ? (enabled) => set("fastMode", enabled) : undefined}
            onFastModeInherit={speedCapable ? () => set("fastMode", undefined) : undefined}
            className="min-h-11 w-full max-w-none justify-start border border-zinc-700/80 bg-zinc-900 py-2.5 text-sm text-zinc-100 md:max-w-none md:flex-1"
          />
        ) : (
          <p className="text-xs italic text-muted-foreground">
            {onRefreshModels
              ? `Refresh models to load available ${label} models without starting an environment.`
              : `Start an environment to load available ${label} models.`}
          </p>
        )}
        {stored?.model && (
          <button
            type="button"
            className="text-xs text-muted-foreground underline-offset-2 hover:underline"
            onClick={() => {
              // Clearing the model clears the level with it: a reasoning level
              // belongs to a model, so keeping it would apply this model's
              // level to whichever model the inherited tier names.
              onChange(
                withPlatformField(
                  withPlatformField(tier, platform, "model", undefined),
                  platform,
                  "reasoningEffort",
                  undefined,
                ),
              );
            }}
            disabled={disabled}
          >
            {canInherit ? "Clear and inherit" : "Clear"}
          </button>
        )}
        {modelMissingFromCatalog && (
          <p className="text-xs text-amber-300">
            {stored?.model} is not in the current catalog. It is still saved and will be sent as-is;
            pick another model to replace it.
          </p>
        )}
      </div>

      {children}
    </div>
  );
}
