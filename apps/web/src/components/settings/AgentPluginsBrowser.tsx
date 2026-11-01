import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, Loader2, RefreshCw, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import * as backend from "@/lib/backend";
import type {
  AccountMachine,
  AgentExtensionItem,
  AgentPluginCatalog,
  AgentSkill,
  AgentSkillProvider,
} from "@/lib/backend";
import { cn } from "@/lib/utils";

const STATUS_LABELS: Record<AgentExtensionItem["status"], string> = {
  connected: "Connected",
  configured: "Enabled",
  disabled: "Disabled",
  failed: "Failed",
  pending: "Pending",
};

export interface AgentPluginsState {
  catalog?: AgentPluginCatalog;
  loading: boolean;
  error?: string;
}

/** IPC responses are untrusted at runtime, and an empty list is a claim about the machine. */
function normalizePluginCatalog(value: unknown, provider: AgentSkillProvider): AgentPluginCatalog {
  const candidate = value as Partial<AgentPluginCatalog> | null;
  if (!Array.isArray(candidate?.plugins)) {
    throw new Error("The backend returned an unreadable plugin list");
  }
  return {
    agent: provider,
    plugins: candidate.plugins,
    ...(candidate.pluginError ? { pluginError: candidate.pluginError } : {}),
  };
}

/**
 * Loads a provider's plugins the first time they are shown, then keeps them until
 * a reload. Unlike the skill scan this starts the agent's CLI, so a tab visit does
 * not repeat it and nothing runs for someone who never opens the view. The page
 * remounts per machine, so results here never outlive the machine they came from.
 */
export function useAgentPlugins(
  provider: AgentSkillProvider,
  machine: AccountMachine,
  enabled: boolean,
) {
  const [states, setStates] = useState<Record<string, AgentPluginsState>>({});
  const tokens = useRef<Record<string, number>>({});
  const requested = useRef<Set<string>>(new Set());

  const load = useCallback(
    async (target: AgentSkillProvider) => {
      const token = (tokens.current[target] ?? 0) + 1;
      tokens.current[target] = token;
      requested.current.add(target);
      setStates((prev) => ({
        ...prev,
        [target]: { ...prev[target], loading: true, error: undefined },
      }));
      try {
        const catalog = normalizePluginCatalog(
          await backend.listAgentPlugins(target, machine),
          target,
        );
        if (tokens.current[target] !== token) return;
        setStates((prev) => ({ ...prev, [target]: { catalog, loading: false } }));
      } catch (err) {
        if (tokens.current[target] !== token) return;
        // A failed read is not a result to keep; the next visit tries again.
        requested.current.delete(target);
        setStates((prev) => ({
          ...prev,
          [target]: {
            ...prev[target],
            loading: false,
            error: err instanceof Error ? err.message : String(err),
          },
        }));
      }
    },
    [machine],
  );

  useEffect(() => {
    if (enabled && !requested.current.has(provider)) void load(provider);
  }, [enabled, provider, load]);

  const reload = useCallback(() => void load(provider), [load, provider]);
  return { state: states[provider] ?? { loading: enabled }, reload };
}

interface AgentPluginsBrowserProps {
  state: AgentPluginsState;
  onReload: () => void;
  /** The provider's scanned skills; undefined until a scan has completed. */
  skills: AgentSkill[] | undefined;
  onOpenSkill: (skill: AgentSkill) => void;
}

