import { Fragment, useCallback } from "react";
import {
  ChevronDown,
  GitMerge,
  GitPullRequest,
  Hammer,
  ListChecks,
  MessageSquareText,
  Plus,
  ScanSearch,
  Sparkles,
  Trash2,
} from "lucide-react";
import { MAX_BUILD_PIPELINE_REVIEWERS } from "@orkestrator/protocol/build-pipeline";
import type { AgentModel } from "@orkestrator/protocol/native-agent";
import { AgentModelPicker } from "@/components/chat/AgentModelPicker";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { useAgentModelFavorites } from "@/hooks/useAgentModelFavorites";
import {
  defaultEffortFor,
  effortLabel,
  modelsForAgent,
  type AgentModelCatalog,
  type LaunchAgent,
} from "@/lib/agent-launch";
import {
  featureBuildReviewerRow,
  type BuildIntent,
  type FeatureBuildModelState,
  type FeatureBuildReviewerRow,
  type FeatureBuildStepSelection,
} from "@/lib/feature-build-launch";
import { cn } from "@/lib/utils";

const BUILD_INTENTS: Array<{
  value: BuildIntent;
  label: string;
  description: string;
  icon: React.ReactNode;
}> = [
  {
    value: "feature",
    label: "A feature",
    description: "Specify what you want to build",
    icon: <Sparkles className="h-3.5 w-3.5" />,
  },
  {
    value: "prompt",
    label: "With a prompt",
    description: "Ask the agent to do something",
    icon: <MessageSquareText className="h-3.5 w-3.5" />,
  },
];

/**
 * The single-selection steps, in the order the pipeline runs them.
 *
 * Review is absent because it is a list rather than one decision, and Verify is
 * absent because it runs on the address model — see `FeatureBuildModelState`.
 */
const SINGLE_STEPS: Array<{
  key: "build" | "address" | "pr" | "resolve";
  title: string;
  description: string;
  icon: React.ReactNode;
}> = [
  {
    key: "build",
    title: "Build",
    description: "Implements the ticket.",
    icon: <Hammer className="size-4" />,
  },
  {
    key: "address",
    title: "Address issues",
    description: "Fixes the consolidated review findings, and verifies the result.",
    icon: <ListChecks className="size-4" />,
  },
  {
    key: "pr",
    title: "Pull request",
    description: "Pushes the branch and opens the pull request.",
    icon: <GitPullRequest className="size-4" />,
  },
  {
    key: "resolve",
    title: "Resolve conflicts",
    description: "Resolves merge conflicts on the open pull request.",
    icon: <GitMerge className="size-4" />,
  },
];

export interface FeatureBuildFieldsProps {
  intent: BuildIntent;
  onIntentChange: (intent: BuildIntent) => void;
  name: string;
  onNameChange: (value: string) => void;
  description: string;
  onDescriptionChange: (value: string) => void;
  acceptanceCriteria: string;
  onAcceptanceCriteriaChange: (value: string) => void;
  advancedOpen: boolean;
  onAdvancedOpenChange: (open: boolean) => void;
  customizeModels: boolean;
  onCustomizeModelsChange: (enabled: boolean) => void;
  models: FeatureBuildModelState;
  onModelsChange: (models: FeatureBuildModelState) => void;
  catalog: AgentModelCatalog;
  enabledPlatforms: LaunchAgent[];
  disabled?: boolean;
  /** Rendered under the intent selector when "with a prompt" is chosen. */
  promptFields: React.ReactNode;
  /** Image attachments rendered with the feature ticket fields. */
  featureAttachments?: React.ReactNode;
}

