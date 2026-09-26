import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { DesignCanvas } from "@orkestrator/protocol/design-canvas";
import type {
  DesignLibraryQuery,
  DesignOperationInput,
  DesignOperationStatus,
  DesignPreconditions,
} from "@orkestrator/protocol/design-operations";
import { LayoutTemplate } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { designAction, designApi, failureOf } from "./design-client";
import {
  legacyLibraryPage,
  runDesignLifecycle,
  validateDesignName,
  type DesignLibraryItem,
  type DesignLibraryResult,
} from "./design-launch";
import type { DesignOpenChoices, DesignPlacement } from "./design-open";

export const DESIGN_LIBRARY_PAGE_SIZE = 50;

export interface DesignLibraryClient {
  list: (environmentId: string, query: DesignLibraryQuery) => Promise<DesignLibraryResult>;
  lifecycle: (
    environmentId: string,
    canvasId: string,
    input: DesignOperationInput,
    preconditions: DesignPreconditions,
  ) => Promise<DesignOperationStatus>;
  purge: (environmentId: string, canvasId: string) => Promise<unknown>;
  exportDocument: (environmentId: string, canvasId: string) => Promise<DesignCanvas>;
}

/** `legacy` uses an old backend's name-only list; lifecycle actions are hidden. */
export function designLibraryClient(legacy: boolean): DesignLibraryClient {
  return {
    list: (environmentId, query) =>
      legacy ? legacyLibraryPage(environmentId, query) : designApi.library(environmentId, query),
    lifecycle: (environmentId, canvasId, input, preconditions) =>
      runDesignLifecycle(environmentId, canvasId, input, preconditions),
    purge: (environmentId, canvasId) => designApi.purge(environmentId, canvasId),
    exportDocument: (environmentId, canvasId) =>
      designAction<DesignCanvas>(environmentId, "export_canvas", { canvasId }),
  };
}

type Filter = "live" | "deleted";
type Sort = "modified" | "name";
type Confirm = { id: string; kind: "trash" | "purge" } | null;

function formatTime(iso: string): string {
  if (!iso) return "";
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? "" : date.toLocaleString();
}

