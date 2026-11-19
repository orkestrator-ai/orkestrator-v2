/**
 * Settings search: the field at the top of Settings, and the results or
 * Modified list shown in place of the section while it is in use. The section
 * stays mounted underneath (hidden), so an unsaved edit survives a search.
 */
import { useMemo, useRef, type KeyboardEvent, type RefObject } from "react";
import { AlertTriangle, ArrowRight, Search, SlidersHorizontal, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { SETTINGS_CATALOG, settingDescriptor } from "@/lib/settings-catalog/catalog";
import {
  describeSource,
  formatSettingValue,
  presentSetting,
  type SettingPresentation,
  type SourceNames,
} from "@/lib/settings-catalog/provenance";
import {
  SETTING_SCOPE_LABELS,
  SECTIONS_OUTSIDE_SHARED_FORM,
  settingScope,
} from "@/lib/settings-catalog/scope";
import { searchSettings, type SettingSearchResult } from "@/lib/settings-catalog/search";
import { SETTINGS_SECTION_LABELS } from "@/lib/settings-catalog/sections";
import type { SettingDescriptor, SettingScope } from "@/lib/settings-catalog/types";
import type { GlobalSettingsSection } from "@/lib/settings-navigation";
import { cn } from "@/lib/utils";
import { isWindowMachine } from "../account-machine";
import { useSettingsConfig } from "../settings-config";
import { SETTINGS_PAGE_DEFAULT_WIDTH_CLASS } from "../SettingsPageLayout";
import { OverrideBadge } from "./SettingField";
import { draftIsClean, useSettingsDraft, useSettingsExplain } from "./settings-explain";

export const SETTINGS_SEARCH_RESULTS_ID = "settings-search-results";

export function SettingsSearchField({
  id,
  query,
  onQueryChange,
  modifiedView,
  onModifiedViewChange,
  onOpenFirst,
  resultsRef,
  className,
}: {
  id: string;
  query: string;
  onQueryChange: (query: string) => void;
  modifiedView: boolean;
  onModifiedViewChange: (on: boolean) => void;
  onOpenFirst: () => void;
  resultsRef: RefObject<HTMLDivElement | null>;
  className?: string;
}) {
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Escape" && (query || modifiedView)) {
      // Clear the search rather than closing Settings.
      event.preventDefault();
      event.stopPropagation();
      onQueryChange("");
      onModifiedViewChange(false);
    } else if (event.key === "ArrowDown") {
      const first = resultsRef.current?.querySelector<HTMLElement>("[data-result-open]");
      if (first) {
        event.preventDefault();
        first.focus();
      }
    } else if (event.key === "Enter") {
      event.preventDefault();
      onOpenFirst();
    }
  };
  return (
    <div className={cn("flex items-center gap-1.5", className)}>
      <div className="relative min-w-0 flex-1">
        <Search
          className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground"
          aria-hidden="true"
        />
        <Input
          id={id}
          type="text"
          role="searchbox"
          aria-label="Search settings"
          aria-controls={query || modifiedView ? SETTINGS_SEARCH_RESULTS_ID : undefined}
          placeholder="Search"
          autoComplete="off"
          spellCheck={false}
          value={query}
          maxLength={120}
          onChange={(event) => onQueryChange(event.target.value)}
          onKeyDown={onKeyDown}
          className="h-9 pl-8 pr-7 text-sm md:h-8"
        />
        {query ? (
          <button
            type="button"
            aria-label="Clear search"
            onClick={() => onQueryChange("")}
            className="absolute right-1.5 top-1/2 flex h-6 w-6 -translate-y-1/2 items-center justify-center rounded text-muted-foreground hover:text-foreground"
          >
            <X className="h-3.5 w-3.5" aria-hidden="true" />
          </button>
        ) : null}
      </div>
      <Button
        type="button"
        variant={modifiedView ? "secondary" : "ghost"}
        size="icon"
        aria-pressed={modifiedView}
        aria-label="Show modified settings"
        title="Show modified settings"
        className="h-9 w-9 shrink-0 md:h-8 md:w-8"
        onClick={() => onModifiedViewChange(!modifiedView)}
      >
        <SlidersHorizontal className="h-3.5 w-3.5" aria-hidden="true" />
      </Button>
    </div>
  );
}

