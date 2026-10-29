import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { Braces, ClipboardCopy, CopyPlus, Download, FileUp, Loader2, Network } from "lucide-react";
import { AGENT_PLATFORMS, type AgentPlatform } from "@orkestrator/protocol/agent-platforms";
import {
  graphTemplateRefKey,
  type GraphTemplateRef,
  type GraphTemplateSummary,
} from "@orkestrator/protocol/graphs/library";
import { Button } from "@/components/ui/button";
import { writeText } from "@/lib/native/clipboard";
import { onResourceChanged, onViewSafetyCheck } from "@/lib/resource-sync";
import { cn } from "@/lib/utils";
import { useConfigStore } from "@/stores/configStore";
import { useEnvironmentStore } from "@/stores/environmentStore";
import {
  EMPTY_GRAPH_DESIGNER_TAB,
  graphDesignerLibraryKey,
  parseGraphDraft,
  useGraphDesignerStore,
  type GraphDesignerSelection,
} from "@/stores/graphDesignerStore";
import { usePaneLayoutStore } from "@/stores/paneLayoutStore";
import type { GraphDesignerTabData } from "@/types/paneLayout";
import { GraphCanvas } from "./GraphCanvas";
import { GraphCompilePanel } from "./GraphCompilePanel";
import { GraphImportDialog } from "./GraphImportDialog";
import { GraphInspector } from "./GraphInspector";
import { GraphJsonEditor } from "./GraphJsonEditor";
import { GraphLibraryList } from "./GraphLibraryList";
import { buildGraphCanvasModel } from "./graph-designer-model";

/**
 * The Graphs designer tab (item 110, "Graphs" in the UI): the template
 * library, a read-only canvas, the inspector and the compile panel, with JSON
 * import and export, Duplicate, and JSON editing of user templates.
 *
 * The tab keeps only the template it shows in the pane layout; everything
 * else is re-read from the backend when it mounts, when a `graph-template`
 * change is announced and on view safety checks (invariants 1 and 3).
 */

const SCOPE_LABELS = { builtin: "Built-in", user: "Yours", project: "Project" } as const;

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function downloadText(fileName: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: "application/json" }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  anchor.rel = "noopener";
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