function downloadDocument(canvas: DesignCanvas) {
  const url = URL.createObjectURL(
    new Blob([JSON.stringify(canvas, null, 2)], { type: "application/json" }),
  );
  const link = document.createElement("a");
  link.href = url;
  link.download = `${canvas.name.replace(/[^a-zA-Z0-9_-]/g, "-")}.orkdes`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function EntryFacts({ entry }: { entry: DesignLibraryItem }) {
  const facts: string[] = [];
  if (entry.state === "deleted" && entry.deletedAt)
    facts.push(`Deleted ${formatTime(entry.deletedAt)}`);
  else if (entry.modifiedAt) facts.push(`Modified ${formatTime(entry.modifiedAt)}`);
  if (!entry.legacy)
    facts.push(`${entry.frameCount} ${entry.frameCount === 1 ? "frame" : "frames"}`);
  if (entry.export)
    facts.push(
      entry.export.outdated
        ? `Saved copy outdated (${entry.export.relativePath})`
        : `Saved to ${entry.export.relativePath}`,
    );
  if (entry.validation.invalid > 0) facts.push(`${entry.validation.invalid} invalid`);
  if (entry.validation.unvalidated > 0) facts.push(`${entry.validation.unvalidated} unvalidated`);
  if (entry.state === "problem")
    facts.push(entry.problem === "unsupported-version" ? "Unsupported version" : "Needs recovery");
  return <span className="text-xs text-muted-foreground">{facts.join(" · ")}</span>;
}

export function DesignLibrary({
  environmentId,
  backendKey,
  legacy,
  canManage,
  client,
  openChoices,
  onOpen,
  searchDebounceMs = 250,
  refreshToken = 0,
}: {
  environmentId: string;
  backendKey: string;
  legacy: boolean;
  /** Backend supports lifecycle operations (rename/duplicate/trash/restore). */
  canManage: boolean;
  client?: DesignLibraryClient;
  openChoices: (canvasId: string) => DesignOpenChoices;
  /** Returns a user-facing error, or null when the canvas was shown. */
  onOpen: (canvasId: string, placement: DesignPlacement) => string | null;
  searchDebounceMs?: number;
  /** Bump to reload the first page (e.g. after an import). */
  refreshToken?: number;
}) {
  const api = useMemo(() => client ?? designLibraryClient(legacy), [client, legacy]);
  const scopeKey = `${backendKey}\u0000${environmentId}`;
  const [search, setSearch] = useState("");
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<Sort>("modified");
  const [filter, setFilter] = useState<Filter>("live");
  // Entries are tagged with the scope that produced them so a render after an
  // environment/backend switch never shows the previous scope's list.
  const [list, setList] = useState<{
    scope: string;
    entries: DesignLibraryItem[];
    page: Omit<DesignLibraryResult, "entries"> | null;
  }>({ scope: scopeKey, entries: [], page: null });
  const entries = list.scope === scopeKey ? list.entries : [];
  const page = list.scope === scopeKey ? list.page : null;
  const [loading, setLoading] = useState<"idle" | "list" | "more">("idle");
  const [listError, setListError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [announcement, setAnnouncement] = useState("");
  const [renaming, setRenaming] = useState<{ id: string; value: string } | null>(null);
  const [confirm, setConfirm] = useState<Confirm>(null);
  const epochRef = useRef(0);
  const scopeRef = useRef(scopeKey);

  // A new environment or backend never shows the previous scope's entries,
  // and any response still in flight for the old scope is ignored.
  if (scopeRef.current !== scopeKey) {
    scopeRef.current = scopeKey;
    epochRef.current++;
  }
  useEffect(() => {
    setList({ scope: scopeKey, entries: [], page: null });
    setListError(null);
    setSelectedId(null);
    setActionError(null);
    setRenaming(null);
    setConfirm(null);
  }, [scopeKey]);

  useEffect(() => {
    if (searchDebounceMs <= 0) {
      setQuery(search);
      return;
    }
    const timer = setTimeout(() => setQuery(search), searchDebounceMs);
    return () => clearTimeout(timer);
  }, [search, searchDebounceMs]);

  const load = useCallback(
    async (offset: number, select?: string) => {
      const epoch = ++epochRef.current;
      const scope = scopeRef.current;
      setLoading(offset > 0 ? "more" : "list");
      try {
        const result = await api.list(environmentId, {
          search: query.trim() || undefined,
          sort,
          filter: legacy ? "live" : filter,
          offset,
          limit: DESIGN_LIBRARY_PAGE_SIZE,
        });
        if (epoch !== epochRef.current || scope !== scopeRef.current) return;
        const { entries: next, ...rest } = result;
        setList((previous) => {
          if (offset === 0 || previous.scope !== scope) return { scope, entries: next, page: rest };
          const seen = new Set(previous.entries.map((entry) => entry.id));
          return {
            scope,
            entries: [...previous.entries, ...next.filter((entry) => !seen.has(entry.id))],
            page: rest,
          };
        });
        setListError(null);
        if (select) setSelectedId(select);
      } catch (error) {
        if (epoch !== epochRef.current || scope !== scopeRef.current) return;
        // Keep whatever is already listed; report the failure beside it.
        setListError(failureOf(error).message);
      } finally {
        if (epoch === epochRef.current) setLoading("idle");
      }
    },
    [api, environmentId, filter, legacy, query, sort],
  );

  useEffect(() => {
    void load(0);
  }, [load, scopeKey, refreshToken]);

  const selected = entries.find((entry) => entry.id === selectedId) ?? null;

  const act = async (
    label: string,
    work: () => Promise<{ announce: string; select?: string } | void>,
  ) => {
    const scope = scopeRef.current;
    setBusy(true);
    setActionError(null);
    try {
      const outcome = await work();
      if (scope !== scopeRef.current) return;
      setRenaming(null);
      setConfirm(null);
      if (outcome) {
        setAnnouncement(outcome.announce);
        await load(0, outcome.select);
      }
    } catch (error) {
      if (scope !== scopeRef.current) return;
      setActionError(`${label} failed: ${failureOf(error).message}`);
    } finally {
      if (scope === scopeRef.current) setBusy(false);
    }
  };

  const rename = (entry: DesignLibraryItem, value: string) => {
    const problem = validateDesignName(value);
    if (problem) {
      setActionError(problem);
      return;
    }
    void act("Rename", async () => {
      await api.lifecycle(
        environmentId,
        entry.id,
        { kind: "rename_canvas", name: value.trim() },
        { canvasRevision: entry.revision },
      );
      return { announce: `Renamed to ${value.trim()}` };
    });
  };

  const renderActions = (entry: DesignLibraryItem) => {
    const choices = entry.state === "deleted" ? null : openChoices(entry.id);
    const manage = canManage && !legacy;
    if (renaming?.id === entry.id)
      return (
        <form
          className="flex flex-wrap items-center gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            rename(entry, renaming.value);
          }}
        >
          <Input
            autoFocus
            aria-label={`New name for ${entry.name}`}
            className="h-8 max-w-xs"
            maxLength={120}
            value={renaming.value}
            onChange={(event) => setRenaming({ id: entry.id, value: event.target.value })}
          />
          <Button type="submit" size="sm" disabled={busy}>
            Save name
          </Button>
          <Button type="button" size="sm" variant="ghost" onClick={() => setRenaming(null)}>
            Cancel
          </Button>
        </form>
      );
    if (confirm?.id === entry.id)
      return (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm">
            {confirm.kind === "trash"
              ? `Move “${entry.name}” to trash? You can restore it for 7 days.`
              : `Permanently delete “${entry.name}”? This cannot be undone.`}
          </span>
          <Button
            type="button"
            size="sm"
            variant="destructive"
            disabled={busy}
            onClick={() =>
              void act(
                confirm.kind === "trash" ? "Move to trash" : "Delete permanently",
                async () => {
                  if (confirm.kind === "trash") {
                    await api.lifecycle(
                      environmentId,
                      entry.id,
                      { kind: "delete_canvas" },
                      { canvasRevision: entry.revision },
                    );
                    return { announce: `Moved ${entry.name} to trash` };
                  }
                  await api.purge(environmentId, entry.id);
                  return { announce: `Permanently deleted ${entry.name}` };
                },
              )
            }
          >
            {confirm.kind === "trash" ? "Move to trash" : "Delete permanently"}
          </Button>
          <Button type="button" size="sm" variant="ghost" onClick={() => setConfirm(null)}>
            Cancel
          </Button>
        </div>
      );
    return (
      <div className="grid gap-1">
        <div className="flex flex-wrap gap-2">
          {choices?.openTabId && (
            <Button
              type="button"
              size="sm"
              onClick={() => setActionError(onOpen(entry.id, "current"))}
            >
              Show open tab
            </Button>
          )}
          {choices && !choices.openTabId && (
            <>
              <Button
                type="button"
                size="sm"
                disabled={!choices.canOpen}
                onClick={() => setActionError(onOpen(entry.id, "split"))}
              >
                {choices.besideFallsBack ? "Open (current pane)" : "Open beside"}
              </Button>
              {!choices.besideFallsBack && (
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={!choices.canOpen}
                  onClick={() => setActionError(onOpen(entry.id, "current"))}
                >
                  Open here
                </Button>
              )}
            </>
          )}
          {entry.state !== "deleted" && (
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() =>
                void act("Download", async () => {
                  downloadDocument(await api.exportDocument(environmentId, entry.id));
                  setAnnouncement(`Downloaded ${entry.name}`);
                })
              }
            >
              Download
            </Button>
          )}
          {manage && entry.state !== "deleted" && (
            <>
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={busy || entry.state === "problem"}
                onClick={() => {
                  setActionError(null);
                  setRenaming({ id: entry.id, value: entry.name });
                }}
              >
                Rename
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={busy || entry.state === "problem"}
                onClick={() =>
                  void act("Duplicate", async () => {
                    const status = await api.lifecycle(
                      environmentId,
                      entry.id,
                      { kind: "duplicate_canvas" },
                      { canvasRevision: entry.revision },
                    );
                    const created = status.result?.createdCanvasId;
                    return {
                      announce: `Duplicated ${entry.name}`,
                      ...(created ? { select: created } : {}),
                    };
                  })
                }
              >
                Duplicate
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={busy}
                onClick={() => {
                  setActionError(null);
                  setConfirm({ id: entry.id, kind: "trash" });
                }}
              >
                Move to trash
              </Button>
            </>
          )}
          {manage && entry.state === "deleted" && (
            <>
              <Button
                type="button"
                size="sm"
                disabled={busy}
                onClick={() =>
                  void act("Restore", async () => {
                    await api.lifecycle(
                      environmentId,
                      entry.id,
                      { kind: "restore_canvas" },
                      { tombstoneRevision: entry.revision },
                    );
                    return { announce: `Restored ${entry.name}` };
                  })
                }
              >
                Restore
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={busy}
                onClick={() => {
                  setActionError(null);
                  setConfirm({ id: entry.id, kind: "purge" });
                }}
              >
                Delete permanently
              </Button>
            </>
          )}
        </div>
        {choices?.notice && !choices.openTabId && (
          <p className="text-xs text-muted-foreground">{choices.notice}</p>
        )}
      </div>
    );
  };

  const emptyText = query.trim()
    ? `No designs match “${query.trim()}”.`
    : filter === "deleted"
      ? "Trash is empty."
      : "No designs yet. Create one in New design or import an .orkdes file.";
  const quotaFull = page !== null && !legacy && page.quota.live >= page.quota.liveLimit;

  return (
    <div className="grid gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <Input
          type="search"
          aria-label="Search designs"
          placeholder="Search by name…"
          className="h-8 min-w-40 flex-1"
          maxLength={120}
          value={search}
          onChange={(event) => setSearch(event.target.value)}
        />
        <Select value={sort} onValueChange={(value) => setSort(value as Sort)}>
          <SelectTrigger aria-label="Sort designs" size="sm" className="w-36">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="modified">Last modified</SelectItem>
            <SelectItem value="name">Name</SelectItem>
          </SelectContent>
        </Select>
        {!legacy && canManage && (
          <Select value={filter} onValueChange={(value) => setFilter(value as Filter)}>
            <SelectTrigger aria-label="Show designs" size="sm" className="w-32">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="live">Designs</SelectItem>
              <SelectItem value="deleted">Trash</SelectItem>
            </SelectContent>
          </Select>
        )}
      </div>
      <p role="status" aria-live="polite" className="sr-only">
        {announcement}
      </p>
      {listError && (
        <div
          role="alert"
          className="flex items-center justify-between gap-2 text-sm text-destructive"
        >
          <span>Could not load designs: {listError}</span>
          <Button type="button" size="sm" variant="outline" onClick={() => void load(0)}>
            Retry
          </Button>
        </div>
      )}
      {actionError && (
        <p role="alert" className="text-sm text-destructive">
          {actionError}
        </p>
      )}
      {quotaFull && page && (
        <p className="text-sm text-amber-700 dark:text-amber-400">
          Design limit reached ({page.quota.live} of {page.quota.liveLimit}). Move designs to trash
          to create or import more.
        </p>
      )}
      {loading === "list" && entries.length === 0 && (
        <p className="text-sm text-muted-foreground">Loading designs…</p>
      )}
      {loading === "idle" && !listError && entries.length === 0 && (
        <p className="text-sm text-muted-foreground">{emptyText}</p>
      )}
      {entries.length > 0 && (
        <ul
          aria-label="Designs"
          className="grid max-h-80 gap-1 overflow-y-auto"
          aria-busy={loading !== "idle"}
        >
          {entries.map((entry) => {
            const isSelected = entry.id === selectedId;
            return (
              <li
                key={entry.id}
                className={cn("grid gap-2 rounded-md border p-2", isSelected && "border-primary")}
              >
                <button
                  type="button"
                  aria-pressed={isSelected}
                  className="flex items-center gap-3 text-left"
                  onClick={() => {
                    if (entry.id !== selectedId) {
                      setRenaming(null);
                      setConfirm(null);
                      setActionError(null);
                    }
                    setSelectedId(entry.id);
                  }}
                >
                  <span
                    aria-hidden
                    className="grid size-10 shrink-0 place-items-center rounded bg-muted text-muted-foreground"
                  >
                    <LayoutTemplate className="size-4" />
                  </span>
                  <span className="grid min-w-0">
                    <span data-design-name className="truncate text-sm font-medium">
                      {entry.name}
                    </span>
                    <EntryFacts entry={entry} />
                  </span>
                </button>
                {isSelected && selected && renderActions(selected)}
              </li>
            );
          })}
        </ul>
      )}
      <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
        <span>
          {page ? `Showing ${entries.length} of ${page.total}` : ""}
          {page && !legacy && filter === "deleted" && page.quota.deletedLimit > 0
            ? ` · Trash ${page.quota.deleted} of ${page.quota.deletedLimit}`
            : ""}
        </span>
        {page?.nextOffset !== undefined && (
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={loading !== "idle"}
            onClick={() => void load(page.nextOffset ?? entries.length)}
          >
            {loading === "more" ? "Loading…" : "Load more"}
          </Button>
        )}
      </div>
    </div>
  );
}