export function FeatureBuildFields({
  intent,
  onIntentChange,
  name,
  onNameChange,
  description,
  onDescriptionChange,
  acceptanceCriteria,
  onAcceptanceCriteriaChange,
  advancedOpen,
  onAdvancedOpenChange,
  customizeModels,
  onCustomizeModelsChange,
  models,
  onModelsChange,
  catalog,
  enabledPlatforms,
  disabled = false,
  promptFields,
  featureAttachments,
}: FeatureBuildFieldsProps) {
  const selectedIntent = BUILD_INTENTS.find((option) => option.value === intent)!;

  return (
    <div className="border-b border-divider">
      <div className="px-4 py-3 sm:grid sm:grid-cols-[7.5rem_minmax(0,1fr)] sm:items-center sm:gap-4 sm:px-6">
        <Label className="mb-2 block text-sm font-medium text-muted-foreground sm:mb-0">
          Build
        </Label>
        <div className="flex min-w-0 flex-wrap items-center gap-x-4 gap-y-2">
          <div className="inline-grid grid-cols-2 rounded-lg border border-divider bg-input-surface p-0.5">
            {BUILD_INTENTS.map((option) => (
              <button
                key={option.value}
                type="button"
                onClick={() => onIntentChange(option.value)}
                disabled={disabled}
                aria-pressed={intent === option.value}
                className={cn(
                  "flex h-8 items-center justify-center gap-1.5 rounded-md px-3 text-sm transition-[background-color,color,box-shadow] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60 disabled:cursor-not-allowed disabled:opacity-50",
                  intent === option.value
                    ? "bg-primary font-bold text-primary-foreground shadow-sm"
                    : "font-normal text-muted-foreground hover:bg-elevated hover:text-foreground",
                )}
              >
                {option.icon}
                {option.label}
              </button>
            ))}
          </div>
          <p className="text-xs text-muted-foreground">{selectedIntent.description}</p>
        </div>
      </div>

      {intent === "feature" ? (
        <div className="space-y-3 border-t border-divider px-4 py-3 sm:px-6">
          <div className="space-y-1.5">
            <Label htmlFor="feature-name" className="text-sm">
              Feature name
            </Label>
            <Input
              id="feature-name"
              value={name}
              onChange={(event) => onNameChange(event.target.value)}
              placeholder="e.g., Dark mode toggle"
              disabled={disabled}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="feature-description" className="text-sm">
              Description
            </Label>
            <Textarea
              id="feature-description"
              value={description}
              onChange={(event) => onDescriptionChange(event.target.value)}
              placeholder="What should this feature do?"
              rows={3}
              disabled={disabled}
              className="max-h-[calc(8lh+1rem)] resize-none overflow-y-auto"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="feature-acceptance-criteria" className="text-sm">
              Acceptance criteria
            </Label>
            <Textarea
              id="feature-acceptance-criteria"
              value={acceptanceCriteria}
              onChange={(event) => onAcceptanceCriteriaChange(event.target.value)}
              placeholder="How will we know it is done?"
              rows={3}
              disabled={disabled}
              className="max-h-[calc(8lh+1rem)] resize-none overflow-y-auto"
            />
          </div>

          {featureAttachments}

          <Collapsible open={advancedOpen} onOpenChange={onAdvancedOpenChange}>
            <CollapsibleTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                disabled={disabled}
                className="h-9 w-full justify-between rounded-lg border border-input bg-muted/30 px-3 hover:bg-muted/50"
              >
                <span className="flex items-center gap-2">
                  <span className="text-sm font-medium">Advanced</span>
                  <span className="text-xs font-normal text-muted-foreground">
                    {models.reviewers.length}{" "}
                    {models.reviewers.length === 1 ? "reviewer" : "reviewers"}
                  </span>
                </span>
                <ChevronDown
                  className={cn(
                    "h-4 w-4 transition-transform duration-200",
                    advancedOpen && "rotate-180",
                  )}
                />
              </Button>
            </CollapsibleTrigger>
            <CollapsibleContent className="space-y-3 pt-3">
              <div className="flex items-center justify-between gap-4">
                <div className="space-y-0.5">
                  <Label htmlFor="customize-models" className="text-sm">
                    Customize models
                  </Label>
                  <p className="text-xs text-muted-foreground">
                    Choose a model per build step. Off uses your configured defaults.
                  </p>
                </div>
                <Switch
                  id="customize-models"
                  checked={customizeModels}
                  onCheckedChange={onCustomizeModelsChange}
                  disabled={disabled}
                />
              </div>
              {customizeModels ? (
                <FeatureBuildModelPickers
                  models={models}
                  onModelsChange={onModelsChange}
                  catalog={catalog}
                  enabledPlatforms={enabledPlatforms}
                  disabled={disabled}
                />
              ) : null}
            </CollapsibleContent>
          </Collapsible>
        </div>
      ) : (
        <div className="border-t border-divider px-4 py-3 sm:px-6">{promptFields}</div>
      )}
    </div>
  );
}

interface ModelPickersProps {
  models: FeatureBuildModelState;
  onModelsChange: (models: FeatureBuildModelState) => void;
  catalog: AgentModelCatalog;
  enabledPlatforms: LaunchAgent[];
  disabled: boolean;
}

