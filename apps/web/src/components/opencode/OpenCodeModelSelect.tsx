import { useEffect, useId, useMemo, useRef, useState } from "react";
import { Check, ChevronDown, Search, Star } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";

export interface OpenCodeModelSelectOption {
  id: string;
  name: string;
  description?: string;
}

interface OpenCodeModelSelectProps {
  id?: string;
  value: string;
  options: OpenCodeModelSelectOption[];
  favoriteModelIds?: string[];
  onValueChange: (value: string) => void;
  disabled?: boolean;
  className?: string;
}

export function filterAndOrderOpenCodeModels(
  options: OpenCodeModelSelectOption[],
  favoriteModelIds: string[],
  query: string,
): {
  favorites: OpenCodeModelSelectOption[];
  models: OpenCodeModelSelectOption[];
} {
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const matches = (option: OpenCodeModelSelectOption) =>
    !normalizedQuery ||
    option.name.toLocaleLowerCase().includes(normalizedQuery) ||
    option.id.toLocaleLowerCase().includes(normalizedQuery) ||
    option.description?.toLocaleLowerCase().includes(normalizedQuery);
  const byId = new Map(options.map((option) => [option.id, option]));
  const favoriteIds = new Set<string>();
  const favorites: OpenCodeModelSelectOption[] = [];

  for (const id of favoriteModelIds) {
    if (favoriteIds.has(id)) continue;
    favoriteIds.add(id);
    const option = byId.get(id);
    if (option && matches(option)) favorites.push(option);
  }

  const models = options
    .filter((option) => !favoriteIds.has(option.id) && matches(option))
    .sort((left, right) => {
      const providerOrder = (left.description ?? "").localeCompare(
        right.description ?? "",
      );
      return providerOrder || left.name.localeCompare(right.name);
    });

  return { favorites, models };
}

function ModelOption({
  id,
  option,
  selected,
  favorite,
  active,
  onActive,
  onSelect,
}: {
  id: string;
  option: OpenCodeModelSelectOption;
  selected: boolean;
  favorite: boolean;
  active: boolean;
  onActive: () => void;
  onSelect: () => void;
}) {
  return (
    <DropdownMenuItem
      id={id}
      role="menuitemradio"
      aria-checked={selected}
      data-active={active ? "" : undefined}
      onFocus={onActive}
      onPointerMove={(event) => {
        // Keep keyboard focus in the search field while still exposing a
        // pointer-highlighted result to assistive technology.
        event.preventDefault();
        onActive();
      }}
      onSelect={onSelect}
      className="items-start py-2 data-[active]:bg-zinc-800/80 data-[active]:text-foreground"
    >
      <span className="mt-0.5 grid size-4 shrink-0 place-items-center">
        {selected ? (
          <Check className="size-3.5 text-primary" />
        ) : favorite ? (
          <Star className="size-3.5 fill-amber-400/80 text-amber-400" />
        ) : null}
      </span>
      <span className="min-w-0">
        <span className="block truncate text-sm">{option.name}</span>
        <span className="block truncate text-[11px] text-muted-foreground">
          {option.id}
        </span>
      </span>
    </DropdownMenuItem>
  );
}

/**
 * Searchable OpenCode catalogue picker. Favorites are rendered as real rows at
 * the top, so a large OpenRouter catalogue does not require opening a nested
 * provider submenu before reaching the models the user has already pinned.
 */
