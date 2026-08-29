/**
 * The Defaults page, rendered identically at all three tiers.
 *
 * Two things live here: which agent launches when nothing narrower names one,
 * and what each toolbar action uses on a plain click. Both are the same shape at
 * App, Repository and Environment level; the only difference is that the two
 * narrower tiers offer "Inherit" and start on it.
 *
 * The default *model* is not a separate control here. It is `defaultAgent`'s own
 * platform block, which is the same value that platform's tab edits — one value
 * reachable from two places rather than two values with a precedence rule.
 */
import { useMemo } from "react";
import {
  AlertTriangle,
  Eye,
  FilePlus2,
  FolderPlus,
  GitPullRequest,
  RotateCcw,
  Upload,
  Wrench,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { AgentModelPicker } from "@/components/chat/AgentModelPicker";
import { AgentPlatformIcon } from "@/components/icons/AgentIcons";
import { useAgentModelFavorites } from "@/hooks/useAgentModelFavorites";
import {
  effortLabel,
  modelsForAgent,
  platformOwnsSpeed,
  toPickerModel,
  type AgentModelCatalog,
} from "@/lib/agent-launch";
import { TIER_LABELS, withPlatformField, type AgentSettingsTierName } from "@/lib/agent-settings";
import { cn } from "@/lib/utils";
import {
  ACTION_DEFAULT_KEYS,
  type ActionDefaultKey,
  type ActionDefaults,
  type AgentActionDefault,
} from "@orkestrator/protocol/action-defaults";
import {
  AGENT_PLATFORM_LABELS,
  firstEnabledAgentPlatform,
  type AgentPlatform,
} from "@orkestrator/protocol/agent-platforms";
import {
  resolveActionDefaults,
  resolveAgentPlatformSettings,
  resolveDefaultAgent,
  type AgentSettingsTier,
  type AgentSettingsTiers,
} from "@orkestrator/protocol/agent-settings";
import type { AgentModel, AgentReasoningOption } from "@orkestrator/protocol/native-agent";
import { INHERIT } from "./InheritedValue";

const ACTION_DEFINITIONS: Record<
  ActionDefaultKey,
  { label: string; description: string; icon: React.ReactNode }
> = {
  newProject: {
    label: "New environments",
    description: "Preselected every time you create an environment here.",
    icon: <FolderPlus className="h-4 w-4" />,
  },
  createScript: {
    label: "Create run script",
    description: "Preselected when you configure a script from the Run Commands button.",
    icon: <FilePlus2 className="h-4 w-4" />,
  },
  review: {
    label: "Review",
    description: "Used by the Code Review button and as the first model in Multi Review.",
    icon: <Eye className="h-4 w-4" />,
  },
  review2: {
    label: "Review 2",
    description: "Used as the second review model in Multi Review.",
    icon: <Eye className="h-4 w-4" />,
  },
  fixReviewIssues: {
    label: "Fix review issues",
    description: "Used as the consolidation and fix model in Multi Review.",
    icon: <Wrench className="h-4 w-4" />,
  },
  pr: {
    label: "PR",
    description: "Used by the Create PR button.",
    icon: <GitPullRequest className="h-4 w-4" />,
  },
  resolve: {
    label: "Resolve",
    description: "Used by the Resolve button for merge conflicts.",
    icon: <AlertTriangle className="h-4 w-4" />,
  },
  push: {
    label: "Push",
    description: "Used by the Push Changes button.",
    icon: <Upload className="h-4 w-4" />,
  },
};

export interface AgentDefaultsPaneProps {
  tier: AgentSettingsTier | undefined;
  onChange: (tier: AgentSettingsTier) => void;
  tiers: AgentSettingsTiers;
  canInherit: boolean;
  enabledPlatforms: AgentPlatform[];
  catalog: AgentModelCatalog;
  disabled?: boolean;
  /** What this tier is called in prose, e.g. "this repository". */
  scopeLabel: string;
}

export function AgentDefaultsPane({
  tier,
  onChange,
  tiers,
  canInherit,
  enabledPlatforms,
  catalog,
  disabled,
  scopeLabel,
}: AgentDefaultsPaneProps) {
  const favorites = useAgentModelFavorites();

  const parentTiers = useMemo<AgentSettingsTiers>(() => {
    const withoutSelf = { ...tiers };
    if (tiers.environment === tier) delete withoutSelf.environment;
    else if (tiers.repository === tier) delete withoutSelf.repository;
    return withoutSelf;
  }, [tiers, tier]);

  const inheritedAgent = resolveDefaultAgent(parentTiers);
  const inheritedAgentSource: AgentSettingsTierName = parentTiers.environment?.defaultAgent
    ? "environment"
    : parentTiers.repository?.defaultAgent
      ? "repository"
      : parentTiers.global?.defaultAgent
        ? "global"
        : "default";

  // The model shown belongs to whichever agent is effective, so switching agent
  // reveals that agent's model rather than carrying the previous id across.
  // Constrained to the enabled set: a default naming a platform the user has
  // since turned off would point this pane at a platform with no catalogue.
  const effectiveAgent = firstEnabledAgentPlatform(
    enabledPlatforms,
    tier?.defaultAgent ?? inheritedAgent,
  );
  const storedForAgent = tier?.platforms?.[effectiveAgent];
  const resolvedForAgent = resolveAgentPlatformSettings(tiers, effectiveAgent);
  const models = modelsForAgent(catalog, effectiveAgent);
  const selectedModel = storedForAgent?.model
    ? models.find(
        (model) =>
          model.id === storedForAgent.model || model.resolvedModel === storedForAgent.model,
      )
    : undefined;
  const effectiveModel = storedForAgent?.model ?? resolvedForAgent.model;
  const reasoningModel = effectiveModel
    ? models.find((model) => model.id === effectiveModel || model.resolvedModel === effectiveModel)
    : models[0];

  const pickerModels = useMemo<AgentModel[]>(
    () =>
      enabledPlatforms.flatMap((platform) =>
        modelsForAgent(catalog, platform)
          .filter((option) => !(platform === "opencode" && option.id === "default"))
          .map((option) => toPickerModel(platform, option)),
      ),
    [catalog, enabledPlatforms],
  );

  const reasoningOptions = useMemo<AgentReasoningOption[]>(() => {
    const efforts = reasoningModel?.reasoningEfforts ?? [];
    const current = storedForAgent?.reasoningEffort;
    const ids = current && !efforts.includes(current) ? [...efforts, current] : efforts;
    if (ids.length === 0) return [];
    return [
      { id: INHERIT, label: canInherit ? "Inherit" : "Provider default" },
      ...ids.map((effort) => ({ id: effort, label: effortLabel(effort) })),
    ];
  }, [reasoningModel, storedForAgent?.reasoningEffort, canInherit]);

  const speedCapable = platformOwnsSpeed(effectiveAgent);
  const selectedSupportsSpeed = reasoningModel?.supportsSpeed === true;
  const inheritedSpeed = resolveAgentPlatformSettings(parentTiers, effectiveAgent).fastMode;

  const setModel = (platform: AgentPlatform, modelId: string): AgentSettingsTier => {
    let next = withPlatformField(tier, platform, "model", modelId);
    const nextModel = modelsForAgent(catalog, platform).find(
      (model) => model.id === modelId || model.resolvedModel === modelId,
    );
    if (nextModel?.supportsSpeed !== true) {
      next = withPlatformField(next, platform, "fastMode", undefined);
    }
    return next;
  };

  const actionDefaults: ActionDefaults = tier?.actionDefaults ?? {};
  const inheritedActions: ActionDefaults = resolveActionDefaults(parentTiers);

  const setAction = (key: ActionDefaultKey, entry: AgentActionDefault | undefined) => {
    const next = { ...actionDefaults };
    if (entry) next[key] = entry;
    else delete next[key];
    onChange({ ...tier, actionDefaults: next });
  };

  return (
    <div className="max-w-3xl space-y-8">
      <div className="space-y-3">
        <div>
          <h3 className="text-sm font-medium text-foreground">Default agent</h3>
          <p className="mt-1 max-w-2xl text-xs leading-relaxed text-muted-foreground">
            The agent {scopeLabel} launches when nothing more specific names one.
            {canInherit && " Leave on Inherit to follow the level above."}
          </p>
        </div>
        <div
          role="radiogroup"
          aria-label="Default agent"
          className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3"
        >
          {canInherit && (
            <button
              type="button"
              role="radio"
              aria-checked={!tier?.defaultAgent}
              disabled={disabled}
              onClick={() => onChange({ ...tier, defaultAgent: undefined })}
              className={cn(
                "rounded-lg border-2 p-3 text-left text-sm font-medium transition-colors",
                !tier?.defaultAgent
                  ? "border-primary bg-primary/5"
                  : "border-transparent bg-zinc-900 hover:border-zinc-600",
              )}
            >
              Inherit — {AGENT_PLATFORM_LABELS[inheritedAgent]}
              <div className="mt-1 text-xs font-normal text-muted-foreground">
                from {TIER_LABELS[inheritedAgentSource]}
              </div>
            </button>
          )}
          {enabledPlatforms.map((platform) => (
            <button
              key={platform}
              type="button"
              role="radio"
              aria-checked={tier?.defaultAgent === platform}
              disabled={disabled}
              onClick={() => onChange({ ...tier, defaultAgent: platform })}
              className={cn(
                "rounded-lg border-2 p-3 text-left transition-colors",
                tier?.defaultAgent === platform
                  ? "border-primary bg-primary/5"
                  : "border-transparent bg-zinc-900 hover:border-zinc-600",
              )}
            >
              <div className="flex items-center gap-2 text-sm font-medium">
                <AgentPlatformIcon platform={platform} accent className="h-4 w-4" />
                {AGENT_PLATFORM_LABELS[platform]}
              </div>
            </button>
          ))}
        </div>
      </div>

      <div className="space-y-3">
        <div>
          <h3 className="text-sm font-medium text-foreground">Default model</h3>
          <p className="mt-1 max-w-2xl text-xs leading-relaxed text-muted-foreground">
            The model {AGENT_PLATFORM_LABELS[effectiveAgent]} starts on. This is the same setting as
            the one on the {AGENT_PLATFORM_LABELS[effectiveAgent]} tab — changing either changes
            both. Other platforms keep their own.
          </p>
        </div>
        {models.length > 0 ? (
          <AgentModelPicker
            id="agent-default-model"
            ariaLabel="Default model and reasoning"
            title="Choose the default model and reasoning level"
            disabled={disabled}
            models={pickerModels}
            enabledPlatforms={enabledPlatforms}
            selectedPlatform={effectiveAgent}
            favorites={favorites.favorites}
            onToggleFavorite={favorites.toggleFavorite}
            onReorderFavorites={favorites.reorderFavorites}
            // Choosing a platform on the rail sets the default agent; its model
            // then comes from that platform's own column.
            onPlatformChange={(next) => onChange({ ...tier, defaultAgent: next })}
            selectedModelId={selectedModel?.id}
            selectedModelLabel={
              storedForAgent?.model
                ? (selectedModel?.name ?? storedForAgent.model)
                : `${AGENT_PLATFORM_LABELS[effectiveAgent]} · ${
                    resolvedForAgent.model ?? "provider default"
                  }`
            }
            onModelChange={(nextModelId) => onChange(setModel(effectiveAgent, nextModelId))}
            onModelSelect={(nextModel) =>
              onChange({
                ...setModel(nextModel.platform, nextModel.id),
                defaultAgent: nextModel.platform,
              })
            }
            reasoningOptions={reasoningOptions}
            selectedReasoningId={storedForAgent?.reasoningEffort ?? INHERIT}
            selectedReasoningLabel={
              reasoningOptions.find(
                (option) => option.id === (storedForAgent?.reasoningEffort ?? INHERIT),
              )?.label
            }
            onReasoningChange={(nextId) =>
              onChange(
                withPlatformField(
                  tier,
                  effectiveAgent,
                  "reasoningEffort",
                  nextId === INHERIT ? undefined : nextId,
                ),
              )
            }
            speedCapable={speedCapable}
            fastModeAvailable={speedCapable && selectedSupportsSpeed}
            fastModeEnabled={
              speedCapable ? (storedForAgent?.fastMode ?? inheritedSpeed ?? null) : false
            }
            speedInherit={
              speedCapable
                ? {
                    label: canInherit ? "Inherit" : "Provider default",
                    selected: storedForAgent?.fastMode === undefined,
                  }
                : undefined
            }
            onFastModeChange={
              speedCapable
                ? (enabled) =>
                    onChange(withPlatformField(tier, effectiveAgent, "fastMode", enabled))
                : undefined
            }
            onFastModeInherit={
              speedCapable
                ? () => onChange(withPlatformField(tier, effectiveAgent, "fastMode", undefined))
                : undefined
            }
            className="min-h-11 w-full max-w-none justify-start border border-zinc-700/80 bg-zinc-900 py-2.5 text-sm text-zinc-100 md:max-w-none md:flex-1"
          />
        ) : (
          <p className="text-xs italic text-muted-foreground">
            Start an environment to load available models.
          </p>
        )}
      </div>

      <div className="space-y-3">
        <div>
          <h3 className="text-sm font-medium text-foreground">Action defaults</h3>
          <p className="mt-1 max-w-2xl text-xs leading-relaxed text-muted-foreground">
            The agent, model and reasoning level each toolbar workflow uses. Configure dialogs open
            on the default set here, and confirming a single run never changes these settings.
          </p>
          <p className="mt-2 max-w-2xl text-xs leading-relaxed text-muted-foreground">
            An action default is what that action uses, whichever agent the environment was created
            with. The Default agent above applies only to actions left on Inherit at every level.
          </p>
        </div>
        <div className="space-y-3">
          {ACTION_DEFAULT_KEYS.map((key) => {
            const definition = ACTION_DEFINITIONS[key];
            const entry = actionDefaults[key];
            const inheritedEntry = inheritedActions[key];
            const platform =
              entry?.platform && enabledPlatforms.includes(entry.platform)
                ? entry.platform
                : undefined;
            // An unset action follows its inherited action entry, which can use
            // a different provider from this tier's default agent. A disabled
            // inherited provider is ignored whole by the runtime resolver, so
            // constrain the icon, label and initial catalogue the same way.
            const inheritedPlatform =
              inheritedEntry?.platform && enabledPlatforms.includes(inheritedEntry.platform)
                ? inheritedEntry.platform
                : undefined;
            const displayedPlatform = inheritedPlatform ?? effectiveAgent;
            const actionModels = modelsForAgent(catalog, platform ?? effectiveAgent);
            const actionSelected =
              platform && entry?.model
                ? actionModels.find((model) => model.id === entry.model)
                : undefined;
            const actionModelMissing = Boolean(platform && entry?.model && !actionSelected);
            // A stored level the catalog no longer lists stays selectable, so
            // opening this pane cannot quietly rewrite a saved default.
            const actionEfforts = actionSelected?.reasoningEfforts ?? [];
            const actionEffortIds =
              entry?.reasoningEffort && !actionEfforts.includes(entry.reasoningEffort)
                ? [...actionEfforts, entry.reasoningEffort]
                : actionEfforts;
            const actionReasoning: AgentReasoningOption[] =
              actionEffortIds.length === 0
                ? []
                : [
                    { id: INHERIT, label: "Default" },
                    ...actionEffortIds.map((effort) => ({
                      id: effort,
                      label: effortLabel(effort),
                    })),
                  ];
            return (
              <div
                key={key}
                className="space-y-2 rounded-lg border border-zinc-800 bg-zinc-950/50 p-4"
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="space-y-1">
                    <Label
                      htmlFor={`action-default-${key}`}
                      className="flex items-center gap-2 text-sm font-medium text-foreground"
                    >
                      {definition.icon}
                      {definition.label}
                    </Label>
                    <p className="max-w-xl text-xs leading-relaxed text-muted-foreground">
                      {definition.description}
                    </p>
                  </div>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="h-8 w-fit shrink-0 gap-1.5 text-xs"
                    onClick={() => setAction(key, undefined)}
                    disabled={disabled || !entry?.platform}
                  >
                    <RotateCcw className="h-3.5 w-3.5" />
                    {canInherit ? "Inherit" : "Clear"}
                  </Button>
                </div>
                <AgentModelPicker
                  id={`action-default-${key}`}
                  ariaLabel={`${definition.label} default agent, model and reasoning`}
                  title="Choose agent, model, and reasoning"
                  disabled={disabled}
                  models={pickerModels}
                  enabledPlatforms={enabledPlatforms}
                  selectedPlatform={platform ?? displayedPlatform}
                  favorites={favorites.favorites}
                  onToggleFavorite={favorites.toggleFavorite}
                  onReorderFavorites={favorites.reorderFavorites}
                  onPlatformChange={(next) => setAction(key, { platform: next })}
                  selectedModelId={actionSelected?.id}
                  selectedModelLabel={
                    platform
                      ? `${AGENT_PLATFORM_LABELS[platform]} · ${
                          entry?.model ? (actionSelected?.name ?? entry.model) : "Default model"
                        }`
                      : inheritedPlatform
                        ? `Inherit — ${AGENT_PLATFORM_LABELS[inheritedPlatform]}`
                        : canInherit
                          ? "Inherit"
                          : "App default"
                  }
                  onModelChange={(nextModelId) =>
                    setAction(key, { platform: platform ?? effectiveAgent, model: nextModelId })
                  }
                  onModelSelect={(nextModel) =>
                    setAction(key, { platform: nextModel.platform, model: nextModel.id })
                  }
                  reasoningOptions={actionReasoning}
                  selectedReasoningId={entry?.reasoningEffort ?? INHERIT}
                  selectedReasoningLabel={
                    actionReasoning.find(
                      (option) => option.id === (entry?.reasoningEffort ?? INHERIT),
                    )?.label
                  }
                  // Provider and model move together, so the reasoning level
                  // belongs to the model: choosing a new one resets it.
                  onReasoningChange={(nextId) =>
                    setAction(key, {
                      platform: platform ?? effectiveAgent,
                      ...(entry?.model ? { model: entry.model } : {}),
                      ...(nextId === INHERIT ? {} : { reasoningEffort: nextId }),
                    })
                  }
                />
                {actionModelMissing && (
                  <p className="text-xs text-amber-300">
                    {entry?.model} is not in the current catalog. It is still saved and will be sent
                    as-is; pick another model to replace it.
                  </p>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
