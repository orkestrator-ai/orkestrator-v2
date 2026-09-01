import { useMemo } from "react";
import { Minus, Plus, RotateCcw } from "lucide-react";
import { AgentModelPicker } from "@/components/chat/AgentModelPicker";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { useAgentModelFavorites } from "@/hooks/useAgentModelFavorites";
import {
  effortLabel,
  modelsForAgent,
  toPickerModel,
  type AgentModelCatalog,
} from "@/lib/agent-launch";
import { resolvedActionDefault } from "@/lib/agent-settings";
import {
  AGENT_PLATFORM_LABELS,
  firstEnabledAgentPlatform,
  type AgentPlatform,
} from "@orkestrator/protocol/agent-platforms";
import type { AgentActionDefault } from "@orkestrator/protocol/action-defaults";
import {
  DEFAULT_MULTI_REVIEW_REVIEWER_COUNT,
  resolveAgentPlatformSettings,
  resolveDefaultAgent,
  type AgentSettingsTier,
  type AgentSettingsTiers,
} from "@orkestrator/protocol/agent-settings";
import {
  MULTI_REVIEW_MAX_REVIEWERS,
  MULTI_REVIEW_MIN_REVIEWERS,
} from "@orkestrator/protocol/multi-review";
import type { AgentModel, AgentReasoningOption } from "@orkestrator/protocol/native-agent";
import { INHERIT } from "./InheritedValue";

interface MultiReviewDefaultsEditorProps {
  tier: AgentSettingsTier;
  onChange: (tier: AgentSettingsTier) => void;
  tiers: AgentSettingsTiers;
  enabledPlatforms: AgentPlatform[];
  catalog: AgentModelCatalog;
  disabled?: boolean;
}

function reviewerEntry(tier: AgentSettingsTier, index: number): AgentActionDefault | undefined {
  if (index === 0) return tier.actionDefaults?.review;
  if (index === 1) return tier.actionDefaults?.review2;
  return (
    tier.multiReview?.additionalReviewers?.[index - DEFAULT_MULTI_REVIEW_REVIEWER_COUNT] ??
    undefined
  );
}

function withReviewerEntry(
  tier: AgentSettingsTier,
  index: number,
  entry: AgentActionDefault | undefined,
): AgentSettingsTier {
  if (index < DEFAULT_MULTI_REVIEW_REVIEWER_COUNT) {
    const key = index === 0 ? "review" : "review2";
    const actionDefaults = { ...tier.actionDefaults };
    if (entry) actionDefaults[key] = entry;
    else delete actionDefaults[key];
    return { ...tier, actionDefaults };
  }

  const additionalReviewers = [...(tier.multiReview?.additionalReviewers ?? [])];
  const additionalIndex = index - DEFAULT_MULTI_REVIEW_REVIEWER_COUNT;
  while (additionalReviewers.length <= additionalIndex) additionalReviewers.push(null);
  additionalReviewers[additionalIndex] = entry ?? null;
  while (additionalReviewers.at(-1) === null) additionalReviewers.pop();
  return {
    ...tier,
    multiReview: {
      ...tier.multiReview,
      ...(additionalReviewers.length > 0
        ? { additionalReviewers }
        : { additionalReviewers: undefined }),
    },
  };
}

function withReviewerCount(tier: AgentSettingsTier, reviewerCount: number): AgentSettingsTier {
  const additionalCount = Math.max(0, reviewerCount - DEFAULT_MULTI_REVIEW_REVIEWER_COUNT);
  const additionalReviewers = (tier.multiReview?.additionalReviewers ?? []).slice(
    0,
    additionalCount,
  );
  const multiReview = {
    ...(reviewerCount !== DEFAULT_MULTI_REVIEW_REVIEWER_COUNT ? { reviewerCount } : {}),
    ...(additionalReviewers.length > 0 ? { additionalReviewers } : {}),
  };
  return {
    ...tier,
    ...(Object.keys(multiReview).length > 0 ? { multiReview } : { multiReview: undefined }),
  };
}