export function OpenCodeModelSelect({
  id,
  value,
  options,
  favoriteModelIds = [],
  onValueChange,
  disabled = false,
  className,
}: OpenCodeModelSelectProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [activeModelId, setActiveModelId] = useState<string | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const generatedId = useId().replaceAll(":", "");
  const menuId = `${generatedId}-opencode-model-menu`;
  const selected = options.find((option) => option.id === value);
  const ordered = useMemo(
    () => filterAndOrderOpenCodeModels(options, favoriteModelIds, query),
    [favoriteModelIds, options, query],
  );
  const results = useMemo(
    () => [...ordered.favorites, ...ordered.models],
    [ordered],
  );
  const resultIndexes = useMemo(
    () => new Map(results.map((option, index) => [option.id, index])),
    [results],
  );
  const resultCount = results.length;
  const activeIndex = results.findIndex((option) => option.id === activeModelId);
  const activeOptionDomId =
    activeIndex >= 0 ? `${menuId}-option-${activeIndex}` : undefined;

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    queueMicrotask(() => {
      if (!cancelled) searchRef.current?.focus();
    });
    return () => {
      cancelled = true;
    };
  }, [open]);

  useEffect(() => {
    if (!activeOptionDomId) return;
    const activeElement = document.getElementById(activeOptionDomId);
    activeElement?.scrollIntoView?.({ block: "nearest" });
  }, [activeOptionDomId]);

  const closeMenu = () => {
    setOpen(false);
    setQuery("");
    setActiveModelId(null);
  };

  const selectModel = (modelId: string) => {
    onValueChange(modelId);
    closeMenu();
  };

  return (
    <DropdownMenu
      open={open}
      onOpenChange={(nextOpen) => {
        setOpen(nextOpen);
        setActiveModelId(null);
        if (!nextOpen) setQuery("");
      }}
    >
      <DropdownMenuTrigger asChild>
        <button
          id={id}
          type="button"
          role="combobox"
          aria-expanded={open}
          aria-controls={open ? menuId : undefined}
          disabled={disabled}
          className={cn(
            "border-input focus-visible:border-ring focus-visible:ring-ring/50 dark:bg-input/30 dark:hover:bg-input/50 flex h-9 w-full items-center justify-between gap-2 rounded-md border bg-transparent px-3 text-sm shadow-xs outline-none transition-[color,box-shadow] focus-visible:ring-[3px] disabled:cursor-not-allowed disabled:opacity-50",
            className,
          )}
        >
          <span className="truncate">
            {selected?.name ?? (options.length ? "Select model" : "No models cached")}
          </span>
          <ChevronDown className="size-4 shrink-0 text-muted-foreground opacity-50" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        id={menuId}
        align="start"
        collisionPadding={8}
        className="w-[min(24rem,calc(100vw-1rem))] p-0"
      >
        <div className="sticky top-0 z-10 border-b border-border/70 bg-zinc-900/95 p-2 backdrop-blur-sm">
          <div className="relative">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <input
              ref={searchRef}
              type="search"
              aria-label="Search OpenCode models"
              aria-controls={menuId}
              aria-activedescendant={activeOptionDomId}
              placeholder="Search models or providers…"
              value={query}
              onChange={(event) => {
                setQuery(event.target.value);
                setActiveModelId(null);
              }}
              onClick={(event) => event.stopPropagation()}
              onKeyDown={(event) => {
                if (event.key === "Escape") return;

                if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                  event.preventDefault();
                  event.stopPropagation();
                  if (resultCount === 0) return;

                  const nextIndex =
                    event.key === "ArrowDown"
                      ? activeIndex < 0
                        ? 0
                        : (activeIndex + 1) % resultCount
                      : activeIndex < 0
                        ? resultCount - 1
                        : (activeIndex - 1 + resultCount) % resultCount;
                  setActiveModelId(results[nextIndex]?.id ?? null);
                  return;
                }

                if (event.key === "Enter" && activeIndex >= 0) {
                  event.preventDefault();
                  event.stopPropagation();
                  const activeModel = results[activeIndex];
                  if (activeModel) selectModel(activeModel.id);
                  return;
                }

                // Radix implements menu typeahead on the content. Keep typed
                // characters, Space, and editing keys scoped to the search.
                event.stopPropagation();
              }}
              className="border-input bg-background h-8 w-full rounded-md border py-1 pl-8 pr-2 text-xs outline-none placeholder:text-muted-foreground/70 focus:border-ring focus:ring-2 focus:ring-ring/30"
            />
          </div>
          <p className="mt-1.5 px-0.5 text-[10px] text-muted-foreground">
            {resultCount} model{resultCount === 1 ? "" : "s"}
          </p>
        </div>

        <div className="max-h-72 overflow-y-auto p-1">
          {ordered.favorites.length > 0 && (
            <>
              <DropdownMenuLabel className="flex items-center gap-1.5 px-2 py-1 text-xs text-muted-foreground">
                <Star className="size-3 fill-amber-400/80 text-amber-400" />
                Favorites
              </DropdownMenuLabel>
              {ordered.favorites.map((option) => (
                <ModelOption
                  key={`favorite-${option.id}`}
                  id={`${menuId}-option-${resultIndexes.get(option.id) ?? -1}`}
                  option={option}
                  selected={option.id === value}
                  favorite
                  active={option.id === activeModelId}
                  onActive={() => setActiveModelId(option.id)}
                  onSelect={() => selectModel(option.id)}
                />
              ))}
              {ordered.models.length > 0 && <DropdownMenuSeparator />}
            </>
          )}

          {ordered.models.length > 0 && (
            <>
              {ordered.favorites.length > 0 && (
                <DropdownMenuLabel className="px-2 py-1 text-xs text-muted-foreground">
                  All models
                </DropdownMenuLabel>
              )}
              {ordered.models.map((option) => (
                <ModelOption
                  key={option.id}
                  id={`${menuId}-option-${resultIndexes.get(option.id) ?? -1}`}
                  option={option}
                  selected={option.id === value}
                  favorite={false}
                  active={option.id === activeModelId}
                  onActive={() => setActiveModelId(option.id)}
                  onSelect={() => selectModel(option.id)}
                />
              ))}
            </>
          )}

          {resultCount === 0 && (
            <p className="px-3 py-6 text-center text-sm text-muted-foreground">
              No matching models
            </p>
          )}
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
