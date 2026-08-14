import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, ChevronLeft, ChevronRight, RefreshCw, Star, Zap } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { useMediaQuery } from "@/hooks/useMediaQuery";
import type { AgentPlatform } from "@orkestrator/protocol/agent-platforms";
import type { AgentModel, AgentModelRef, AgentReasoningOption } from "@orkestrator/protocol/native-agent";
import { AgentPlatformIcon } from "@/components/icons/AgentIcons";

interface AgentModelPickerProps {
  id?: string;
  className?: string;
  ariaLabel?: string;
  models: AgentModel[];
  enabledPlatforms?: AgentPlatform[];
  selectedPlatform?: AgentPlatform;
  platformSelectionLocked?: boolean;
  favorites?: AgentModelRef[];
  onPlatformChange?: (platform: AgentPlatform) => void;
  onToggleFavorite?: (model: AgentModel) => void;
  selectedModelId?: string;
  selectedModelLabel: string;
  onModelChange: (modelId: string) => void;
  reasoningOptions: AgentReasoningOption[];
  selectedReasoningId?: string;
  selectedReasoningLabel?: string;
  onReasoningChange?: (reasoningId: string) => void;
  fastModeEnabled?: boolean | null;
  fastModeAvailable?: boolean;
  onFastModeChange?: (enabled: boolean) => void;
  disabled?: boolean;
  title?: string;
  onRefreshModels?: () => void;
}

const MODEL_ROW_HEIGHT_CLASS = "h-14";
const VISIBLE_MODEL_ROWS = 5;
type MobileSubmenu = "reasoning" | "speed";

const PLATFORM_LABELS: Record<AgentPlatform, string> = {
  claude: "Claude",
  codex: "Codex",
  opencode: "OpenCode",
  cursor: "Cursor",
  grok: "Grok",
};

function PlatformIcon({ platform }: { platform: AgentPlatform }) {
  return <AgentPlatformIcon platform={platform} className="size-4" />;
}

function ModelItems({
  models,
  selectedModelId,
  selectedPlatform,
  disabled,
  onModelChange,
  onPlatformChange,
  emptyLabel = "No models available",
  favorites = [],
  onToggleFavorite,
}: Pick<
  AgentModelPickerProps,
  "models" | "selectedModelId" | "selectedPlatform" | "disabled" | "onModelChange" | "onPlatformChange" | "favorites" | "onToggleFavorite"
> & { emptyLabel?: string }) {
  const favoriteKeys = new Set(favorites.map((favorite) => `${favorite.platform}:${favorite.modelId}`));
  const selectedModelKey = selectedModelId
    ? `${selectedPlatform ?? models.find((model) => model.id === selectedModelId)?.platform}:${selectedModelId}`
    : "";
  if (models.length === 0) {
    return <DropdownMenuItem disabled>{emptyLabel}</DropdownMenuItem>;
  }

  return (
    <DropdownMenuRadioGroup
      value={selectedModelKey}
      onValueChange={(modelKey) => {
        const model = models.find(
          (candidate) => `${candidate.platform}:${candidate.id}` === modelKey,
        );
        if (!model) return;
        onPlatformChange?.(model.platform);
        onModelChange(model.id);
      }}
    >
      {models.map((model) => {
        const modelKey = `${model.platform}:${model.id}`;
        const isFavorite = favoriteKeys.has(modelKey);
        return (
          <div key={modelKey} className="relative">
            <DropdownMenuRadioItem
              value={modelKey}
              disabled={disabled || model.description === "Unavailable in the current catalog"}
              className={cn(MODEL_ROW_HEIGHT_CLASS, "items-start py-2", onToggleFavorite && "pr-9")}
            >
              <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="flex min-w-0 items-center gap-1.5">
                  <span className="min-w-0 truncate text-sm font-medium">{model.label}</span>
                </span>
                <span className="truncate text-[10px] text-muted-foreground/80">
                  {model.providerLabel ?? PLATFORM_LABELS[model.platform]}
                </span>
              </span>
            </DropdownMenuRadioItem>
            {onToggleFavorite ? (
              <button
                type="button"
                aria-label={`${isFavorite ? "Remove" : "Add"} ${model.label} ${isFavorite ? "from" : "to"} favorites`}
                aria-pressed={isFavorite}
                onPointerDown={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                }}
                onClick={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  onToggleFavorite(model);
                }}
                className="absolute right-1 top-1/2 z-10 -translate-y-1/2 rounded p-1 text-muted-foreground hover:text-amber-400"
              >
                <Star className={cn("size-3.5", isFavorite && "fill-amber-400 text-amber-400")} />
              </button>
            ) : null}
          </div>
        );
      })}
    </DropdownMenuRadioGroup>
  );
}

