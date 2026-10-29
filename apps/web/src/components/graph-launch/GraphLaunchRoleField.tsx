import { Plus, Trash2 } from "lucide-react";
import { AGENT_PLATFORM_LABELS } from "@orkestrator/protocol/agent-platforms";
import type { GraphLaunchRoleOption } from "@orkestrator/protocol/graphs/launch";
import type { GraphModelBinding } from "@orkestrator/protocol/graphs/run";
import type { AgentModel } from "@orkestrator/protocol/native-agent";
import type { ReviewLensPreset } from "@orkestrator/protocol/review-lens";
import { AgentModelPicker } from "@/components/chat/AgentModelPicker";
import { ReviewLensField } from "@/components/review/ReviewLensField";
import { Button } from "@/components/ui/button";
import { useAgentModelFavorites } from "@/hooks/useAgentModelFavorites";
import {
  defaultEffortFor,
  firstModelFor,
  modelsForAgent,
  platformOwnsSpeed,
  type AgentModelCatalog,
} from "@/lib/agent-launch";
import { cn } from "@/lib/utils";
import {
  graphLaunchAvailablePlatforms,
  graphLaunchMember,
  graphLaunchTierLabel,
  type GraphLaunchMemberDraft,
} from "./graph-launch-model";

const TIER_CLASSES = {
  enforced: "text-emerald-400",
  "provider-configured": "text-amber-300",
  advisory: "text-red-300",
} as const;

/** A binding moved to `platform`, on that platform's first model. */
function onPlatform(
  binding: GraphModelBinding,
  platform: GraphModelBinding["platform"],
  catalog: AgentModelCatalog,
): GraphModelBinding {
  const model = firstModelFor(platform, catalog);
  const effort = defaultEffortFor(platform, model, catalog);
  return {
    platform,
    ...(model !== "default" ? { model } : {}),
    ...(effort !== "default" ? { reasoningEffort: effort } : {}),
    ...(binding.lens ? { lens: binding.lens } : {}),
  };
}

function MemberRow({
  option,
  member,
  label,
  catalog,
  models,
  lensPresets,
  onChange,
  onRemove,
}: {
  option: GraphLaunchRoleOption;
  member: GraphLaunchMemberDraft;
  label: string;
  catalog: AgentModelCatalog;
  models: AgentModel[];
  lensPresets: readonly ReviewLensPreset[];
  onChange: (binding: GraphModelBinding) => void;
  onRemove?: () => void;
}) {
  const { favorites, toggleFavorite, reorderFavorites } = useAgentModelFavorites();
  const binding = member.binding;
  const available = graphLaunchAvailablePlatforms(option);
  const offered = models.filter((model) => available.includes(model.platform));
  const selected = modelsForAgent(catalog, binding.platform).find(
    (model) => model.id === (binding.model ?? "default"),
  );
  const speedCapable = platformOwnsSpeed(binding.platform);
  const speedAvailable = speedCapable && selected?.supportsSpeed === true;
  const selectModel = (platform: GraphModelBinding["platform"], modelId: string) => {
    const effort = defaultEffortFor(platform, modelId, catalog);
    onChange({
      platform,
      ...(modelId !== "default" ? { model: modelId } : {}),
      ...(effort !== "default" ? { reasoningEffort: effort } : {}),
      ...(platform === binding.platform && typeof binding.fastMode === "boolean"
        ? { fastMode: binding.fastMode }
        : {}),
      ...(binding.lens ? { lens: binding.lens } : {}),
    });
  };
  const platformNotes = Object.fromEntries(
    option.providers.map((provider) => [
      provider.platform,
      `${graphLaunchTierLabel(provider)} for this role${provider.reason ? `: ${provider.reason}` : ""}`,
    ]),
  );
  return (
    <div className="min-w-0 rounded-md border border-border/60 p-2" data-graph-launch-member>
      <div className="mb-1.5 flex items-center gap-2">
        <label
          htmlFor={`graph-launch-provider-${member.key}`}
          className="text-[11px] font-semibold uppercase tracking-[0.12em] text-zinc-400"
        >
          {label}
        </label>
        <select
          id={`graph-launch-provider-${member.key}`}
          aria-label={`${label} provider`}
          value={binding.platform}
          onChange={(event) =>
            onChange(
              onPlatform(binding, event.target.value as GraphModelBinding["platform"], catalog),
            )
          }
          className="ml-auto h-7 min-w-0 rounded-md border border-zinc-700/80 bg-zinc-900 px-2 text-xs text-zinc-200"
        >
          {option.providers.map((provider) => (
            <option
              key={provider.platform}
              value={provider.platform}
              disabled={!provider.available}
            >
              {AGENT_PLATFORM_LABELS[provider.platform]} · {graphLaunchTierLabel(provider)}
              {provider.available ? "" : " (not offered)"}
            </option>
          ))}
        </select>
        {onRemove && (
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="size-7"
            onClick={onRemove}
            aria-label={`Remove ${label}`}
          >
            <Trash2 className="size-3.5" />
          </Button>
        )}
      </div>
      <AgentModelPicker
        ariaLabel={`${label} model`}
        models={offered}
        enabledPlatforms={available}
        selectedPlatform={binding.platform}
        platformNotes={platformNotes}
        favorites={favorites}
        onToggleFavorite={toggleFavorite}
        onReorderFavorites={reorderFavorites}
        selectedModelId={binding.model ?? "default"}
        selectedModelLabel={selected?.name ?? binding.model ?? "Default model"}
        onPlatformChange={(platform) => onChange(onPlatform(binding, platform, catalog))}
        onModelChange={(model) => selectModel(binding.platform, model)}
        onModelSelect={(model) => selectModel(model.platform, model.id)}
        reasoningOptions={(selected?.reasoningEfforts ?? []).map((effort) => ({
          id: effort,
          label: effort === "xhigh" ? "Extra high" : effort[0]!.toUpperCase() + effort.slice(1),
        }))}
        selectedReasoningId={binding.reasoningEffort ?? ""}
        selectedReasoningLabel={binding.reasoningEffort ?? "Default effort"}
        onReasoningChange={(reasoningEffort) => {
          const { reasoningEffort: _previous, ...rest } = binding;
          onChange(reasoningEffort ? { ...rest, reasoningEffort } : rest);
        }}
        speedCapable={speedCapable}
        fastModeAvailable={speedAvailable}
        fastModeEnabled={speedAvailable ? (binding.fastMode ?? false) : false}
        onFastModeChange={
          speedAvailable ? (fastMode) => onChange({ ...binding, fastMode }) : undefined
        }
        title={label}
        className="min-h-10 w-full border border-border/70 bg-input-surface py-2 md:max-w-none"
      />
      {option.panel && (
        <ReviewLensField
          id={`graph-launch-focus-${member.key}`}
          reviewerLabel={label}
          value={binding.lens}
          presets={lensPresets}
          onChange={(lens) => {
            const { lens: _previous, ...rest } = binding;
            onChange(lens ? { ...rest, lens } : rest);
          }}
        />
      )}
    </div>
  );
}