function ReviewerDefaultPicker({
  index,
  entry,
  fallbackEntry,
  fallbackLabel,
  inheritFallbackFieldsWhenConfigured,
  tiers,
  enabledPlatforms,
  catalog,
  pickerModels,
  favorites,
  disabled,
  onChange,
}: {
  index: number;
  entry: AgentActionDefault | undefined;
  fallbackEntry: AgentActionDefault & { platform: AgentPlatform };
  fallbackLabel: string;
  inheritFallbackFieldsWhenConfigured?: boolean;
  tiers: AgentSettingsTiers;
  enabledPlatforms: AgentPlatform[];
  catalog: AgentModelCatalog;
  pickerModels: AgentModel[];
  favorites: ReturnType<typeof useAgentModelFavorites>;
  disabled?: boolean;
  onChange: (entry: AgentActionDefault | undefined) => void;
}) {
  const platform =
    entry?.platform && enabledPlatforms.includes(entry.platform)
      ? entry.platform
      : fallbackEntry.platform;
  const platformDefault = resolveAgentPlatformSettings(tiers, platform);
  const models = modelsForAgent(catalog, platform);
  const inheritsFallbackFields =
    !entry ||
    (inheritFallbackFieldsWhenConfigured === true && entry.platform === fallbackEntry.platform);
  const effectiveModelId =
    entry?.model ??
    (inheritsFallbackFields ? fallbackEntry.model : undefined) ??
    platformDefault.model;
  const selectedModel = effectiveModelId
    ? models.find(
        (model) => model.id === effectiveModelId || model.resolvedModel === effectiveModelId,
      )
    : undefined;
  const reasoningModel = selectedModel ?? models[0];
  const efforts = reasoningModel?.reasoningEfforts ?? [];
  const effectiveReasoningEffort =
    entry?.reasoningEffort ??
    (inheritsFallbackFields ? fallbackEntry.reasoningEffort : undefined) ??
    platformDefault.reasoningEffort;
  const effortIds =
    effectiveReasoningEffort && !efforts.includes(effectiveReasoningEffort)
      ? [...efforts, effectiveReasoningEffort]
      : efforts;
  const reasoningOptions: AgentReasoningOption[] =
    effortIds.length === 0
      ? []
      : [
          { id: INHERIT, label: "Model default" },
          ...effortIds.map((effort) => ({ id: effort, label: effortLabel(effort) })),
        ];
  const modelLabel = selectedModel?.name ?? effectiveModelId ?? "Provider default";
  const label = `Reviewer ${index + 1}`;

  return (
    <div
      data-multi-review-default-row
      className="min-w-0 rounded-lg border border-zinc-800/90 bg-zinc-950/40 p-3"
    >
      <div className="mb-2 flex min-h-8 items-center justify-between gap-2">
        <Label
          htmlFor={`multi-review-default-${index}`}
          className="text-xs font-medium text-foreground"
        >
          {label}
        </Label>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-7 gap-1 px-2 text-[11px]"
          onClick={() => onChange(undefined)}
          disabled={disabled || !entry?.platform}
        >
          <RotateCcw className="size-3" /> Reset model
        </Button>
      </div>
      <AgentModelPicker
        id={`multi-review-default-${index}`}
        ariaLabel={`${label} default agent, model and reasoning`}
        title={`Choose the default for ${label.toLowerCase()}`}
        disabled={disabled}
        models={pickerModels}
        enabledPlatforms={enabledPlatforms}
        selectedPlatform={platform}
        favorites={favorites.favorites}
        onToggleFavorite={favorites.toggleFavorite}
        onReorderFavorites={favorites.reorderFavorites}
        onPlatformChange={(next) => onChange({ platform: next })}
        selectedModelId={selectedModel?.id}
        selectedModelLabel={`${entry?.platform ? "" : `${fallbackLabel} — `}${AGENT_PLATFORM_LABELS[platform]} · ${modelLabel}`}
        onModelChange={(model) => onChange({ platform, model })}
        onModelSelect={(model) => onChange({ platform: model.platform, model: model.id })}
        reasoningOptions={reasoningOptions}
        selectedReasoningId={effectiveReasoningEffort ?? INHERIT}
        selectedReasoningLabel={
          reasoningOptions.find((option) => option.id === (effectiveReasoningEffort ?? INHERIT))
            ?.label
        }
        onReasoningChange={(reasoningEffort) =>
          onChange({
            platform,
            ...(entry?.model ? { model: entry.model } : {}),
            ...(reasoningEffort === INHERIT ? {} : { reasoningEffort }),
          })
        }
        className="min-h-11 w-full max-w-none justify-start border border-zinc-700/80 bg-zinc-900 py-2.5 text-sm text-zinc-100 md:max-w-none md:flex-1"
      />
      {entry?.model && !selectedModel && (
        <p className="mt-2 text-xs text-amber-300">
          {entry.model} is not in the current catalog. Pick another model to replace it.
        </p>
      )}
    </div>
  );
}

