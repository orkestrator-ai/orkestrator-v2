import { useCallback, useEffect, useEffectEvent, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import {
  Braces,
  ClipboardCopy,
  CopyPlus,
  Download,
  FileUp,
  FilePlus2,
  Loader2,
  Network,
  PencilRuler,
} from "lucide-react";
import { AGENT_PLATFORMS, type AgentPlatform } from "@orkestrator/protocol/agent-platforms";
import {
  graphTemplateRefKey,
  type GraphTemplateRef,
  type GraphTemplateSummary,
} from "@orkestrator/protocol/graphs/library";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { writeText } from "@/lib/native/clipboard";
import { onResourceChanged, onViewSafetyCheck } from "@/lib/resource-sync";
import { cn } from "@/lib/utils";
import { useConfigStore } from "@/stores/configStore";
import { useEnvironmentStore } from "@/stores/environmentStore";
import {
  EMPTY_GRAPH_DESIGNER_TAB,
  graphDesignerLibraryKey,
  graphDraftDirty,
  useGraphDesignerStore,
  type GraphDesignerSelection,
} from "@/stores/graphDesignerStore";
import { usePaneLayoutStore } from "@/stores/paneLayoutStore";
import type { GraphDesignerTabData } from "@/types/paneLayout";
import { GraphCanvas } from "./GraphCanvas";
import { GraphConnectDialog, GraphLoopDialog } from "./GraphCommandDialogs";
import { GraphCompilePanel } from "./GraphCompilePanel";
import { GraphEditorToolbar } from "./GraphEditorToolbar";
import { GraphImportDialog } from "./GraphImportDialog";
import { GraphInspector } from "./GraphInspector";
import { GraphJsonEditor } from "./GraphJsonEditor";
import { GraphLibraryList } from "./GraphLibraryList";
import { arrangeGraphLayout, blankGraphTemplate } from "./graph-designer-edits";
import { buildGraphCanvasModel, graphTemplateTypeLibrary } from "./graph-designer-model";
import { graphSubgraphChoices } from "./graph-designer-subgraphs";
import { GraphEditorContext } from "./graph-editor-context";
import { useGraphDesignerEditing } from "./useGraphDesignerEditing";

/**
 * The Graphs designer tab ("Graphs" in the UI): the template library, the
 * canvas, the inspector and the compile panel, with JSON import and export
 * and Duplicate (item 110). User templates, and new ones ("New graph"), are
 * edited on the canvas (item 212): palette, connections, forms, undo, a live
 * browser compile, and Save with compare-and-swap.
 *
 * The tab keeps only the template it shows in the pane layout; everything
 * else is re-read from the backend when it mounts, when a `graph-template`
 * change is announced and on view safety checks (invariants 1 and 3). An
 * unsaved draft lives only in the designer store.
 */

/** Wait this long after the last edit before compiling the draft in the browser. */
export const GRAPH_DRAFT_COMPILE_DELAY_MS = 250;

function isTextTarget(target: EventTarget | null): boolean {
  const element = target as HTMLElement | null;
  if (!element) return false;
  return (
    element.tagName === "INPUT" ||
    element.tagName === "TEXTAREA" ||
    element.tagName === "SELECT" ||
    element.isContentEditable
  );
}

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
  const openDraft = useGraphDesignerStore((state) => state.openDraft);
  const closeEditor = useGraphDesignerStore((state) => state.closeEditor);
  const compileDraft = useGraphDesignerStore((state) => state.compileDraft);
  const saveDraft = useGraphDesignerStore((state) => state.saveDraft);
  const saveDraftAsCopy = useGraphDesignerStore((state) => state.saveDraftAsCopy);
  const reloadDraft = useGraphDesignerStore((state) => state.reloadDraft);
  const undo = useGraphDesignerStore((state) => state.undo);
  const redo = useGraphDesignerStore((state) => state.redo);
  const acknowledge = useGraphDesignerStore((state) => state.acknowledge);
  const [jsonOpen, setJsonOpen] = useState(false);
  // Leaving unsaved edits asks first; this is what to do once confirmed.
  const [pendingDiscard, setPendingDiscard] = useState<{ label: string; run: () => void } | null>(
    null,
  );

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
  // Each ref the pane layout names is acted on once: the tab may move on by
  // itself (a save as copy, a new draft) before the layout catches up.
  const handledKeyRef = useRef<string | null>(null);
  const newDraft = view.editor?.isNew ?? false;
  useEffect(() => {
    if (!data.selected || newDraft || wantedKey === handledKeyRef.current) return;
    handledKeyRef.current = wantedKey;
    if (wantedKey === shownKey) return;
    void openTemplate(tabId, data.selected, projectId);
  }, [data.selected, wantedKey, shownKey, newDraft, openTemplate, tabId, projectId]);

  const dirty = graphDraftDirty(view.editor);
  /** Runs `action` now, or after the user agrees to drop unsaved edits. */
  const guardDiscard = (label: string, action: () => void) => {
    if (dirty) setPendingDiscard({ label, run: action });
    else action();
  };

  const open = (summary: GraphTemplateSummary) =>
    guardDiscard(`open ${summary.name}`, () => {
      persistSelected(summary.ref);
      void openTemplate(tabId, summary.ref, projectId);
    });

  const newGraph = () =>
    guardDiscard("start a new graph", () => {
      usePaneLayoutStore.getState().updateTabGraphDesigner(tabId, {}, environmentId);
      openDraft(tabId, blankGraphTemplate(), projectId);
      setJsonOpen(false);
    });

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

  const editor = view.editor;
  const draft = editor?.draft ?? null;
  const shownTemplate = draft ?? detail?.template ?? null;
  const compile = view.compile;
  const model = useMemo(
    () =>
      shownTemplate
        ? buildGraphCanvasModel({
            template: shownTemplate,
            plan: compile?.plan ?? null,
            diagnostics: compile?.diagnostics ?? [],
            editable: draft !== null,
          })
        : null,
    [shownTemplate, compile, draft],
  );
  const typeLibrary = useMemo(
    () => graphTemplateTypeLibrary(shownTemplate ?? blankGraphTemplate()),
    [shownTemplate],
  );
  // Saved templates the palette offers as sub-graphs: never the one being edited.
  const libraryTemplates = library?.result?.templates;
  const draftId = draft?.id ?? null;
  const subgraphs = useMemo(
    () => ({
      projectId,
      choices: graphSubgraphChoices(
        libraryTemplates ?? [],
        draftId === null ? null : { scope: "user", id: draftId },
      ),
    }),
    [libraryTemplates, draftId, projectId],
  );
  const editing = useGraphDesignerEditing({
    tabId,
    draft,
    library: typeLibrary,
    compile,
    providers,
    ...(ceiling ? { ceiling } : {}),
    onSelect,
    subgraphs,
  });

  // The draft compiles in the browser shortly after each edit (the live panel).
  useEffect(() => {
    if (!draft) return;
    const timer = setTimeout(
      () => compileDraft(tabId, { providers, ...(ceiling ? { ceiling } : {}) }),
      GRAPH_DRAFT_COMPILE_DELAY_MS,
    );
    return () => clearTimeout(timer);
  }, [tabId, draft, providers, ceiling, compileDraft]);

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
  const save = () =>
    run("save the template", async () => {
      const saved = await saveDraft(tabId);
      if (saved) {
        persistSelected(saved.summary.ref);
        toast.success(`Saved ${saved.summary.name}`, {
          description: `Revision ${saved.summary.revision}`,
        });
      }
    });

  const saveAsCopy = () =>
    run("save a copy", async () => {
      const saved = await saveDraftAsCopy(tabId);
      if (saved) {
        persistSelected(saved.summary.ref);
        toast.success(`Saved as ${saved.summary.name}`, { description: `Id ${saved.summary.id}` });
      }
    });

  const stepHistory = (direction: "undo" | "redo") => {
    const label = direction === "undo" ? undo(tabId) : redo(tabId);
    if (label)
      toast.message(`${direction === "undo" ? "Undid" : "Redid"}: ${label}`, { duration: 1500 });
  };

  // Undo, redo and save while the designer is the active tab: on the window,
  // so they work after a dialog closes and focus falls back to the page.
  const rootRef = useRef<HTMLDivElement>(null);
  const onShortcut = useEffectEvent((event: globalThis.KeyboardEvent) => {
    if (!editor || !(event.metaKey || event.ctrlKey) || event.defaultPrevented) return;
    const target = event.target as Node | null;
    const inDesigner = Boolean(target && rootRef.current?.contains(target));
    if (!inDesigner && target !== document.body && target !== document.documentElement) return;
    const key = event.key.toLowerCase();
    if (key === "s") {
      event.preventDefault();
      void save();
      return;
    }
    // Text fields keep their own undo.
    if (isTextTarget(event.target)) return;
    if (key === "z") {
      event.preventDefault();
      stepHistory(event.shiftKey ? "redo" : "undo");
    } else if (key === "y") {
      event.preventDefault();
      stepHistory("redo");
    }
  });
  const editingNow = editor !== null;
  useEffect(() => {
    if (!isActive || !editingNow) return;
    const listener = (event: globalThis.KeyboardEvent) => onShortcut(event);
    window.addEventListener("keydown", listener);
    return () => window.removeEventListener("keydown", listener);
  }, [isActive, editingNow]);

  const duplicate = () =>
    run("duplicate the template", async () => {
      if (!summary) return;
      const copy = await duplicateTemplate(tabId, summary, projectId);
      persistSelected(copy.summary.ref);
      toast.success(`Duplicated as ${copy.summary.name}`, {
        description: "Your copy runs on the graph runtime; edit it on the canvas.",
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
      data-graph-designer-editing={editor ? "" : undefined}
      className={cn(
        "@container absolute inset-0 flex min-w-0 flex-col overflow-hidden bg-background",
        !isActive && "hidden",
      )}
      ref={rootRef}
    >
      <header className="flex min-h-10 flex-wrap items-center gap-2 border-b border-border px-3 py-1.5">
        <Network aria-hidden className="size-4 text-indigo-400" />
        <h2 className="text-sm font-semibold text-foreground">Graphs</h2>
        {editor?.isNew ? (
          <span className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
            <span aria-hidden>/</span>
            <span data-graph-designer-title="" className="truncate font-medium text-foreground">
              {editor.draft.name}
            </span>
            <span className="shrink-0">(new, unsaved)</span>
          </span>
        ) : summary ? (
          <span className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
            <span aria-hidden>/</span>
            <span data-graph-designer-title="" className="truncate font-medium text-foreground">
              {editor ? editor.draft.name : summary.name}
            </span>
            <span className="shrink-0">({SCOPE_LABELS[summary.scope]})</span>
            {summary.readOnly ? <span className="shrink-0">· read-only</span> : null}
          </span>
        ) : null}
        <div className="ml-auto flex flex-wrap items-center gap-1">
          <Button variant="ghost" size="sm" onClick={newGraph}>
            <FilePlus2 className="size-3.5" />
            New graph
          </Button>
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
            <>
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  setJsonOpen(true);
                  openEditor(tabId);
                }}
              >
                <Braces className="size-3.5" />
                Edit as JSON
              </Button>
              <Button
                size="sm"
                onClick={() => {
                  setJsonOpen(false);
                  openEditor(tabId);
                }}
              >
                <PencilRuler className="size-3.5" />
                Edit
              </Button>
            </>
          ) : null}
        </div>
      </header>
      {editor ? (
        <GraphEditorToolbar
          editor={editor}
          storedRevision={editor.isNew ? null : (detail?.summary.revision ?? null)}
          jsonOpen={jsonOpen}
          onUndo={() => stepHistory("undo")}
          onRedo={() => stepHistory("redo")}
          onSave={() => void save()}
          onSaveAsCopy={() => void saveAsCopy()}
          onReload={() => guardDiscard("reload the latest revision", () => void reloadDraft(tabId))}
          onToggleJson={() => setJsonOpen((value) => !value)}
          onArrange={() =>
            useGraphDesignerStore
              .getState()
              .edit(tabId, "Arrange automatically", arrangeGraphLayout)
          }
          onClose={() =>
            guardDiscard("stop editing", () => {
              closeEditor(tabId);
              setJsonOpen(false);
            })
          }
        />
      ) : null}

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
                key={editor ? "editing" : (shownKey ?? "none")}
                model={model}
                {...(editing.canvasEditor ? { editor: editing.canvasEditor } : {})}
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
            className={editor ? "h-56 shrink-0" : "h-48 shrink-0"}
            compile={compile}
            status={view.compileStatus}
            error={view.compileError}
            onSelect={onSelect}
            {...(editor ? { onAcknowledge: (ref) => acknowledge(tabId, ref) } : {})}
          />
        </main>

        <aside
          className={cn(
            "flex min-h-0 w-full shrink-0 flex-col border-t border-border @4xl:border-t-0 @4xl:border-l",
            editor ? "@4xl:w-96" : "@4xl:w-80",
          )}
        >
          {editor && jsonOpen ? (
            <div className="flex min-h-80 flex-col @4xl:min-h-0 @4xl:flex-[3]">
              <GraphJsonEditor
                draft={editor.draft}
                onChange={(template) =>
                  useGraphDesignerStore
                    .getState()
                    .edit(tabId, "Edit JSON", () => template, { coalesce: "json" })
                }
                onClose={() => setJsonOpen(false)}
              />
            </div>
          ) : null}
          {shownTemplate && model ? (
            <div
              className={cn(
                "flex min-h-0 flex-col",
                editor && jsonOpen ? "border-t border-border @4xl:flex-[2]" : "flex-1",
              )}
            >
              {editing.context ? (
                <GraphEditorContext.Provider value={editing.context}>
                  <GraphInspector
                    template={shownTemplate}
                    plan={compile?.plan ?? null}
                    diagnostics={model.diagnostics}
                    selection={view.selection}
                    {...(ceiling ? { ceiling } : {})}
                    providers={providers}
                    onSelect={onSelectAndFocus}
                    editing={{ idEditable: editor?.isNew ?? false }}
                  />
                </GraphEditorContext.Provider>
              ) : (
                <GraphInspector
                  template={shownTemplate}
                  plan={compile?.plan ?? null}
                  diagnostics={model.diagnostics}
                  selection={view.selection}
                  {...(ceiling ? { ceiling } : {})}
                  providers={providers}
                  onSelect={onSelectAndFocus}
                />
              )}
            </div>
          ) : null}
        </aside>
      </div>

      {draft ? (
        <>
          <GraphConnectDialog
            open={editing.dialog?.command === "connect"}
            onOpenChange={(open) => {
              if (!open) editing.setDialog(null);
            }}
            template={draft}
            library={typeLibrary}
            nodeId={editing.dialog?.nodeId ?? null}
            onConnect={editing.connect}
          />
          <GraphLoopDialog
            open={editing.dialog?.command === "loop"}
            onOpenChange={(open) => {
              if (!open) editing.setDialog(null);
            }}
            template={draft}
            nodeId={editing.dialog?.nodeId ?? null}
            onChoose={(choice) => {
              if (editing.dialog) editing.chooseLoop(editing.dialog.nodeId, choice);
            }}
          />
        </>
      ) : null}

      <AlertDialog
        open={pendingDiscard !== null}
        onOpenChange={(open) => {
          if (!open) setPendingDiscard(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Discard unsaved changes?</AlertDialogTitle>
            <AlertDialogDescription>
              The draft has edits that are not saved. To {pendingDiscard?.label}, they are dropped.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep editing</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                const action = pendingDiscard?.run;
                setPendingDiscard(null);
                action?.();
              }}
            >
              Discard changes
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

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