function FeatureBuildModelPickers({
  models,
  onModelsChange,
  catalog,
  enabledPlatforms,
  disabled,
}: ModelPickersProps) {
  const {
    favorites: favoriteModels,
    toggleFavorite: toggleFavoriteModel,
    reorderFavorites,
  } = useAgentModelFavorites();

  const pickerModels: AgentModel[] = enabledPlatforms.flatMap((platform) =>
    modelsForAgent(catalog, platform).map((option) => ({
      platform,
      id: option.id,
      label: option.name,
      description: option.description,
      reasoning: option.reasoningEfforts.map((effort) => ({
        id: effort,
        label: effortLabel(effort),
      })),
    })),
  );

  const updateReviewers = useCallback(
    (reviewers: FeatureBuildReviewerRow[]) => onModelsChange({ ...models, reviewers }),
    [models, onModelsChange],
  );

  const canRemoveReviewer = models.reviewers.length > 1;
  const stepRows = SINGLE_STEPS.map((step) => (
    <StepRow
      key={step.key}
      title={step.title}
      description={step.description}
      icon={step.icon}
      selection={models[step.key]}
      onSelectionChange={(selection) => onModelsChange({ ...models, [step.key]: selection })}
      pickerModels={pickerModels}
      enabledPlatforms={enabledPlatforms}
      catalog={catalog}
      disabled={disabled}
      favorites={favoriteModels}
      onToggleFavorite={toggleFavoriteModel}
      onReorderFavorites={reorderFavorites}
      idPrefix={`feature-build-${step.key}`}
    />
  ));

  return (
    <div role="group" aria-label="Feature build model customization" className="space-y-3">
      {stepRows[0]}

      <div className="space-y-2 rounded-lg border border-border/70 bg-zinc-950/20 p-3">
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-center gap-2">
            <ScanSearch className="size-4" />
            <div>
              <div className="text-sm font-medium">Review</div>
              <div className="text-xs text-muted-foreground">
                Each reviewer reads the diff independently; the address model merges their reports.
              </div>
            </div>
          </div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="gap-1"
            disabled={disabled || models.reviewers.length >= MAX_BUILD_PIPELINE_REVIEWERS}
            onClick={() =>
              updateReviewers([
                ...models.reviewers,
                featureBuildReviewerRow({ agent: models.reviewers[0]?.agent ?? "claude" }, catalog),
              ])
            }
          >
            <Plus className="size-3.5" />
            Add review
          </Button>
        </div>
        {models.reviewers.map((reviewer, index) => (
          <Fragment key={reviewer.key}>
            <div className="flex items-center gap-2">
              <div className="min-w-0 flex-1">
                <ModelPicker
                  id={`feature-build-review-${index}`}
                  ariaLabel={`Review ${index + 1} agent, model and reasoning`}
                  selection={reviewer}
                  onSelectionChange={(selection) =>
                    updateReviewers(
                      models.reviewers.map((row) =>
                        row.key === reviewer.key ? { ...row, ...selection } : row,
                      ),
                    )
                  }
                  pickerModels={pickerModels}
                  enabledPlatforms={enabledPlatforms}
                  catalog={catalog}
                  disabled={disabled}
                  favorites={favoriteModels}
                  onToggleFavorite={toggleFavoriteModel}
                  onReorderFavorites={reorderFavorites}
                />
              </div>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="h-8 w-8 shrink-0 text-muted-foreground hover:text-destructive"
                aria-label={`Remove review ${index + 1}`}
                disabled={disabled || !canRemoveReviewer}
                onClick={() =>
                  updateReviewers(models.reviewers.filter((row) => row.key !== reviewer.key))
                }
              >
                <Trash2 className="size-3.5" />
              </Button>
            </div>
          </Fragment>
        ))}
      </div>

      {stepRows.slice(1)}
    </div>
  );
}

interface StepRowProps {
  title: string;
  description: string;
  icon: React.ReactNode;
  selection: FeatureBuildStepSelection;
  onSelectionChange: (selection: FeatureBuildStepSelection) => void;
  pickerModels: AgentModel[];
  enabledPlatforms: LaunchAgent[];
  catalog: AgentModelCatalog;
  disabled: boolean;
  favorites: ReturnType<typeof useAgentModelFavorites>["favorites"];
  onToggleFavorite: ReturnType<typeof useAgentModelFavorites>["toggleFavorite"];
  onReorderFavorites: ReturnType<typeof useAgentModelFavorites>["reorderFavorites"];
  idPrefix: string;
}

