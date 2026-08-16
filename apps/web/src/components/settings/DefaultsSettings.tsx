import { useMemo } from "react";
import {
  AlertTriangle,
  Eye,
  FolderPlus,
  GitPullRequest,
  RotateCcw,
  Upload,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { AgentModelPicker } from "@/components/chat/AgentModelPicker";
import { useAgentModelFavorites } from "@/hooks/useAgentModelFavorites";
import { useProjectModelCatalog } from "@/hooks/useBuildLaunchOptions";
import { useConfigStore, useUIStore } from "@/stores";
import {
  effortLabel,
  modelsForAgent,
  type AgentModelCatalog,
} from "@/lib/agent-launch";
import {
  ACTION_DEFAULT_KEYS,
  type ActionDefaultKey,
  type ActionDefaults,
  type AgentActionDefault,
} from "@orkestrator/protocol/action-defaults";
import {
  AGENT_PLATFORM_LABELS,
  firstEnabledAgentPlatform,
  normalizeAgentPlatforms,
  type AgentPlatform,
} from "@orkestrator/protocol/agent-platforms";
import type { AgentModel, AgentReasoningOption } from "@orkestrator/protocol/native-agent";

interface ActionDefaultDefinition {
  key: ActionDefaultKey;
  label: string;
  description: string;
  icon: React.ReactNode;
}

const ACTION_DEFAULT_DEFINITIONS: Record<ActionDefaultKey, ActionDefaultDefinition> = {
  newProject: {
    key: "newProject",
    label: "New projects",
    description:
      "Preselected when you create an environment in a project you have not launched an agent in yet. Once a project has a last-used selection, that wins.",
    icon: <FolderPlus className="h-4 w-4" />,
  },
  review: {
    key: "review",
    label: "Review",
    description: "Used by the Code Review button.",
    icon: <Eye className="h-4 w-4" />,
  },
  pr: {
    key: "pr",
    label: "PR",
    description: "Used by the Create PR button.",
    icon: <GitPullRequest className="h-4 w-4" />,
  },
  resolve: {
    key: "resolve",
    label: "Resolve",
    description: "Used by the Resolve button for merge conflicts.",
    icon: <AlertTriangle className="h-4 w-4" />,
  },
  push: {
    key: "push",
    label: "Push",
    description: "Used by the Push Changes button.",
    icon: <Upload className="h-4 w-4" />,
  },
};

interface ActionDefaultRowProps {
  definition: ActionDefaultDefinition;
  entry: AgentActionDefault | undefined;
  catalog: AgentModelCatalog;
  pickerModels: AgentModel[];
  enabledAgents: AgentPlatform[];
  fallbackAgent: AgentPlatform;
  favorites: ReturnType<typeof useAgentModelFavorites>;
  disabled: boolean;
  onChange: (entry: AgentActionDefault | undefined) => void;
}

function ActionDefaultRow({
  definition,
  entry,
  catalog,
  pickerModels,
  enabledAgents,
  fallbackAgent,
  favorites: { favorites, toggleFavorite, reorderFavorites },
  disabled,
  onChange,
}: ActionDefaultRowProps) {
  // A default naming a platform the user has since disabled is treated as
  // unset rather than silently retargeted: its model belongs to that platform.
  const platform =
    entry?.platform && enabledAgents.includes(entry.platform) ? entry.platform : undefined;
  const models = modelsForAgent(catalog, platform ?? fallbackAgent);
  const selectedModel = platform && entry?.model
    ? models.find((model) => model.id === entry.model)
    : undefined;
  const modelMissingFromCatalog = Boolean(platform && entry?.model && !selectedModel);

  const reasoningOptions = useMemo<AgentReasoningOption[]>(() => {
    if (!platform || !entry?.model) return [];
    const efforts = selectedModel?.reasoningEfforts ?? [];
    // A stored level the catalog no longer lists stays selectable, so opening
    // this pane cannot quietly rewrite a saved default to "default".
    const stored = entry.reasoningEffort;
    const ids = stored && !efforts.includes(stored) ? [...efforts, stored] : efforts;
    if (ids.length === 0) return [];
    return [
      { id: "default", label: "Default" },
      ...ids.map((effort) => ({ id: effort, label: effortLabel(effort) })),
    ];
  }, [entry?.model, entry?.reasoningEffort, platform, selectedModel]);

  const selectedReasoningId = entry?.reasoningEffort ?? "default";
  const modelLabel = !platform
    ? "App default"
    : `${AGENT_PLATFORM_LABELS[platform]} · ${
        entry?.model
          ? selectedModel?.name ?? entry.model
          : "Default model"
      }`;

  const pickerId = `action-default-${definition.key}`;

  return (
    <div className="space-y-2 rounded-lg border border-zinc-800 bg-zinc-950/50 p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="space-y-1">
          <Label
            htmlFor={pickerId}
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
          onClick={() => onChange(undefined)}
          disabled={disabled || !entry?.platform}
        >
          <RotateCcw className="h-3.5 w-3.5" />
          Clear
        </Button>
      </div>

      <AgentModelPicker
        id={pickerId}
        ariaLabel={`${definition.label} default agent, model and reasoning`}
        title="Choose agent, model, and reasoning"
        disabled={disabled}
        models={pickerModels}
        enabledPlatforms={enabledAgents}
        selectedPlatform={platform ?? fallbackAgent}
        favorites={favorites}
        onToggleFavorite={toggleFavorite}
        onReorderFavorites={reorderFavorites}
        // Switching provider on the rail alone selects that provider's own
        // default model rather than carrying the previous provider's model id.
        onPlatformChange={(nextPlatform) => onChange({ platform: nextPlatform })}
        selectedModelId={selectedModel?.id}
        selectedModelLabel={modelLabel}
        onModelChange={(nextModelId) =>
          onChange({ platform: platform ?? fallbackAgent, model: nextModelId })}
        // Provider and model move together; the reasoning level belongs to the
        // model, so choosing a new one resets it to that model's default.
        onModelSelect={(nextModel) =>
          onChange({ platform: nextModel.platform, model: nextModel.id })}
        reasoningOptions={reasoningOptions}
        selectedReasoningId={selectedReasoningId}
        selectedReasoningLabel={
          reasoningOptions.find((option) => option.id === selectedReasoningId)?.label
        }
        onReasoningChange={(nextReasoningId) =>
          onChange({
            platform: platform ?? fallbackAgent,
            ...(entry?.model ? { model: entry.model } : {}),
            ...(nextReasoningId === "default" ? {} : { reasoningEffort: nextReasoningId }),
          })}
        className="min-h-11 w-full max-w-none justify-start border border-zinc-700/80 bg-zinc-900 py-2.5 text-sm text-zinc-100 md:max-w-none md:flex-1"
      />

      {modelMissingFromCatalog && (
        <p className="text-xs text-amber-300">
          {entry?.model} is not in the current catalog. It is still saved and will be
          sent as-is; pick another model to replace it.
        </p>
      )}
      {platform && !entry?.model && (
        <p className="text-xs text-muted-foreground">
          Uses {AGENT_PLATFORM_LABELS[platform]}&apos;s own default model.
        </p>
      )}
    </div>
  );
}

interface DefaultsSettingsProps {
  actionDefaults: ActionDefaults;
  setActionDefaults: (actionDefaults: ActionDefaults) => void;
  isSaving: boolean;
}

/**
 * Application-level agent/model defaults for the toolbar actions that launch on
 * a plain click. Right-clicking those buttons still opens their launch dialog
 * and configures one run without touching anything set here.
 */
export function DefaultsSettings({
  actionDefaults,
  setActionDefaults,
  isSaving,
}: DefaultsSettingsProps) {
  const config = useConfigStore((state) => state.config);
  const selectedProjectId = useUIStore((state) => state.selectedProjectId);
  // Repository-scoped so an OpenCode catalog cached for the open project is
  // offered here too; the base Claude/Codex/Cursor/Grok catalogs are global.
  const catalog = useProjectModelCatalog(selectedProjectId ?? "", true);
  const favorites = useAgentModelFavorites();
  const enabledAgents = useMemo(
    () => normalizeAgentPlatforms(config.global.enabledAgentPlatforms),
    [config.global.enabledAgentPlatforms],
  );
  const fallbackAgent = firstEnabledAgentPlatform(
    enabledAgents,
    config.global.defaultAgent,
  );
  const pickerModels = useMemo<AgentModel[]>(
    () => enabledAgents.flatMap((platform) =>
      modelsForAgent(catalog, platform)
        // With no cached OpenCode catalog the builder synthesises a single
        // `default` entry. It is a UI placeholder no OpenCode server knows, and
        // the normalizer drops it, so offering it here would let the pane
        // propose a selection that silently disappears on save. Choosing
        // OpenCode on the rail alone already means "its own default model".
        .filter((option) => !(platform === "opencode" && option.id === "default"))
        .map((option) => ({
          platform,
          id: option.id,
          label: option.name,
          description: option.description,
        })),
    ),
    [catalog, enabledAgents],
  );

  return (
    <div className="max-w-3xl space-y-5">
      <div>
        <h3 className="text-sm font-medium text-foreground">Action defaults</h3>
        <p className="mt-1 max-w-2xl text-xs leading-relaxed text-muted-foreground">
          The agent, model and reasoning level each toolbar action uses when its
          button is clicked. Right-click (or long-press) a button to configure a
          single run instead — that never changes what is set here. Anything left
          on <span className="text-zinc-300">App default</span> keeps using the
          project or app default agent and its configured model.
        </p>
        <p className="mt-2 max-w-2xl text-xs leading-relaxed text-muted-foreground">
          These are application-level. An environment created with a specific
          agent keeps using that agent — the model and reasoning level set here
          then apply only if they name that same agent.
        </p>
      </div>

      <div className="space-y-3">
        {ACTION_DEFAULT_KEYS.map((key) => (
          <ActionDefaultRow
            key={key}
            definition={ACTION_DEFAULT_DEFINITIONS[key]}
            entry={actionDefaults[key]}
            catalog={catalog}
            pickerModels={pickerModels}
            enabledAgents={enabledAgents}
            fallbackAgent={fallbackAgent}
            favorites={favorites}
            disabled={isSaving}
            onChange={(entry) => {
              const next = { ...actionDefaults };
              if (entry) next[key] = entry;
              else delete next[key];
              setActionDefaults(next);
            }}
          />
        ))}
      </div>
    </div>
  );
}
