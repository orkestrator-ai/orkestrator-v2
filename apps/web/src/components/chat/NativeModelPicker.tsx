import { useMemo, useState } from "react";
import { ChevronDown, ChevronLeft, ChevronRight, RefreshCw, Zap } from "lucide-react";
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

export interface NativeModelPickerModel {
  id: string;
  label: string;
  description?: string;
  searchText?: string;
  favorite?: boolean;
}

export interface NativeModelPickerReasoningOption {
  id: string;
  label: string;
  description?: string;
  annotation?: string;
}

interface NativeModelPickerProps {
  models: NativeModelPickerModel[];
  selectedModelId?: string;
  selectedModelLabel: string;
  onModelChange: (modelId: string) => void;
  reasoningOptions: NativeModelPickerReasoningOption[];
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

function ModelItems({
  models,
  selectedModelId,
  disabled,
  onModelChange,
  emptyLabel = "No models available",
}: Pick<
  NativeModelPickerProps,
  "models" | "selectedModelId" | "disabled" | "onModelChange"
> & { emptyLabel?: string }) {
  if (models.length === 0) {
    return <DropdownMenuItem disabled>{emptyLabel}</DropdownMenuItem>;
  }

  return (
    <DropdownMenuRadioGroup
      value={selectedModelId ?? ""}
      onValueChange={onModelChange}
    >
      {models.map((model) => (
        <DropdownMenuRadioItem
          key={model.id}
          value={model.id}
          disabled={disabled}
          className={cn(MODEL_ROW_HEIGHT_CLASS, "items-start py-2")}
        >
          <span className="flex min-w-0 flex-1 flex-col gap-0.5">
            <span className="flex min-w-0 items-center gap-1.5">
              <span className="min-w-0 truncate text-sm font-medium">{model.label}</span>
              {model.favorite ? (
                <span className="shrink-0 rounded bg-zinc-800 px-1 py-0.5 text-[9px] uppercase tracking-wide text-muted-foreground">
                  Favorite
                </span>
              ) : null}
            </span>
            {model.description ? (
              <span className="truncate text-xs text-muted-foreground">
                {model.description}
              </span>
            ) : null}
          </span>
        </DropdownMenuRadioItem>
      ))}
    </DropdownMenuRadioGroup>
  );
}

function ReasoningItems({
  reasoningOptions,
  selectedReasoningId,
  disabled,
  onReasoningChange,
}: Pick<
  NativeModelPickerProps,
  "reasoningOptions" | "selectedReasoningId" | "disabled" | "onReasoningChange"
>) {
  if (reasoningOptions.length === 0) {
    return <DropdownMenuItem disabled>No reasoning options</DropdownMenuItem>;
  }

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
            <span className="truncate text-sm font-medium">
              {option.label}
              {option.annotation ? ` (${option.annotation})` : ""}
            </span>
            {option.description ? (
              <span className="line-clamp-2 text-xs text-muted-foreground">
                {option.description}
              </span>
            ) : null}
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
  NativeModelPickerProps,
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

export function NativeModelPicker({
  models,
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
}: NativeModelPickerProps) {
  const [search, setSearch] = useState("");
  const [mobileSubmenu, setMobileSubmenu] = useState<"reasoning" | "speed" | null>(null);
  const isMobile = useMediaQuery("(max-width: 767px)");
  const normalizedSearch = search.trim().toLowerCase();
  const visibleModels = useMemo(() => {
    const ordered = [...models].sort(
      (a, b) => Number(Boolean(b.favorite)) - Number(Boolean(a.favorite)),
    );
    if (!normalizedSearch) return ordered;
    return ordered.filter((model) =>
      `${model.label} ${model.id} ${model.description ?? ""} ${model.searchText ?? ""}`
        .toLowerCase()
        .includes(normalizedSearch),
    );
  }, [models, normalizedSearch]);
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

  return (
    <DropdownMenu
      onOpenChange={(open) => {
        if (!open) {
          setSearch("");
          setMobileSubmenu(null);
        }
      }}
    >
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          disabled={disabled}
          title={effectiveTitle}
          className="flex min-w-0 flex-1 items-center gap-1 rounded px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50 md:max-w-[320px] md:flex-none"
          aria-label={displayLabel}
        >
          <ChevronDown className="h-3 w-3 shrink-0" />
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
          <div className="animate-in slide-in-from-right-2 fade-in-0 duration-150">
            <DropdownMenuItem
              onSelect={(event) => {
                event.preventDefault();
                setMobileSubmenu(null);
              }}
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
          <div className="animate-in slide-in-from-right-2 fade-in-0 duration-150">
            <DropdownMenuItem
              onSelect={(event) => {
                event.preventDefault();
                setMobileSubmenu(null);
              }}
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
              Model
            </DropdownMenuLabel>
            <div className="max-h-70 overflow-y-auto overscroll-contain" data-native-model-list>
              <ModelItems
                models={visibleModels}
                selectedModelId={selectedModelId}
                disabled={disabled}
                onModelChange={onModelChange}
                emptyLabel={models.length > 0 ? "No matches" : "No models available"}
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
                  disabled={disabled}
                  onSelect={(event) => {
                    event.preventDefault();
                    setMobileSubmenu("reasoning");
                  }}
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
                  disabled={disabled}
                  onSelect={(event) => {
                    event.preventDefault();
                    setMobileSubmenu("speed");
                  }}
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
              "grid min-h-0 flex-1 divide-x divide-zinc-700/60",
              showReasoningControls && showSpeedControls
                ? "grid-cols-3"
                : showReasoningControls || showSpeedControls
                  ? "grid-cols-2"
                  : "grid-cols-1",
            )}
          >
            <div className="flex min-h-0 min-w-0 flex-col pr-1" role="group" aria-label="Models">
              <DropdownMenuLabel className="text-[10px] uppercase tracking-wider text-muted-foreground">
                Model
              </DropdownMenuLabel>
              <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain" data-native-model-list>
                <ModelItems
                  models={visibleModels}
                  selectedModelId={selectedModelId}
                  disabled={disabled}
                  onModelChange={onModelChange}
                  emptyLabel={models.length > 0 ? "No matches" : "No models available"}
                />
              </div>
              {moreModelCount > 0 ? (
                <div className="border-t border-zinc-700/50 px-2 py-1 text-center text-[10px] text-muted-foreground">
                  Scroll for {moreModelCount} more model{moreModelCount === 1 ? "" : "s"}
                </div>
              ) : null}
            </div>
            {showReasoningControls ? (
              <div className="min-w-0 px-1" role="group" aria-label="Reasoning">
                <DropdownMenuLabel className="text-[10px] uppercase tracking-wider text-muted-foreground">
                  Reasoning
                </DropdownMenuLabel>
                <ReasoningItems
                  reasoningOptions={reasoningOptions}
                  selectedReasoningId={selectedReasoningId}
                  disabled={disabled}
                  onReasoningChange={onReasoningChange}
                />
              </div>
            ) : null}
            {showSpeedControls ? (
              <div className="min-w-0 pl-1" role="group" aria-label="Speed mode">
                <DropdownMenuLabel className="text-[10px] uppercase tracking-wider text-muted-foreground">
                  Mode
                </DropdownMenuLabel>
                <SpeedItems
                  fastModeEnabled={fastModeEnabled}
                  fastModeAvailable={fastModeAvailable}
                  disabled={disabled}
                  onFastModeChange={onFastModeChange}
                />
              </div>
            ) : null}
          </div>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