function StepRow({
  title,
  description,
  icon,
  selection,
  onSelectionChange,
  pickerModels,
  enabledPlatforms,
  catalog,
  disabled,
  favorites,
  onToggleFavorite,
  onReorderFavorites,
  idPrefix,
}: StepRowProps) {
  return (
    <div className="space-y-2 rounded-lg border border-border/70 bg-zinc-950/20 p-3">
      <div className="flex items-center gap-2">
        {icon}
        <div>
          <div className="text-sm font-medium">{title}</div>
          <div className="text-xs text-muted-foreground">{description}</div>
        </div>
      </div>
      <ModelPicker
        id={idPrefix}
        ariaLabel={`${title} agent, model and reasoning`}
        selection={selection}
        onSelectionChange={onSelectionChange}
        pickerModels={pickerModels}
        enabledPlatforms={enabledPlatforms}
        catalog={catalog}
        disabled={disabled}
        favorites={favorites}
        onToggleFavorite={onToggleFavorite}
        onReorderFavorites={onReorderFavorites}
      />
    </div>
  );
}

interface ModelPickerProps {
  id: string;
  ariaLabel: string;
  selection: FeatureBuildStepSelection;
  onSelectionChange: (selection: FeatureBuildStepSelection) => void;
  pickerModels: AgentModel[];
  enabledPlatforms: LaunchAgent[];
  catalog: AgentModelCatalog;
  disabled: boolean;
  favorites: ReturnType<typeof useAgentModelFavorites>["favorites"];
  onToggleFavorite: ReturnType<typeof useAgentModelFavorites>["toggleFavorite"];
  onReorderFavorites: ReturnType<typeof useAgentModelFavorites>["reorderFavorites"];
}

function ModelPicker({
  id,
  ariaLabel,
  selection,
  onSelectionChange,
  pickerModels,
  enabledPlatforms,
  catalog,
  disabled,
  favorites,
  onToggleFavorite,
  onReorderFavorites,
}: ModelPickerProps) {
  const options = modelsForAgent(catalog, selection.agent);
  const selected = options.find((option) => option.id === selection.model);
  const reasoningOptions =
    (selected?.reasoningEfforts?.length ?? 0) > 0
      ? [
          { id: "default", label: "Default" },
          ...selected!.reasoningEfforts.map((effort) => ({
            id: effort,
            label: effortLabel(effort),
          })),
        ]
      : [];
  const reasoningId = selection.reasoningEffort ?? "default";

  /**
   * Moving platform re-resolves the model and reasoning level, because a model
   * id only means anything inside its own platform's catalogue: carrying one
   * across would pin a model the new harness does not have.
   */
  const selectPlatform = (platform: LaunchAgent) => {
    if (platform === selection.agent) return;
    const nextModel = modelsForAgent(catalog, platform)[0]?.id ?? "default";
    const effort = defaultEffortFor(platform, nextModel, catalog);
    onSelectionChange({
      agent: platform,
      model: nextModel,
      ...(effort === "default" ? {} : { reasoningEffort: effort }),
    });
  };

  return (
    <AgentModelPicker
      id={id}
      ariaLabel={ariaLabel}
      models={pickerModels}
      enabledPlatforms={enabledPlatforms}
      selectedPlatform={selection.agent}
      favorites={favorites}
      onPlatformChange={selectPlatform}
      onToggleFavorite={onToggleFavorite}
      onReorderFavorites={onReorderFavorites}
      selectedModelId={selection.model}
      selectedModelLabel={selected?.name ?? "Select model"}
      onModelChange={(modelId) => {
        const effort = defaultEffortFor(selection.agent, modelId, catalog);
        onSelectionChange({
          agent: selection.agent,
          model: modelId,
          ...(effort === "default" ? {} : { reasoningEffort: effort }),
        });
      }}
      onModelSelect={(model) => {
        const platform = model.platform as LaunchAgent;
        const effort = defaultEffortFor(platform, model.id, catalog);
        onSelectionChange({
          agent: platform,
          model: model.id,
          ...(effort === "default" ? {} : { reasoningEffort: effort }),
        });
      }}
      reasoningOptions={reasoningOptions}
      selectedReasoningId={reasoningId}
      selectedReasoningLabel={reasoningOptions.find((option) => option.id === reasoningId)?.label}
      onReasoningChange={(effort) =>
        onSelectionChange({
          agent: selection.agent,
          model: selection.model,
          ...(effort === "default" ? {} : { reasoningEffort: effort }),
        })
      }
      disabled={disabled}
      className="h-9 w-full max-w-none justify-start rounded-lg border border-border/70 bg-input-surface px-3 text-sm shadow-none hover:bg-elevated md:max-w-none md:flex-1"
    />
  );
}