export function MultiReviewDefaultsEditor({
  tier,
  onChange,
  tiers,
  enabledPlatforms,
  catalog,
  disabled,
}: MultiReviewDefaultsEditorProps) {
  const favorites = useAgentModelFavorites();
  const reviewerCount = tier.multiReview?.reviewerCount ?? DEFAULT_MULTI_REVIEW_REVIEWER_COUNT;
  const fallbackAgent = firstEnabledAgentPlatform(enabledPlatforms, resolveDefaultAgent(tiers));
  const reviewFallback = resolvedActionDefault(tiers, "review", enabledPlatforms);
  const reviewFallbackEntry: AgentActionDefault & { platform: AgentPlatform } = {
    platform: reviewFallback.agent,
    ...(reviewFallback.model ? { model: reviewFallback.model } : {}),
    ...(reviewFallback.reasoningEffort ? { reasoningEffort: reviewFallback.reasoningEffort } : {}),
  };
  const pickerModels = useMemo<AgentModel[]>(
    () =>
      enabledPlatforms.flatMap((platform) =>
        modelsForAgent(catalog, platform)
          .filter((option) => !(platform === "opencode" && option.id === "default"))
          .map((option) => toPickerModel(platform, option)),
      ),
    [catalog, enabledPlatforms],
  );

  return (
    <section className="space-y-4" aria-labelledby="multi-review-defaults-heading">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h3 id="multi-review-defaults-heading" className="text-sm font-medium text-foreground">
            Multi Review defaults
          </h3>
          <p className="mt-1 max-w-2xl text-xs leading-relaxed text-muted-foreground">
            Choose how many independent reviewers a plain Multi Review starts and the model each one
            uses. Reviewer 1 and Reviewer 2 are shared with the Defaults page.
          </p>
        </div>
        <div
          className="flex w-fit items-center rounded-lg border border-zinc-800 bg-zinc-950/60 p-1"
          role="group"
          aria-label="Default reviewer count"
        >
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="size-8"
            aria-label="Use one fewer reviewer"
            disabled={disabled || reviewerCount <= MULTI_REVIEW_MIN_REVIEWERS}
            onClick={() => onChange(withReviewerCount(tier, reviewerCount - 1))}
          >
            <Minus className="size-3.5" />
          </Button>
          <output
            className="min-w-24 px-2 text-center text-xs font-medium tabular-nums text-zinc-200"
            aria-live="polite"
          >
            {reviewerCount} {reviewerCount === 1 ? "reviewer" : "reviewers"}
          </output>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="size-8"
            aria-label="Use one more reviewer"
            disabled={disabled || reviewerCount >= MULTI_REVIEW_MAX_REVIEWERS}
            onClick={() => onChange(withReviewerCount(tier, reviewerCount + 1))}
          >
            <Plus className="size-3.5" />
          </Button>
        </div>
      </div>

      <div
        role="group"
        aria-label="Default Multi Review models"
        className="grid grid-cols-1 gap-3 sm:grid-cols-2"
      >
        {Array.from({ length: reviewerCount }, (_, index) => (
          <ReviewerDefaultPicker
            key={index}
            index={index}
            entry={reviewerEntry(tier, index)}
            fallbackEntry={index === 0 ? { platform: fallbackAgent } : reviewFallbackEntry}
            fallbackLabel={index === 0 ? "App default" : "Follows Review"}
            inheritFallbackFieldsWhenConfigured={index >= DEFAULT_MULTI_REVIEW_REVIEWER_COUNT}
            tiers={tiers}
            enabledPlatforms={enabledPlatforms}
            catalog={catalog}
            pickerModels={pickerModels}
            favorites={favorites}
            disabled={disabled}
            onChange={(entry) => onChange(withReviewerEntry(tier, index, entry))}
          />
        ))}
      </div>
    </section>
  );
}
