import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  Check,
  Copy,
  FolderOpen,
  Loader2,
  RefreshCw,
  Search,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { MessageMarkdown } from "@/components/chat/MessageMarkdown";
import { ClaudeIcon, CodexIcon, OpenCodeIcon } from "@/components/icons/AgentIcons";
import * as backend from "@/lib/backend";
import type {
  AgentSkill,
  AgentSkillProvider,
  AgentSkillScan,
  AgentSkillScope,
} from "@/lib/backend";
import { cn } from "@/lib/utils";

const PROVIDERS: Array<{ id: AgentSkillProvider; label: string; icon: React.ReactNode }> = [
  { id: "claude", label: "Claude", icon: <ClaudeIcon className="h-3.5 w-3.5" /> },
  { id: "codex", label: "Codex", icon: <CodexIcon className="h-3.5 w-3.5 text-emerald-400" /> },
  { id: "opencode", label: "OpenCode", icon: <OpenCodeIcon className="h-3.5 w-3.5" /> },
];

const SCOPE_LABELS: Record<AgentSkillScope, string> = {
  admin: "Managed",
  user: "Personal",
  shared: "Shared",
  system: "Built-in",
  plugin: "Plugin",
};

/** Matches the compact tab strip in ActionBar so the two read as one system. */
const TAB_TRIGGER_CLASSES =
  "h-7 gap-1.5 px-3 text-xs data-[state=active]:!bg-primary/15 data-[state=active]:!text-blue-300 data-[state=active]:ring-1 data-[state=active]:ring-primary/50";

/**
 * The two panes scroll independently, which needs a definite height. The
 * enclosing settings body is `flex-1` inside a scroll container, so a
 * percentage height there resolves against content rather than the viewport
 * and the whole section grows instead. These subtract the settings chrome:
 * the overlay's `md:top-7` offset, the 48px content header, and the body's
 * `py-4` / `md:py-6` padding.
 */
const PANE_HEIGHT_CLASSES = "h-[calc(100dvh-80px)] md:h-[calc(100dvh-124px)]";

/**
 * Strips YAML frontmatter before rendering.
 *
 * remark reads `---\nname: x\n---` as a setext heading, so leaving it in turns
 * the metadata block into an enormous H2 above the actual document. Raw mode
 * still shows the file untouched.
 */