export function GraphDesignerTab({
  tabId,
  environmentId,
  data,
  isActive,
}: {
  tabId: string;
  environmentId: string;
  data: GraphDesignerTabData;
  isActive: boolean;
}) {
  const projectId = useEnvironmentStore(
    (state) =>
      state.environments.find((environment) => environment.id === environmentId)?.projectId ?? null,
  );
  const enabledPlatforms = useConfigStore((state) => state.config.global.enabledAgentPlatforms);
  const providers: readonly AgentPlatform[] = useMemo(
    () => (enabledPlatforms && enabledPlatforms.length > 0 ? enabledPlatforms : AGENT_PLATFORMS),
    [enabledPlatforms],
  );
  const library = useGraphDesignerStore((state) =>
    state.libraries.get(graphDesignerLibraryKey(projectId)),
  );
  const view = useGraphDesignerStore((state) => state.tabs.get(tabId)) ?? EMPTY_GRAPH_DESIGNER_TAB;
  const loadLibrary = useGraphDesignerStore((state) => state.loadLibrary);
  const openTemplate = useGraphDesignerStore((state) => state.openTemplate);
  const refreshTab = useGraphDesignerStore((state) => state.refreshTab);
  const select = useGraphDesignerStore((state) => state.select);
  const importTemplate = useGraphDesignerStore((state) => state.importTemplate);
  const duplicateTemplate = useGraphDesignerStore((state) => state.duplicateTemplate);
  const exportTemplate = useGraphDesignerStore((state) => state.exportTemplate);
  const setTrust = useGraphDesignerStore((state) => state.setTrust);
  const openEditor = useGraphDesignerStore((state) => state.openEditor);

  const [importOpen, setImportOpen] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [trustBusy, setTrustBusy] = useState<string | null>(null);
  // The canvas mounts the first time the tab is shown, so its first fit
  // measures a visible viewport.
  const [shown, setShown] = useState(isActive);
  if (isActive && !shown) setShown(true);

  const persistSelected = useCallback(
    (ref: GraphTemplateRef) => {
      usePaneLayoutStore.getState().updateTabGraphDesigner(tabId, { selected: ref }, environmentId);
    },
    [environmentId, tabId],
  );

  // The library and the template shown are backend snapshots: read them on
  // mount and whenever the backend announces a change or asks for a check.
  useEffect(() => {
    void loadLibrary(projectId);
    const reload = () => {
      void loadLibrary(projectId);
      void refreshTab(tabId);
    };
    const offChange = onResourceChanged("graph-template", reload);
    const offSafety = onViewSafetyCheck(reload);
    return () => {
      offChange();
      offSafety();
    };
  }, [loadLibrary, refreshTab, projectId, tabId]);

  // The pane layout names the template (a reload, or "open in Graphs").
  const wantedKey = data.selected ? graphTemplateRefKey(data.selected) : null;
  const shownKey = view.selected ? graphTemplateRefKey(view.selected) : null;
  useEffect(() => {
    if (!data.selected || wantedKey === shownKey) return;
    void openTemplate(tabId, data.selected, projectId);
  }, [data.selected, wantedKey, shownKey, openTemplate, tabId, projectId]);

  const open = (summary: GraphTemplateSummary) => {
    persistSelected(summary.ref);
    void openTemplate(tabId, summary.ref, projectId);
  };

  const onSelect = useCallback(
    (selection: GraphDesignerSelection, focus = false) => select(tabId, selection, focus),
    [select, tabId],
  );
  const onSelectAndFocus = useCallback(
    (selection: GraphDesignerSelection) => select(tabId, selection, true),
    [select, tabId],
  );

  const detail = view.detail;
  const summary = detail?.summary ?? null;
  const ceiling = library?.result?.ceiling;

  // An open JSON editor shows its draft whenever the draft is a template.
  const draft = useMemo(
    () => (view.editor ? parseGraphDraft(view.editor.text) : null),
    [view.editor],
  );
  const shownTemplate = draft?.ok ? draft.template : (detail?.template ?? null);
  const compile = view.compile;
  const model = useMemo(
    () =>
      shownTemplate
        ? buildGraphCanvasModel({
            template: shownTemplate,
            plan: compile?.plan ?? null,
            diagnostics: compile?.diagnostics ?? [],
          })
        : null,
    [shownTemplate, compile],
  );

  const run = async (label: string, action: () => Promise<void>) => {
    setBusy(label);
    try {
      await action();
    } catch (error) {
      toast.error(`Could not ${label}`, { description: errorText(error) });
    } finally {
      setBusy(null);
    }
  };

  const duplicate = () =>
    run("duplicate the template", async () => {
      if (!summary) return;
      const copy = await duplicateTemplate(tabId, summary, projectId);
      persistSelected(copy.summary.ref);
      toast.success(`Duplicated as ${copy.summary.name}`, {
        description: "Your copy runs on the graph runtime; edit it as JSON.",
      });
    });

  const download = () =>
    run("export the template", async () => {
      if (!summary) return;
      const exported = await exportTemplate(summary.ref);
      downloadText(exported.fileName, exported.text);
    });

  const copyJson = () =>
    run("copy the template", async () => {
      if (!summary) return;
      const exported = await exportTemplate(summary.ref);
      await writeText(exported.text);
      toast.success("Template JSON copied");
    });

  const trust = (target: GraphTemplateSummary, action: "approve" | "revoke") => {
    const key = graphTemplateRefKey(target.ref);
    setTrustBusy(key);
    void setTrust(target, action, shownKey === key ? tabId : undefined)
      .catch((error: unknown) =>
        toast.error(`Could not ${action === "approve" ? "approve" : "revoke"} the template`, {
          description: errorText(error),
        }),
      )
      .finally(() => setTrustBusy(null));
  };

  return (
    <div
      data-graph-designer=""
      className={cn(
        "@container absolute inset-0 flex min-w-0 flex-col overflow-hidden bg-background",
        !isActive && "hidden",
      )}
    >
      <header className="flex min-h-10 flex-wrap items-center gap-2 border-b border-border px-3 py-1.5">
        <Network aria-hidden className="size-4 text-indigo-400" />
        <h2 className="text-sm font-semibold text-foreground">Graphs</h2>
        {summary ? (
          <span className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
            <span aria-hidden>/</span>
            <span data-graph-designer-title="" className="truncate font-medium text-foreground">
              {summary.name}
            </span>
            <span className="shrink-0">({SCOPE_LABELS[summary.scope]})</span>
            {summary.readOnly ? <span className="shrink-0">· read-only</span> : null}
          </span>
        ) : null}
        <div className="ml-auto flex flex-wrap items-center gap-1">
          <Button variant="ghost" size="sm" onClick={() => setImportOpen(true)}>
            <FileUp className="size-3.5" />
            Import JSON…
          </Button>
          <Button
            variant="ghost"
            size="sm"
            disabled={!summary || busy !== null}
            onClick={() => void download()}
          >
            <Download className="size-3.5" />
            Export
          </Button>
          <Button
            variant="ghost"
            size="sm"
            disabled={!summary || busy !== null}
            onClick={() => void copyJson()}
          >
            <ClipboardCopy className="size-3.5" />
            Copy JSON
          </Button>
          <Button
            variant="ghost"
            size="sm"
            disabled={!summary || busy !== null}
            title={
              summary?.scope === "project" && summary.trust !== "trusted"
                ? "Duplicating copies the content you are looking at, as approving would"
                : "Copy into a new template of yours"
            }
            onClick={() => void duplicate()}
          >
            {busy === "duplicate the template" ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              <CopyPlus className="size-3.5" />
            )}
            Duplicate
          </Button>
          {summary?.scope === "user" && !view.editor ? (
            <Button variant="outline" size="sm" onClick={() => openEditor(tabId)}>
              <Braces className="size-3.5" />
              Edit as JSON
            </Button>
          ) : null}
        </div>
      </header>

      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto @4xl:flex-row @4xl:overflow-hidden">
        <aside className="flex max-h-60 min-h-0 w-full shrink-0 flex-col border-b border-border @4xl:max-h-none @4xl:w-64 @4xl:border-r @4xl:border-b-0">
          <GraphLibraryList
            library={library}
            selected={view.selected}
            hasProject={projectId !== null}
            onOpen={open}
            onRefresh={() => void loadLibrary(projectId)}
            onTrust={trust}
            trustBusy={trustBusy}
          />
        </aside>

        <main className="flex min-h-[32rem] min-w-0 flex-1 flex-col @4xl:min-h-0">
          <div className="relative min-h-[18rem] flex-1 bg-flow-canvas">
            {model && shown ? (
              <GraphCanvas
                key={shownKey ?? "none"}
                model={model}
                selection={view.selection}
                focusRequest={view.focusRequest}
                isActive={isActive}
                onSelect={onSelect}
              />
            ) : (
              <div className="flex h-full items-center justify-center p-6 text-center text-sm text-muted-foreground">
                {view.detailStatus === "loading" ? (
                  <span className="flex items-center gap-2">
                    <Loader2 aria-hidden className="size-4 animate-spin" /> Loading the template…
                  </span>
                ) : view.detailStatus === "error" ? (
                  <span role="alert" className="text-failure">
                    Could not load the template: {view.detailError}
                  </span>
                ) : (
                  "Choose a template from the library, or import one as JSON."
                )}
              </div>
            )}
          </div>
          <GraphCompilePanel
            className="h-48 shrink-0"
            compile={compile}
            status={view.compileStatus}
            error={view.compileError}
            onSelect={onSelect}
          />
        </main>

        <aside className="flex min-h-0 w-full shrink-0 flex-col border-t border-border @4xl:w-80 @4xl:border-t-0 @4xl:border-l">
          {view.editor ? (
            <div className="flex min-h-80 flex-col @4xl:min-h-0 @4xl:flex-[3]">
              <GraphJsonEditor
                tabId={tabId}
                editor={view.editor}
                providers={providers}
                {...(ceiling ? { ceiling } : {})}
              />
            </div>
          ) : null}
          {shownTemplate && model ? (
            <div
              className={cn(
                "flex min-h-0 flex-col",
                view.editor ? "border-t border-border @4xl:flex-[2]" : "flex-1",
              )}
            >
              <GraphInspector
                template={shownTemplate}
                plan={compile?.plan ?? null}
                diagnostics={model.diagnostics}
                selection={view.selection}
                {...(ceiling ? { ceiling } : {})}
                providers={providers}
                onSelect={onSelectAndFocus}
              />
            </div>
          ) : null}
        </aside>
      </div>

      <GraphImportDialog
        open={importOpen}
        onOpenChange={setImportOpen}
        onImport={async (text) => {
          const result = await importTemplate(tabId, text, projectId);
          if (result.ok) {
            persistSelected(result.detail.summary.ref);
            toast.success(
              result.renamedFrom
                ? `Imported as ${result.detail.summary.id} (${result.renamedFrom} was taken)`
                : `Imported ${result.detail.summary.name}`,
            );
          }
          return result;
        }}
      />
    </div>
  );
}