function ReasoningItems({
  reasoningOptions,
  selectedReasoningId,
  disabled,
  onReasoningChange,
}: Pick<
  AgentModelPickerProps,
  "reasoningOptions" | "selectedReasoningId" | "disabled" | "onReasoningChange"
>) {
  return (
    <DropdownMenuRadioGroup
      value={selectedReasoningId ?? ""}
      onValueChange={(reasoningId) => onReasoningChange?.(reasoningId)}
    >
      {reasoningOptions.map((option) => (
        <DropdownMenuRadioItem
          key={option.id}
          value={option.id}
          disabled={disabled || !onReasoningChange}
          className="items-start py-2"
        >
          <span className="flex min-w-0 flex-1 flex-col gap-0.5">
            <span className="truncate text-sm font-medium">{option.label}</span>
          </span>
        </DropdownMenuRadioItem>
      ))}
    </DropdownMenuRadioGroup>
  );
}

function SpeedItems({
  fastModeEnabled = false,
  fastModeAvailable = false,
  disabled,
  onFastModeChange,
}: Pick<
  AgentModelPickerProps,
  "fastModeEnabled" | "fastModeAvailable" | "disabled" | "onFastModeChange"
>) {
  const canChange = fastModeAvailable && Boolean(onFastModeChange) && !disabled;

  return (
    <DropdownMenuRadioGroup
      value={fastModeEnabled === null ? "" : fastModeEnabled ? "fast" : "normal"}
      onValueChange={(value) => onFastModeChange?.(value === "fast")}
    >
      <DropdownMenuRadioItem
        value="normal"
        disabled={!canChange}
      >
        <span className="flex min-w-0 flex-col">
          <span>Normal</span>
          <span className="text-xs text-muted-foreground">Standard speed and credit rate</span>
        </span>
      </DropdownMenuRadioItem>
      <DropdownMenuRadioItem
        value="fast"
        disabled={!canChange}
      >
        <span className="flex min-w-0 flex-col">
          <span className="flex items-center gap-1">
            Fast <Zap className={cn("h-3 w-3 text-amber-500", fastModeEnabled && "fill-current")} />
          </span>
          <span className="text-xs text-muted-foreground">
            {fastModeAvailable ? "Lower latency, higher credit rate" : "Not available for this model"}
          </span>
        </span>
      </DropdownMenuRadioItem>
    </DropdownMenuRadioGroup>
  );
}