/**
 * One role's model picker (item 214): a provider select listing every
 * enabled provider with its enforcement tier for this role — the ones that
 * miss a node's floor or cannot return its typed results are disabled, and
 * why is listed under the role — and the shared model picker over the
 * offered providers' models. A panel role is a list of members (1 to
 * `maxPanel`), each with its own focus (item 005's lens field).
 */
export function GraphLaunchRoleField({
  option,
  members,
  catalog,
  models,
  lensPresets,
  onChange,
}: {
  option: GraphLaunchRoleOption;
  members: GraphLaunchMemberDraft[];
  catalog: AgentModelCatalog;
  models: AgentModel[];
  lensPresets: readonly ReviewLensPreset[];
  onChange: (members: GraphLaunchMemberDraft[]) => void;
}) {
  const label = option.role.label ?? option.role.key;
  const unavailable = option.providers.filter((provider) => !provider.available);
  const replace = (index: number, binding: GraphModelBinding) =>
    onChange(members.map((member, at) => (at === index ? { ...member, binding } : member)));
  return (
    <section
      aria-label={`Role ${label}`}
      className="space-y-2"
      data-graph-launch-role={option.role.key}
    >
      <div className="flex items-baseline gap-2">
        <h4 className="text-xs font-semibold text-foreground">{label}</h4>
        {option.floor && (
          <span className="text-[11px] text-muted-foreground">Floor: {option.floor}</span>
        )}
        {option.nodes.length === 0 && (
          <span className="text-[11px] text-muted-foreground">No step uses this role</span>
        )}
      </div>
      {option.role.description && (
        <p className="text-[11px] leading-snug text-muted-foreground">{option.role.description}</p>
      )}
      <div className="space-y-2">
        {members.map((member, index) => (
          <MemberRow
            key={member.key}
            option={option}
            member={member}
            label={option.panel ? `${label} ${index + 1}` : label}
            catalog={catalog}
            models={models}
            lensPresets={lensPresets}
            onChange={(binding) => replace(index, binding)}
            {...(option.panel && members.length > 1
              ? { onRemove: () => onChange(members.filter((_, at) => at !== index)) }
              : {})}
          />
        ))}
      </div>
      {option.panel && (
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={members.length >= option.maxPanel}
          onClick={() => {
            const fallback = graphLaunchAvailablePlatforms(option)[0] ?? "claude";
            const { lens: _lens, ...binding } = members[members.length - 1]?.binding ?? {
              platform: fallback,
            };
            onChange([...members, graphLaunchMember(binding)]);
          }}
        >
          <Plus className="size-3.5" />
          Add to {label} ({members.length}/{option.maxPanel})
        </Button>
      )}
      {unavailable.length > 0 && option.nodes.length > 0 && (
        <ul className="space-y-0.5" aria-label={`Providers not offered for ${label}`}>
          {unavailable.map((provider) => (
            <li
              key={provider.platform}
              className={cn("text-[11px] leading-snug", TIER_CLASSES[provider.tier])}
            >
              {AGENT_PLATFORM_LABELS[provider.platform]}:{" "}
              {provider.unavailableReason ?? "Not offered"}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