export function stripFrontmatter(content: string): string {
  const match = /^﻿?---\r?\n[\s\S]*?\r?\n(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/.exec(content);
  return match ? content.slice(match[0].length) : content;
}

interface ProviderState {
  scan?: AgentSkillScan;
  loading: boolean;
  error?: string;
  /** Changes after every successful scan, even when the file paths do not. */
  revision?: number;
}

export function SkillsSettings() {
  const [provider, setProvider] = useState<AgentSkillProvider>("claude");
  const [states, setStates] = useState<Record<string, ProviderState>>({});
  const [selectedByProvider, setSelectedByProvider] = useState<Record<string, string>>({});
  const [query, setQuery] = useState("");
  const [rawMode, setRawMode] = useState(false);
  const [file, setFile] = useState<backend.AgentSkillFile | null>(null);
  const [fileLoading, setFileLoading] = useState(false);
  const [fileError, setFileError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  /**
   * Guards both async paths against a stale response landing after the user has
   * already switched tab or skill. Without this, a slow plugin-cache scan can
   * overwrite the list the user is currently looking at.
   */
  const scanTokens = useRef<Record<string, number>>({});
  const fileToken = useRef(0);

  /**
   * Rescans on every tab visit rather than caching: skills are files on disk
   * that change outside this app, and a directory scan is cheap. The previous
   * result stays on screen while the new one loads, so revisiting a tab does
   * not flash a spinner.
   */
  const loadProvider = useCallback(async (target: AgentSkillProvider) => {
    const token = (scanTokens.current[target] ?? 0) + 1;
    scanTokens.current[target] = token;

    setStates((prev) => ({ ...prev, [target]: { ...prev[target], loading: true, error: undefined } }));
    try {
      const scan = await backend.listAgentSkills(target);
      if (scanTokens.current[target] !== token) return;
      setStates((prev) => ({
        ...prev,
        [target]: {
          scan,
          loading: false,
          revision: (prev[target]?.revision ?? 0) + 1,
        },
      }));
    } catch (err) {
      if (scanTokens.current[target] !== token) return;
      setStates((prev) => ({
        ...prev,
        [target]: {
          ...prev[target],
          loading: false,
          error: err instanceof Error ? err.message : String(err),
        },
      }));
    }
  }, []);

  useEffect(() => {
    void loadProvider(provider);
  }, [provider, loadProvider]);

  const state = states[provider] ?? { loading: true };
  const skills = useMemo(() => state.scan?.skills ?? [], [state.scan]);

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return skills;
    return skills.filter((skill) =>
      skill.name.toLowerCase().includes(needle)
      || skill.location.toLowerCase().includes(needle)
      || skill.description.toLowerCase().includes(needle));
  }, [skills, query]);

  // Selection falls back to the first visible skill so the detail pane is never
  // blank while the list has content.
  const selectedId = selectedByProvider[provider];
  const selected: AgentSkill | undefined =
    filtered.find((skill) => skill.id === selectedId) ?? filtered[0];

  useEffect(() => {
    const token = fileToken.current + 1;
    fileToken.current = token;
    if (!selected) {
      setFile(null);
      setFileError(null);
      setFileLoading(false);
      return;
    }
    setFileLoading(true);
    setFileError(null);

    backend.readAgentSkill(provider, selected.filePath)
      .then((result) => {
        if (fileToken.current !== token) return;
        setFile(result);
        setFileLoading(false);
      })
      .catch((err: unknown) => {
        if (fileToken.current !== token) return;
        setFile(null);
        setFileError(err instanceof Error ? err.message : String(err));
        setFileLoading(false);
      });
  }, [provider, selected?.filePath, state.revision]);

  const copyPath = useCallback(async () => {
    if (!selected) return;
    try {
      await navigator.clipboard.writeText(selected.filePath);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      toast.error("Could not copy the path to the clipboard");
    }
  }, [selected]);

  const revealSkill = useCallback(async () => {
    if (!selected) return;
    try {
      await backend.revealInFileManager(selected.filePath);
    } catch {
      toast.error("Could not reveal the skill in the file manager");
    }
  }, [selected]);

  const missingRoots = state.scan?.roots.filter((root) => !root.exists).length ?? 0;
  const presentRoots = (state.scan?.roots.length ?? 0) - missingRoots;

  return (
    <div className={cn("flex min-h-[28rem] flex-col gap-4", PANE_HEIGHT_CLASSES)}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h3 className="text-sm font-medium text-foreground">Skills</h3>
          <p className="mt-1 text-xs text-muted-foreground">
            Every skill each agent can load from its user-level skill directories, including shared
            locations such as <code className="text-[11px]">~/.agents/skills</code>. Project skills
            are not listed here.
          </p>
        </div>
        <Tabs value={provider} onValueChange={(value) => setProvider(value as AgentSkillProvider)}>
          <TabsList className="h-8 bg-zinc-900/80">
            {PROVIDERS.map((entry) => (
              <TabsTrigger key={entry.id} value={entry.id} className={TAB_TRIGGER_CLASSES}>
                {entry.icon}
                {entry.label}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
      </div>

      <div
        data-testid="skills-panes"
        className="flex min-h-0 flex-1 flex-col gap-4 rounded-md border border-zinc-800 md:flex-row"
      >
        {/* Skill list */}
        <div
          data-testid="skills-list-pane"
          className="flex h-56 w-full shrink-0 flex-col border-b border-zinc-800 md:h-auto md:w-[17rem] md:border-b-0 md:border-r"
        >
          <div className="flex items-center gap-2 border-b border-zinc-800 p-2">
            <div className="relative flex-1">
              <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Filter skills"
                aria-label="Filter skills"
                className="h-8 pl-7 text-xs"
              />
            </div>
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8 shrink-0 text-muted-foreground hover:text-foreground"
              onClick={() => void loadProvider(provider)}
              disabled={state.loading}
              aria-label="Rescan skill directories"
              title="Rescan skill directories"
            >
              <RefreshCw className={cn("h-3.5 w-3.5", state.loading && "animate-spin")} />
            </Button>
          </div>

          {state.error && state.scan && (
            <p role="alert" className="border-b border-zinc-800 px-3 py-2 text-xs text-destructive">
              Refresh failed: {state.error}
            </p>
          )}

          <ScrollArea className="min-h-0 flex-1">
            {state.loading && !state.scan ? (
              <div className="flex items-center justify-center py-10">
                <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
              </div>
            ) : state.error && !state.scan ? (
              <p className="p-3 text-xs text-destructive">{state.error}</p>
            ) : filtered.length === 0 ? (
              <p className="p-3 text-xs text-muted-foreground">
                {skills.length === 0
                  ? "No skills found in any of this agent's skill directories."
                  : "No skills match this filter."}
              </p>
            ) : (
              <ul aria-label="Skills">
                {filtered.map((skill) => {
                  const isSelected = selected?.id === skill.id;
                  return (
                    <li key={skill.id}>
                      <button
                        type="button"
                        aria-current={isSelected ? "true" : undefined}
                        onClick={() =>
                          setSelectedByProvider((prev) => ({ ...prev, [provider]: skill.id }))}
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
                              skill.shadowed ? "text-muted-foreground" : "text-foreground",
                            )}
                          >
                            {skill.name}
                          </span>
                          {skill.shadowed && (
                            <span
                              title="A higher-precedence directory provides a skill with this name, so this copy is not loaded"
                              className="shrink-0 rounded bg-zinc-800 px-1 text-[9px] uppercase tracking-wide text-muted-foreground"
                            >
                              Shadowed
                            </span>
                          )}
                        </span>
                        <span
                          className="w-full truncate font-mono text-[10px] text-muted-foreground"
                          title={skill.location}
                        >
                          {skill.location}
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </ScrollArea>

          <div className="border-t border-zinc-800 px-3 py-1.5 text-[10px] text-muted-foreground">
            {skills.length} skill{skills.length === 1 ? "" : "s"} · {presentRoots} of{" "}
            {state.scan?.roots.length ?? 0} directories present
          </div>
        </div>

        {/* Skill detail */}
        <div className="flex min-w-0 flex-1 flex-col">
          {!selected ? (
            <div className="flex flex-1 items-center justify-center p-6 text-xs text-muted-foreground">
              Select a skill to read its SKILL.md.
            </div>
          ) : (
            <>
              <div className="flex items-start justify-between gap-3 border-b border-zinc-800 p-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <h4 className="truncate text-sm font-medium text-foreground">{selected.name}</h4>
                    <span className="shrink-0 rounded bg-zinc-800 px-1.5 py-0.5 text-[9px] uppercase tracking-wide text-muted-foreground">
                      {selected.plugin
                        ? `Plugin · ${selected.plugin}`
                        : SCOPE_LABELS[selected.scope]}
                    </span>
                  </div>
                  <p
                    className="mt-1 truncate font-mono text-[10px] text-muted-foreground"
                    title={selected.filePath}
                  >
                    {selected.location}/SKILL.md
                  </p>
                  {/* Rendered mode strips the frontmatter, so surface its
                      description here rather than losing it entirely. */}
                  {selected.description && (
                    <p className="mt-1.5 line-clamp-2 text-[11px] text-muted-foreground">
                      {selected.description}
                    </p>
                  )}
                </div>

                <div className="flex shrink-0 items-center gap-1">
                  <Tabs value={rawMode ? "raw" : "rendered"} onValueChange={(v) => setRawMode(v === "raw")}>
                    <TabsList className="h-7 bg-zinc-900/80">
                      <TabsTrigger value="rendered" className={TAB_TRIGGER_CLASSES}>
                        Rendered
                      </TabsTrigger>
                      <TabsTrigger value="raw" className={TAB_TRIGGER_CLASSES}>
                        Raw
                      </TabsTrigger>
                    </TabsList>
                  </Tabs>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-7 w-7 text-muted-foreground hover:text-foreground"
                    onClick={() => void copyPath()}
                    aria-label={copied ? "Skill path copied" : "Copy skill path"}
                    title={copied ? "Skill path copied" : "Copy skill path"}
                  >
                    {copied ? <Check className="h-3.5 w-3.5 text-emerald-400" /> : <Copy className="h-3.5 w-3.5" />}
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-7 w-7 text-muted-foreground hover:text-foreground"
                    onClick={() => void revealSkill()}
                    aria-label="Reveal skill in file manager"
                    title="Reveal in file manager"
                  >
                    <FolderOpen className="h-3.5 w-3.5" />
                  </Button>
                </div>
              </div>

              <ScrollArea className="min-h-0 flex-1 p-4">
                {fileLoading ? (
                  <div className="flex items-center justify-center py-10">
                    <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
                  </div>
                ) : fileError ? (
                  <p className="text-xs text-destructive">{fileError}</p>
                ) : file ? (
                  <>
                    {file.truncated && (
                      <p className="mb-3 flex items-center gap-1.5 text-[11px] text-amber-400">
                        <AlertTriangle className="h-3 w-3" />
                        This file is large and has been truncated for display.
                      </p>
                    )}
                    {rawMode ? (
                      <pre className="whitespace-pre-wrap break-words font-mono text-xs leading-relaxed text-foreground">
                        {file.content}
                      </pre>
                    ) : (
                      <MessageMarkdown content={stripFrontmatter(file.content)} enableBreaks={false} />
                    )}
                  </>
                ) : null}
              </ScrollArea>
            </>
          )}
        </div>
      </div>

      {state.scan && state.scan.errors.length > 0 && (
        <div className="rounded-md border border-amber-500/30 bg-amber-500/5 p-2">
          <p className="flex items-center gap-1.5 text-[11px] font-medium text-amber-400">
            <AlertTriangle className="h-3 w-3" />
            Some skill directories could not be read
          </p>
          <ul className="mt-1 space-y-0.5">
            {state.scan.errors.map((entry) => (
              <li key={entry.path} className="font-mono text-[10px] text-muted-foreground">
                {entry.path}: {entry.message}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