export function AgentModelPicker({
  id,
  className,
  ariaLabel,
  models,
  enabledPlatforms,
  selectedPlatform,
  platformSelectionLocked = false,
  favorites = [],
  onPlatformChange,
  onToggleFavorite,
  selectedModelId,
  selectedModelLabel,
  onModelChange,
  reasoningOptions,
  selectedReasoningId,
  selectedReasoningLabel,
  onReasoningChange,
  fastModeEnabled = false,
  fastModeAvailable = false,
  onFastModeChange,
  disabled = false,
  title,
  onRefreshModels,
}: AgentModelPickerProps) {
  const [search, setSearch] = useState("");
  const [catalogView, setCatalogView] = useState<AgentPlatform | "favorites">(
    selectedPlatform ?? models[0]?.platform ?? "favorites",
  );
  const [mobileSubmenu, setMobileSubmenu] = useState<MobileSubmenu | null>(null);
  const mobileViewId = useId();
  const mobileReasoningTriggerRef = useRef<HTMLDivElement>(null);
  const mobileSpeedTriggerRef = useRef<HTMLDivElement>(null);
  const mobileReasoningBackRef = useRef<HTMLDivElement>(null);
  const mobileSpeedBackRef = useRef<HTMLDivElement>(null);
  const mobileReturnFocusRef = useRef<MobileSubmenu | null>(null);
  const isMobile = useMediaQuery("(max-width: 767px)");
  const normalizedSearch = search.trim().toLowerCase();
  const availablePlatforms = useMemo(
    () => enabledPlatforms ?? Array.from(new Set(models.map((model) => model.platform))),
    [enabledPlatforms, models],
  );
  useEffect(() => {
    if (selectedPlatform) setCatalogView(selectedPlatform);
  }, [selectedPlatform]);
  const visibleModels = useMemo(() => {
    const byKey = new Map(models.map((model) => [`${model.platform}:${model.id}`, model]));
    const ordered = catalogView === "favorites"
      ? favorites.map((favorite) => byKey.get(`${favorite.platform}:${favorite.modelId}`) ?? {
          platform: favorite.platform,
          id: favorite.modelId,
          label: favorite.modelId,
          description: "Unavailable in the current catalog",
        })
      : models.filter((model) => model.platform === catalogView);
    if (!normalizedSearch) return ordered;
    return ordered.filter((model) =>
      `${model.label} ${model.id} ${model.description ?? ""} ${model.platform}`
        .toLowerCase()
        .includes(normalizedSearch),
    );
  }, [catalogView, favorites, models, normalizedSearch]);
  const triggerPlatform = selectedPlatform
    ?? models.find((model) => model.id === selectedModelId)?.platform
    ?? models[0]?.platform;
  const fastModeUnknown = fastModeEnabled === null;
  const showReasoningControls = reasoningOptions.length > 0;
  const displayLabel = selectedReasoningLabel
    ? `${selectedModelLabel} (${selectedReasoningLabel}${fastModeEnabled ? " ⚡" : ""}${fastModeUnknown ? "; speed unknown" : ""})`
    : `${selectedModelLabel}${fastModeEnabled ? " (⚡)" : fastModeUnknown ? " (speed unknown)" : ""}`;
  const moreModelCount = Math.max(0, visibleModels.length - VISIBLE_MODEL_ROWS);
  const showSpeedControls = Boolean(onFastModeChange);
  const choiceLabels = [
    "model",
    showReasoningControls ? "reasoning" : null,
    showSpeedControls ? "speed" : null,
  ].filter((label): label is string => label !== null);
  const choiceLabel = choiceLabels.length === 1
    ? choiceLabels[0]
    : `${choiceLabels.slice(0, -1).join(", ")}${choiceLabels.length > 2 ? "," : ""} and ${choiceLabels.at(-1)}`;
  const effectiveTitle = title ?? `Choose ${choiceLabel}`;

  const openMobileSubmenu = (submenu: MobileSubmenu) => {
    mobileReturnFocusRef.current = null;
    setMobileSubmenu(submenu);
  };
  const closeMobileSubmenu = (submenu: MobileSubmenu) => {
    mobileReturnFocusRef.current = submenu;
    setMobileSubmenu(null);
  };

  useLayoutEffect(() => {
    if (!isMobile) return;

    if (mobileSubmenu === "reasoning") {
      mobileReasoningBackRef.current?.focus();
      return;
    }
    if (mobileSubmenu === "speed") {
      mobileSpeedBackRef.current?.focus();
      return;
    }

    const returnTarget = mobileReturnFocusRef.current;
    mobileReturnFocusRef.current = null;
    if (returnTarget === "reasoning") {
      mobileReasoningTriggerRef.current?.focus();
    } else if (returnTarget === "speed") {
      mobileSpeedTriggerRef.current?.focus();
    }
  }, [isMobile, mobileSubmenu]);

  return (
    <DropdownMenu
      onOpenChange={(open) => {
        if (!open) {
          setSearch("");
          setMobileSubmenu(null);
          mobileReturnFocusRef.current = null;
        }
      }}
    >
      <DropdownMenuTrigger asChild>
        <button
          id={id}
          role={id ? "combobox" : undefined}
          type="button"
          disabled={disabled}
          title={effectiveTitle}
          className={cn(
            "flex min-w-0 flex-1 items-center gap-1 rounded px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50 md:max-w-[320px] md:flex-none",
            className,
          )}
          aria-label={ariaLabel ?? displayLabel}
        >
          <ChevronDown className="h-3 w-3 shrink-0" />
          {triggerPlatform ? (
            <span
              data-native-model-platform={triggerPlatform}
              className="flex shrink-0"
              aria-hidden="true"
            >
              <AgentPlatformIcon platform={triggerPlatform} accent className="size-3.5" />
            </span>
          ) : null}
          <span className="flex min-w-0 truncate">
            <span className="truncate">{selectedModelLabel}</span>
            {selectedReasoningLabel ? (
              <span className="flex shrink-0">
                <span>&nbsp;(</span>
                <span>{selectedReasoningLabel}</span>
                {fastModeEnabled ? <span>&nbsp;⚡</span> : null}
                {fastModeUnknown ? <span>&nbsp;? speed</span> : null}
                <span>)</span>
              </span>
            ) : fastModeEnabled ? (
              <span className="shrink-0">&nbsp;(⚡)</span>
            ) : null}
          </span>
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        collisionPadding={{ top: 52, right: 8, bottom: 8, left: 8 }}
        className="w-[calc(100vw-1rem)] max-w-[calc(100vw-1rem)] md:flex md:h-[23.5rem] md:w-[min(46rem,calc(100vw-2rem))] md:max-w-[calc(100vw-2rem)] md:flex-col md:overflow-hidden"
        data-native-model-picker
      >
        {!isMobile || mobileSubmenu === null ? (
          <div className="flex items-center gap-1 p-1 pb-2">
            <input
              type="text"
              placeholder="Search models..."
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              onClick={(event) => event.stopPropagation()}
              onKeyDown={(event) => {
                if (event.key !== "Escape") event.stopPropagation();
              }}
              className="h-8 min-w-0 flex-1 rounded-lg border border-border bg-background px-2 text-xs placeholder:text-muted-foreground/60 focus:outline-none focus:ring-1 focus:ring-ring"
            />
            {onRefreshModels ? (
              <button
                type="button"
                onClick={(event) => {
                  event.stopPropagation();
                  onRefreshModels();
                }}
                className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-border bg-background text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                title="Refresh models"
              >
                <RefreshCw className="h-3.5 w-3.5" />
              </button>
            ) : null}
          </div>
        ) : null}

        {normalizedSearch && (!isMobile || mobileSubmenu === null) ? (
          <div className="px-2 pb-1 text-[10px] text-muted-foreground">
            {visibleModels.length} model{visibleModels.length === 1 ? "" : "s"} found
          </div>
        ) : null}

        {/* Mobile uses touch-friendly pop-out choices. Desktop keeps all three
            choices visible while the model list fills the fixed-height menu. */}
        {isMobile && mobileSubmenu === "reasoning" ? (
          <div
            id={`${mobileViewId}-reasoning`}
            role="group"
            aria-label="Reasoning choices"
            className="animate-in slide-in-from-right-2 fade-in-0 duration-150"
            data-native-mobile-reasoning-view
            onKeyDown={(event) => {
              if (event.key !== "ArrowLeft") return;
              event.preventDefault();
              event.stopPropagation();
              closeMobileSubmenu("reasoning");
            }}
          >
            <DropdownMenuItem
              ref={mobileReasoningBackRef}
              onSelect={(event) => {
                event.preventDefault();
                closeMobileSubmenu("reasoning");
              }}
              aria-label="Back to model choices"
              className="h-11"
              data-native-mobile-back
            >
              <ChevronLeft className="h-4 w-4" />
              <span className="font-medium">Reasoning</span>
              <span className="ml-auto truncate text-xs text-muted-foreground">
                {selectedReasoningLabel}
              </span>
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <ReasoningItems
              reasoningOptions={reasoningOptions}
              selectedReasoningId={selectedReasoningId}
              disabled={disabled}
              onReasoningChange={onReasoningChange}
            />
          </div>
        ) : isMobile && mobileSubmenu === "speed" ? (
          <div
            id={`${mobileViewId}-speed`}
            role="group"
            aria-label="Speed choices"
            className="animate-in slide-in-from-right-2 fade-in-0 duration-150"
            data-native-mobile-speed-view
            onKeyDown={(event) => {
              if (event.key !== "ArrowLeft") return;
              event.preventDefault();
              event.stopPropagation();
              closeMobileSubmenu("speed");
            }}
          >
            <DropdownMenuItem
              ref={mobileSpeedBackRef}
              onSelect={(event) => {
                event.preventDefault();
                closeMobileSubmenu("speed");
              }}
              aria-label="Back to model choices"
              className="h-11"
              data-native-mobile-back
            >
              <ChevronLeft className="h-4 w-4" />
              <span className="flex items-center gap-1 font-medium">
                Fast mode <Zap className="h-3 w-3 text-amber-500" />
              </span>
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <SpeedItems
              fastModeEnabled={fastModeEnabled}
              fastModeAvailable={fastModeAvailable}
              disabled={disabled}
              onFastModeChange={onFastModeChange}
            />
          </div>
        ) : isMobile ? (
          <div>
            <DropdownMenuLabel className="text-[10px] uppercase tracking-wider text-muted-foreground">
              Agent
            </DropdownMenuLabel>
            <div
              className="flex max-w-full gap-1 overflow-x-auto px-2 pb-2"
              role="group"
              aria-label="Agent platforms"
              data-native-mobile-platforms
            >
              <button
                type="button"
                aria-label="Favorite models"
                aria-pressed={catalogView === "favorites"}
                onClick={(event) => {
                  event.preventDefault();
                  setCatalogView("favorites");
                }}
                className={cn(
                  "grid size-8 shrink-0 place-items-center rounded",
                  catalogView === "favorites"
                    ? "bg-muted text-amber-400"
                    : "text-muted-foreground hover:bg-muted/60",
                )}
              >
                <Star className="size-4" />
              </button>
              {availablePlatforms.map((availablePlatform) => (
                <button
                  key={availablePlatform}
                  type="button"
                  aria-label={`${availablePlatform} models`}
                  aria-pressed={catalogView === availablePlatform}
                  disabled={platformSelectionLocked && availablePlatform !== selectedPlatform}
                  onClick={(event) => {
                    event.preventDefault();
                    setSearch("");
                    setCatalogView(availablePlatform);
                    onPlatformChange?.(availablePlatform);
                  }}
                  className={cn(
                    "grid size-8 shrink-0 place-items-center rounded disabled:cursor-not-allowed disabled:opacity-30",
                    catalogView === availablePlatform
                      ? "bg-muted text-foreground"
                      : "text-muted-foreground hover:bg-muted/60",
                  )}
                >
                  <PlatformIcon platform={availablePlatform} />
                </button>
              ))}
            </div>
            <DropdownMenuLabel className="text-[10px] uppercase tracking-wider text-muted-foreground">
              Model
            </DropdownMenuLabel>
            <div className="max-h-70 overflow-y-auto overscroll-contain" data-native-model-list>
              <ModelItems
                models={visibleModels}
                selectedModelId={selectedModelId}
                selectedPlatform={selectedPlatform}
                disabled={disabled}
                onModelChange={onModelChange}
                onPlatformChange={onPlatformChange}
                emptyLabel={normalizedSearch ? "No matches" : "No models available"}
                favorites={favorites}
                onToggleFavorite={onToggleFavorite}
              />
            </div>
            {moreModelCount > 0 ? (
              <div className="border-t border-zinc-700/50 px-2 py-1 text-center text-[10px] text-muted-foreground">
                Scroll for {moreModelCount} more model{moreModelCount === 1 ? "" : "s"}
              </div>
            ) : null}

            {showReasoningControls ? (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  ref={mobileReasoningTriggerRef}
                  disabled={disabled}
                  onSelect={(event) => {
                    event.preventDefault();
                    openMobileSubmenu("reasoning");
                  }}
                  onKeyDown={(event) => {
                    if (event.key !== "ArrowRight") return;
                    event.preventDefault();
                    event.stopPropagation();
                    openMobileSubmenu("reasoning");
                  }}
                  aria-haspopup="menu"
                  aria-expanded={mobileSubmenu === "reasoning"}
                  aria-controls={`${mobileViewId}-reasoning`}
                  className="h-11"
                  data-native-mobile-reasoning-trigger
                >
                  <span className="flex min-w-0 flex-1 items-center justify-between gap-2">
                    <span>Reasoning</span>
                    <span className="truncate text-xs text-muted-foreground">
                      {selectedReasoningLabel}
                    </span>
                  </span>
                  <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
                </DropdownMenuItem>
              </>
            ) : null}

            {showSpeedControls ? (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  ref={mobileSpeedTriggerRef}
                  disabled={disabled}
                  onSelect={(event) => {
                    event.preventDefault();
                    openMobileSubmenu("speed");
                  }}
                  onKeyDown={(event) => {
                    if (event.key !== "ArrowRight") return;
                    event.preventDefault();
                    event.stopPropagation();
                    openMobileSubmenu("speed");
                  }}
                  aria-haspopup="menu"
                  aria-expanded={mobileSubmenu === "speed"}
                  aria-controls={`${mobileViewId}-speed`}
                  className="h-11"
                  data-native-mobile-speed-trigger
                >
                  <span className="flex min-w-0 flex-1 items-center justify-between gap-2">
                    <span className="flex items-center gap-1">
                      Fast <Zap className="h-3 w-3 text-amber-500" />
                    </span>
                    <span className="truncate text-xs text-muted-foreground">
                      {!fastModeAvailable
                        ? "Unavailable"
                        : fastModeEnabled === null
                          ? "Unknown"
                          : fastModeEnabled
                            ? "On"
                            : "Off"}
                    </span>
                  </span>
                  <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
                </DropdownMenuItem>
              </>
            ) : null}
          </div>
        ) : (
          <div
            className={cn(
              "grid min-h-0 flex-1 overflow-hidden divide-x divide-zinc-700/60",
              showReasoningControls && showSpeedControls
                ? "grid-cols-[3rem_repeat(3,minmax(0,1fr))]"
                : showReasoningControls || showSpeedControls
                  ? "grid-cols-[3rem_repeat(2,minmax(0,1fr))]"
                  : "grid-cols-[3rem_minmax(0,1fr)]",
            )}
          >
            <div className="flex min-h-0 flex-col items-center gap-1 pr-1" aria-label="Agent platforms">
              <button
                type="button"
                aria-label="Favorite models"
                aria-pressed={catalogView === "favorites"}
                onClick={(event) => {
                  event.preventDefault();
                  setCatalogView("favorites");
                }}
                className={cn("grid size-8 place-items-center rounded", catalogView === "favorites" ? "bg-muted text-amber-400" : "text-muted-foreground hover:bg-muted/60")}
              >
                <Star className="size-4" />
              </button>
              <div className="my-1 h-px w-6 bg-border" />
              {availablePlatforms.map((platform) => (
                <button
                  key={platform}
                  type="button"
                  aria-label={`${platform} models`}
                  aria-pressed={catalogView === platform}
                  disabled={platformSelectionLocked && platform !== selectedPlatform}
                  onClick={(event) => {
                    event.preventDefault();
                    setCatalogView(platform);
                    onPlatformChange?.(platform);
                  }}
                  className={cn(
                    "grid size-8 place-items-center rounded disabled:cursor-not-allowed disabled:opacity-30",
                    catalogView === platform
                      ? "bg-muted text-foreground"
                      : "text-muted-foreground hover:bg-muted/60",
                  )}
                >
                  <PlatformIcon platform={platform} />
                </button>
              ))}
            </div>
            <div className="flex min-h-0 min-w-0 flex-col pr-1" role="group" aria-label="Models">
              <DropdownMenuLabel className="text-[10px] uppercase tracking-wider text-muted-foreground">
                Model
              </DropdownMenuLabel>
              <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain" data-native-model-list>
                <ModelItems
                  models={visibleModels}
                  selectedModelId={selectedModelId}
                  selectedPlatform={selectedPlatform}
                  disabled={disabled}
                  onModelChange={onModelChange}
                  onPlatformChange={onPlatformChange}
                  emptyLabel={models.length > 0 ? "No matches" : "No models available"}
                  favorites={favorites}
                  onToggleFavorite={onToggleFavorite}
                />
              </div>
              {moreModelCount > 0 ? (
                <div className="border-t border-zinc-700/50 px-2 py-1 text-center text-[10px] text-muted-foreground">
                  Scroll for {moreModelCount} more model{moreModelCount === 1 ? "" : "s"}
                </div>
              ) : null}
            </div>
            {showReasoningControls ? (
              <div
                className="flex min-h-0 min-w-0 flex-col px-1"
                role="group"
                aria-label="Reasoning"
              >
                <DropdownMenuLabel className="shrink-0 text-[10px] uppercase tracking-wider text-muted-foreground">
                  Reasoning
                </DropdownMenuLabel>
                <div
                  className="min-h-0 flex-1 overflow-y-auto overscroll-contain"
                  data-native-reasoning-list
                >
                  <ReasoningItems
                    reasoningOptions={reasoningOptions}
                    selectedReasoningId={selectedReasoningId}
                    disabled={disabled}
                    onReasoningChange={onReasoningChange}
                  />
                </div>
              </div>
            ) : null}
            {showSpeedControls ? (
              <div
                className="flex min-h-0 min-w-0 flex-col pl-1"
                role="group"
                aria-label="Speed mode"
              >
                <DropdownMenuLabel className="shrink-0 text-[10px] uppercase tracking-wider text-muted-foreground">
                  Mode
                </DropdownMenuLabel>
                <div
                  className="min-h-0 flex-1 overflow-y-auto overscroll-contain"
                  data-native-speed-list
                >
                  <SpeedItems
                    fastModeEnabled={fastModeEnabled}
                    fastModeAvailable={fastModeAvailable}
                    disabled={disabled}
                    onFastModeChange={onFastModeChange}
                  />
                </div>
              </div>
            ) : null}
          </div>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