export function AgentPluginsBrowser({
  state,
  onReload,
  skills,
  onOpenSkill,
}: AgentPluginsBrowserProps) {
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);

  // Two marketplaces can publish the same plugin name, so the name alone is not a key.
  const plugins = useMemo(
    () =>
      (state.catalog?.plugins ?? []).map((item, index) => ({
        item,
        id: `${item.name}:${item.source ?? item.status}:${index}`,
      })),
    [state.catalog],
  );
  const needle = query.trim().toLowerCase();
  const filtered = needle
    ? plugins.filter(
        ({ item }) =>
          item.name.toLowerCase().includes(needle) ||
          (item.source?.toLowerCase().includes(needle) ?? false),
      )
    : plugins;
  const selected = (plugins.find((plugin) => plugin.id === selectedId) ?? filtered[0])?.item;
  const pluginError = state.catalog?.pluginError;
  const pluginSkills = selected
    ? skills?.filter((skill) => skill.plugin === selected.name)
    : undefined;

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4 rounded-md border border-zinc-800 md:flex-row">
      <div className="flex h-56 w-full shrink-0 flex-col border-b border-zinc-800 md:h-auto md:w-[17rem] md:border-b-0 md:border-r">
        <div className="flex items-center gap-2 border-b border-zinc-800 p-2">
          <div className="relative flex-1">
            <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Filter plugins"
              aria-label="Filter plugins"
              className="h-8 pl-7 text-xs"
            />
          </div>
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8 shrink-0 text-muted-foreground hover:text-foreground"
            onClick={onReload}
            disabled={state.loading}
            aria-label="Reload plugins"
            title="Reload plugins"
          >
            <RefreshCw className={cn("h-3.5 w-3.5", state.loading && "animate-spin")} />
          </Button>
        </div>

        {state.error && state.catalog && (
          <p role="alert" className="border-b border-zinc-800 px-3 py-2 text-xs text-destructive">
            Refresh failed: {state.error}
          </p>
        )}

        <ScrollArea className="min-h-0 flex-1">
          {state.loading && !state.catalog ? (
            <div className="flex items-center justify-center py-10">
              <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
            </div>
          ) : state.error && !state.catalog ? (
            <p role="alert" className="p-3 text-xs text-destructive">
              {state.error}
            </p>
          ) : pluginError ? (
            <p className="flex items-start gap-1.5 p-3 text-xs text-muted-foreground">
              <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0 text-amber-400" />
              {pluginError}
            </p>
          ) : filtered.length === 0 ? (
            <p className="p-3 text-xs text-muted-foreground">
              {plugins.length === 0
                ? "This agent reports no plugins on this machine."
                : "No plugins match this filter."}
            </p>
          ) : (
            <ul aria-label="Plugins">
              {filtered.map(({ item, id }) => {
                const isSelected = selected === item;
                return (
                  <li key={id}>
                    <button
                      type="button"
                      aria-current={isSelected ? "true" : undefined}
                      onClick={() => setSelectedId(id)}
                      className={cn(
                        "flex w-full flex-col items-start gap-0.5 border-l-2 px-3 py-2 text-left transition-colors",
                        isSelected
                          ? "border-blue-500 bg-zinc-900/80"
                          : "border-transparent hover:bg-zinc-900/50",
                      )}
                    >
                      <span className="flex w-full items-center gap-1.5">
                        <span
                          className={cn(
                            "truncate text-xs font-medium",
                            item.status === "disabled"
                              ? "text-muted-foreground"
                              : "text-foreground",
                          )}
                        >
                          {item.name}
                        </span>
                        {item.status === "disabled" && (
                          <span className="shrink-0 rounded bg-zinc-800 px-1 text-[9px] uppercase tracking-wide text-muted-foreground">
                            Disabled
                          </span>
                        )}
                      </span>
                      {item.source && (
                        <span className="w-full truncate font-mono text-[10px] text-muted-foreground">
                          {item.source}
                        </span>
                      )}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </ScrollArea>

        <div className="border-t border-zinc-800 px-3 py-1.5 text-[10px] text-muted-foreground">
          {state.catalog && !pluginError ? (
            <>
              {needle && `${filtered.length} of `}
              {plugins.length} plugin{plugins.length === 1 ? "" : "s"}
            </>
          ) : state.loading ? (
            "Reading…"
          ) : (
            "Not available"
          )}
        </div>
      </div>

      <div className="flex min-w-0 flex-1 flex-col">
        {!selected ? (
          <div className="flex flex-1 items-center justify-center p-6 text-xs text-muted-foreground">
            {plugins.length > 0 && "Select a plugin to see its details."}
          </div>
        ) : (
          <>
            <div className="border-b border-zinc-800 p-3">
              <div className="flex items-center gap-2">
                <h4 className="truncate text-sm font-medium text-foreground">{selected.name}</h4>
                <span className="shrink-0 rounded bg-zinc-800 px-1.5 py-0.5 text-[9px] uppercase tracking-wide text-muted-foreground">
                  {STATUS_LABELS[selected.status]}
                </span>
              </div>
              {selected.source && (
                <p className="mt-1 truncate font-mono text-[10px] text-muted-foreground">
                  {selected.source}
                </p>
              )}
            </div>

            <ScrollArea className="min-h-0 flex-1 p-4">
              {selected.status === "disabled" ? (
                <p className="text-xs text-muted-foreground">
                  This plugin is disabled, so its skills are not loaded.
                </p>
              ) : pluginSkills === undefined ? null : pluginSkills.length === 0 ? (
                <p className="text-xs text-muted-foreground">
                  No skills from this plugin are listed for this agent.
                </p>
              ) : (
                <>
                  <h5 className="mb-2 text-xs font-medium text-foreground">
                    Skills from this plugin
                  </h5>
                  <ul aria-label={`Skills from ${selected.name}`} className="space-y-1">
                    {pluginSkills.map((skill) => (
                      <li key={skill.id}>
                        <button
                          type="button"
                          onClick={() => onOpenSkill(skill)}
                          className="flex w-full flex-col items-start gap-0.5 rounded-md border border-zinc-800 px-3 py-2 text-left transition-colors hover:bg-zinc-900/50"
                        >
                          <span className="w-full truncate text-xs font-medium text-foreground">
                            {skill.name}
                          </span>
                          {skill.description && (
                            <span className="line-clamp-2 text-[11px] text-muted-foreground">
                              {skill.description}
                            </span>
                          )}
                        </button>
                      </li>
                    ))}
                  </ul>
                </>
              )}
            </ScrollArea>
          </>
        )}
      </div>
    </div>
  );
}