/** The results for `query`, in rank order. */
export function useSettingsSearchResults(query: string): SettingSearchResult[] {
  return useMemo(() => searchSettings(SETTINGS_CATALOG, query), [query]);
}

interface Row {
  readonly descriptor: SettingDescriptor;
  readonly hint?: string;
  readonly presentation: SettingPresentation | null;
}

export interface PendingOpen {
  /** Where navigation goes. */
  readonly descriptor: SettingDescriptor;
  readonly rank: number;
  /** The result chosen, when it is hidden and navigation goes to the setting that shows it. */
  readonly original?: SettingDescriptor;
}

export function SettingsSearchResults({
  mode,
  results,
  menuSections,
  activeSection,
  pendingConflict,
  onOpen,
  onConfirmOpen,
  onCancelOpen,
  onFixBlocker,
  onBackToField,
  onEscape,
  resultsRef,
}: {
  mode: "search" | "modified";
  results: readonly SettingSearchResult[];
  /** The sections the menu currently offers (experimental ones may be off). */
  menuSections: ReadonlySet<string>;
  activeSection: GlobalSettingsSection | "";
  /** A result whose opening would discard an unsaved edit, waiting for a decision. */
  pendingConflict: PendingOpen | null;
  onOpen: (open: PendingOpen) => void;
  onConfirmOpen: () => void;
  onCancelOpen: () => void;
  onFixBlocker: (section: string) => void;
  onBackToField: () => void;
  /** Escape inside the results: end the search and return to the field. */
  onEscape: () => void;
  resultsRef: RefObject<HTMLDivElement | null>;
}) {
  const { config } = useSettingsConfig();
  const explain = useSettingsExplain();
  const draft = useSettingsDraft();
  const machine = explain?.machine;
  const onWindowMachine = isWindowMachine(machine);
  const global = config.global;
  const sources = explain?.sources ?? null;
  const listRef = useRef<HTMLUListElement | null>(null);

  const rows: Row[] = useMemo(() => {
    const present = (descriptor: SettingDescriptor) =>
      // A command node's own setting is not this machine's value to show.
      settingScope(descriptor) === "command-node" && machine
        ? null
        : presentSetting(descriptor, global, sources);
    if (mode === "search") {
      return results.map((result) => ({
        descriptor: result.descriptor,
        hint:
          result.matchedIn === "alias" && result.matchedAlias
            ? `Matches “${result.matchedAlias}”`
            : undefined,
        presentation: present(result.descriptor),
      }));
    }
    // One stored value can back several fields; list each key once, plus every
    // field of it whose own value differs (a terminal font size, a mail limit).
    const byKey = new Map<string, Row[]>();
    for (const descriptor of SETTINGS_CATALOG) {
      const presentation = present(descriptor);
      if (!presentation) continue;
      const overridden =
        presentation.hasOverride === true ||
        (presentation.hasOverride === null && presentation.isDifferentFromDefault);
      if (!overridden) continue;
      const key = descriptor.value!.key;
      byKey.set(key, [...(byKey.get(key) ?? []), { descriptor, presentation }]);
    }
    const modified: Row[] = [];
    for (const [key, list] of byKey) {
      const differing = list.filter((row) => row.presentation?.isDifferentFromDefault);
      modified.push(
        ...(key === "agentSettings" || differing.length === 0 ? [list[0]!] : differing),
      );
    }
    return modified;
  }, [mode, results, global, sources, machine]);

  const sourcesUnknown =
    mode === "modified" &&
    (!sources ||
      sources.commandNode.status !== "ok" ||
      (sources.node !== null && sources.node.status !== "ok"));

  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    const buttons = Array.from(
      listRef.current?.querySelectorAll<HTMLElement>("[data-result-open]") ?? [],
    );
    const index = buttons.indexOf(document.activeElement as HTMLElement);
    if (index < 0) return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const next = index + (event.key === "ArrowDown" ? 1 : -1);
      if (next < 0) onBackToField();
      else buttons[Math.min(next, buttons.length - 1)]?.focus();
    } else if (event.key === "Home") {
      event.preventDefault();
      buttons[0]?.focus();
    } else if (event.key === "End") {
      event.preventDefault();
      buttons.at(-1)?.focus();
    }
  };

  const heading =
    mode === "modified"
      ? `${rows.length} modified setting${rows.length === 1 ? "" : "s"}`
      : `${rows.length} setting${rows.length === 1 ? "" : "s"} found`;

  return (
    <section
      id={SETTINGS_SEARCH_RESULTS_ID}
      ref={resultsRef}
      aria-label={mode === "modified" ? "Modified settings" : "Settings search results"}
      onKeyDown={(event) => {
        if (event.key === "Escape" && !event.defaultPrevented) {
          event.preventDefault();
          event.stopPropagation();
          onEscape();
        }
      }}
      className={cn("min-w-0 space-y-4 pb-8", SETTINGS_PAGE_DEFAULT_WIDTH_CLASS)}
    >
      <div className="space-y-1">
        <h2 className="text-xl font-semibold text-foreground">
          {mode === "modified" ? "Modified settings" : "Search results"}
        </h2>
        <p role="status" aria-live="polite" className="text-sm text-muted-foreground">
          {heading}
          {mode === "modified" && explain
            ? ` for ${explain.names.machine}. An override is a value stored explicitly, even when it equals the default.`
            : ""}
        </p>
      </div>

      {sourcesUnknown ? (
        <p className="flex items-start gap-1.5 text-xs text-amber-300">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          {!sources
            ? "Reading which settings are stored…"
            : "Which settings are stored could not be read, so this list shows values that differ from their defaults instead."}
        </p>
      ) : null}

      {draft.blocker && pendingConflict ? (
        <div
          role="alertdialog"
          aria-labelledby="settings-search-conflict-title"
          className="space-y-2 rounded-md border border-amber-400/30 bg-amber-400/[0.06] p-3 text-sm"
        >
          <p id="settings-search-conflict-title" className="text-amber-200">
            Your change in{" "}
            {SETTINGS_SECTION_LABELS[draft.blocker.section as GlobalSettingsSection] ??
              draft.blocker.section}{" "}
            cannot be saved yet: {draft.blocker.message}
          </p>
          <p className="text-xs text-muted-foreground">
            Opening {pendingConflict.descriptor.label} leaves the settings form, which discards that
            unsaved change.
          </p>
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              size="sm"
              autoFocus
              onClick={() => onFixBlocker(draft.blocker!.section)}
            >
              Fix the change first
            </Button>
            <Button type="button" size="sm" variant="outline" onClick={onConfirmOpen}>
              Discard it and open
            </Button>
            <Button type="button" size="sm" variant="ghost" onClick={onCancelOpen}>
              Cancel
            </Button>
          </div>
        </div>
      ) : null}

      {rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          {mode === "modified"
            ? "Nothing is stored that differs from how this machine would run by default."
            : "No setting matches. Try another word, such as “model”, “proxy” or “notifications”."}
        </p>
      ) : (
        <ul
          ref={listRef}
          className="divide-y divide-zinc-800 rounded-lg border border-zinc-800"
          onKeyDown={onKeyDown}
        >
          {rows.map((row, index) => {
            const { descriptor, presentation } = row;
            const unavailable =
              !menuSections.has(descriptor.section) ||
              (descriptor.availability &&
                !descriptor.availability.isAvailable({ global, isWindowMachine: onWindowMachine }));
            const reason = !menuSections.has(descriptor.section)
              ? (descriptor.availability?.reason ?? "This section is turned off.")
              : descriptor.availability?.reason;
            const scope = settingScope(descriptor);
            const scopeText = explain
              ? describeScope(scope, explain.names)
              : SETTING_SCOPE_LABELS[scope];
            return (
              <li key={descriptor.id} className="flex flex-wrap items-start gap-3 p-3">
                <button
                  type="button"
                  data-result-open={descriptor.id}
                  aria-describedby={`settings-result-${index}-meta`}
                  onClick={() => {
                    const via =
                      unavailable && descriptor.availability?.via
                        ? settingDescriptor(descriptor.availability.via)
                        : undefined;
                    onOpen(
                      via
                        ? { descriptor: via, rank: index, original: descriptor }
                        : { descriptor, rank: index },
                    );
                  }}
                  className="group flex min-w-0 flex-[1_1_18rem] flex-col items-start gap-1 rounded-md text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <span className="flex items-center gap-1.5 text-sm font-medium text-foreground">
                    {descriptor.label}
                    <ArrowRight
                      className="h-3.5 w-3.5 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100"
                      aria-hidden="true"
                    />
                  </span>
                  <span className="text-xs text-muted-foreground">{descriptor.description}</span>
                </button>
                <div
                  id={`settings-result-${index}-meta`}
                  className="flex min-w-0 flex-[1_1_14rem] flex-col items-start gap-1 text-[11px] text-muted-foreground"
                >
                  <span>
                    <span className="text-zinc-300">
                      {SETTINGS_SECTION_LABELS[descriptor.section]}
                    </span>
                    {" · "}
                    {scopeText}
                  </span>
                  {presentation && !descriptor.sensitive ? (
                    <span className="flex flex-wrap items-center gap-1.5">
                      <span>
                        {formatSettingValue(descriptor, presentation.effective)}
                        {explain
                          ? ` · ${describeSource(presentation.source, explain.names, descriptor)}`
                          : ""}
                      </span>
                      {presentation.hasOverride ? (
                        <OverrideBadge differs={presentation.isDifferentFromDefault} />
                      ) : null}
                    </span>
                  ) : null}
                  {row.hint ? <span>{row.hint}</span> : null}
                  {unavailable && reason ? (
                    <span className="text-amber-300">Not shown now: {reason}</span>
                  ) : null}
                  {descriptor.section === activeSection ? <span>On this page</span> : null}
                </div>
                {mode === "modified" &&
                presentation?.resettable &&
                presentation.hasOverride &&
                explain ? (
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    className="h-7 text-xs"
                    disabled={!draftIsClean(draft)}
                    aria-label={`Reset ${descriptor.label} to default`}
                    onClick={() => explain.requestReset(descriptor)}
                  >
                    Reset…
                  </Button>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

/** "Machine setting · Laptop", "Preference · Studio, inherited by every machine"… */
export function describeScope(scope: SettingScope, names: SourceNames): string {
  const commandNode = names.commandNode ?? names.machine;
  if (!names.federated) return scope === "window" ? "This window only" : `On ${names.machine}`;
  switch (scope) {
    case "machine":
      return `Machine setting · ${names.machine}`;
    case "inherited":
      return `Preference · ${commandNode}, inherited by every machine`;
    case "command-node":
      return `Command node · ${commandNode}`;
    case "window":
      return "This window only";
  }
}

/** Whether opening `descriptor` would leave the shared form while it holds an unsavable edit. */
export function openWouldDiscardDraft(
  descriptor: SettingDescriptor,
  activeSection: GlobalSettingsSection | "",
  blocked: boolean,
): boolean {
  if (!blocked || !activeSection) return false;
  const leavingForm =
    !SECTIONS_OUTSIDE_SHARED_FORM.has(activeSection) &&
    SECTIONS_OUTSIDE_SHARED_FORM.has(descriptor.section);
  return leavingForm;
}
