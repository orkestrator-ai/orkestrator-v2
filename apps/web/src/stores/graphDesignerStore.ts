import { create } from "zustand";
import type { AgentPlatform } from "@orkestrator/protocol/agent-platforms";
import type { FieldError } from "@orkestrator/protocol/field-validation";
import type { GraphCapabilityCeiling } from "@orkestrator/protocol/graphs/capability-profiles";
import {
  compile,
  type CompiledGraphPlan,
  type GraphCompileCost,
  type GraphCompileDiagnostic,
  type GraphPlanAcknowledgementRef,
} from "@orkestrator/protocol/graphs/compile";
import {
  graphTemplateExportText,
  graphTemplateRefKey,
  type GraphTemplateDetail,
  type GraphTemplateExport,
  type GraphTemplateImportResult,
  type GraphTemplateRef,
  type GraphTemplatesListResult,
  type GraphTemplateSummary,
} from "@orkestrator/protocol/graphs/library";
import {
  parseGraphTemplate,
  validateGraphTemplate,
  type GraphTemplateV1,
} from "@orkestrator/protocol/graphs/template";
import {
  compileGraphTemplateInBackend,
  duplicateGraphTemplate,
  exportGraphTemplate,
  getGraphTemplate,
  importGraphTemplate,
  listGraphTemplates,
  saveGraphTemplate,
  setGraphTemplateTrust,
} from "@/lib/backend/graph-templates";
import {
  acknowledgeGraphWarning,
  graphIdFrom,
} from "@/components/graph-designer/graph-designer-edits";
import {
  EMPTY_GRAPH_HISTORY,
  pushGraphHistory,
  redoGraphHistory,
  undoGraphHistory,
  type GraphEditHistory,
} from "@/components/graph-designer/graph-designer-history";

/**
 * State of the Graphs designer (items 110 and 212): the template library per
 * project and, per designer tab, the template shown, its compile result, the
 * canvas selection and the editor of a user template.
 *
 * Every template, summary and compile result is a backend snapshot: the
 * library and the shown template are re-read on mount, on `graph-template`
 * changes and on view safety checks, so a remounted or reloaded tab shows the
 * same thing. Only an unsaved draft lives here alone (with its bounded undo
 * history), and it is compiled in the browser with the same compiler (107);
 * a stored template is compiled by the backend, under the project's
 * capability ceiling (D18). Saving compares and swaps on the revision the
 * edit started from; a lost race keeps the draft and offers a copy.
 */

export type GraphDesignerSelection =
  { kind: "node"; id: string } | { kind: "edge"; id: string } | { kind: "loop"; id: string } | null;

export type GraphDesignerLoadStatus = "idle" | "loading" | "ready" | "error";

export interface GraphDesignerLibrary {
  status: GraphDesignerLoadStatus;
  result: GraphTemplatesListResult | null;
  error: string | null;
}

/** One compile result, from the backend (stored template) or the browser (draft). */
export interface GraphDesignerCompile {
  source: "backend" | "browser";
  ok: boolean;
  launchable: boolean;
  /** Trust alone stops a launch (backend compiles of project templates). */
  blockedBy?: "untrusted" | "changed";
  diagnostics: GraphCompileDiagnostic[];
  omittedDiagnostics: number;
  cost: GraphCompileCost | null;
  pendingAcknowledgements: GraphPlanAcknowledgementRef[];
  plan: CompiledGraphPlan | null;
}

export interface GraphDesignerEditor {
  /** The template being edited (item 212). Client-only until saved. */
  draft: GraphTemplateV1;
  /** The template as last loaded or saved; `draft !== saved` means unsaved edits. */
  saved: GraphTemplateV1 | null;
  /** The store revision the edit started from; saving compares and swaps on it (0: new). */
  baseRevision: number;
  /** Never saved: "New graph", or a draft opened from elsewhere ("Describe a graph"). */
  isNew: boolean;
  /** Bounded undo/redo over template edits. */
  history: GraphEditHistory;
  saving: boolean;
  error: string | null;
  /** The template guard's reasons the last save was refused before sending. */
  saveErrors: FieldError[];
  /** The last save lost a compare-and-swap: someone saved a newer revision. */
  conflict: boolean;
}

export interface GraphDesignerTabState {
  projectId: string | null;
  selected: GraphTemplateRef | null;
  detail: GraphTemplateDetail | null;
  detailStatus: GraphDesignerLoadStatus;
  detailError: string | null;
  compile: GraphDesignerCompile | null;
  compileStatus: GraphDesignerLoadStatus;
  compileError: string | null;
  selection: GraphDesignerSelection;
  /** Bumped to ask the canvas to bring the selection into view. */
  focusRequest: number;
  editor: GraphDesignerEditor | null;
  /** Load sequence: a response for an older request is dropped. */
  request: number;
}

/** The inputs a browser compile takes from settings and the library. */
export interface GraphDraftCompileContext {
  providers?: readonly AgentPlatform[];
  ceiling?: GraphCapabilityCeiling;
}

interface GraphDesignerState {
  libraries: Map<string, GraphDesignerLibrary>;
  tabs: Map<string, GraphDesignerTabState>;
  loadLibrary: (projectId: string | null) => Promise<void>;
  /** Shows a template in a tab: reads it and compiles it in the backend. */
  openTemplate: (tabId: string, ref: GraphTemplateRef, projectId: string | null) => Promise<void>;
  /** Re-reads the tab's template and compile result (a change or safety check). */
  refreshTab: (tabId: string) => Promise<void>;
  select: (tabId: string, selection: GraphDesignerSelection, focus?: boolean) => void;
  importTemplate: (
    tabId: string,
    text: string,
    projectId: string | null,
  ) => Promise<GraphTemplateImportResult>;
  /** Copies `ref` into a new user template and shows it. */
  duplicateTemplate: (
    tabId: string,
    summary: GraphTemplateSummary,
    projectId: string | null,
  ) => Promise<GraphTemplateDetail>;
  exportTemplate: (ref: GraphTemplateRef) => Promise<GraphTemplateExport>;
  setTrust: (
    summary: GraphTemplateSummary,
    action: "approve" | "revoke",
    tabId?: string,
  ) => Promise<void>;
  /** Starts editing the shown user template on the canvas. */
  openEditor: (tabId: string) => void;
  /**
   * Opens `template` as an unsaved draft (never saved: Save creates it).
   * "New graph" passes a blank template; "Describe a graph" (215) its result.
   */
  openDraft: (tabId: string, template: GraphTemplateV1, projectId: string | null) => void;
  /** Leaves the editor, dropping unsaved edits. */
  closeEditor: (tabId: string) => void;
  /**
   * One undoable edit: `recipe` returns the next template (the same object
   * for no change). Edits with one `coalesce` key in quick succession are one
   * undo step (typing in a field).
   */
  edit: (
    tabId: string,
    label: string,
    recipe: (template: GraphTemplateV1) => GraphTemplateV1,
    options?: { coalesce?: string },
  ) => void;
  undo: (tabId: string) => string | null;
  redo: (tabId: string) => string | null;
  /** Compiles the draft in the browser; called debounced by the tab. */
  compileDraft: (tabId: string, context: GraphDraftCompileContext) => void;
  /** Saves the draft with compare-and-swap on its base revision; the saved detail, or null. */
  saveDraft: (tabId: string) => Promise<GraphTemplateDetail | null>;
  /** Saves the draft as a new user template (after a conflict, or to fork it). */
  saveDraftAsCopy: (tabId: string) => Promise<GraphTemplateDetail | null>;
  /** Drops the draft's edits and starts again from the stored template. */
  reloadDraft: (tabId: string) => Promise<void>;
  /** Records the user's acknowledgement of a warning in the draft (§5.13, D4). */
  acknowledge: (tabId: string, ref: GraphPlanAcknowledgementRef) => void;
}

const EMPTY_TAB: GraphDesignerTabState = Object.freeze({
  projectId: null,
  selected: null,
  detail: null,
  detailStatus: "idle",
  detailError: null,
  compile: null,
  compileStatus: "idle",
  compileError: null,
  selection: null,
  focusRequest: 0,
  editor: null,
  request: 0,
}) as GraphDesignerTabState;

export function graphDesignerLibraryKey(projectId: string | null): string {
  return projectId ?? "";
}

function errorText(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return text.slice(0, 2_000);
}

/** A save refused because the stored revision moved on (`revision-conflict`). */
export function isGraphRevisionConflict(error: unknown): boolean {
  if (
    error &&
    typeof error === "object" &&
    (error as { code?: unknown }).code === "revision-conflict"
  ) {
    return true;
  }
  const message = error instanceof Error ? error.message : String(error);
  return /is at revision \d+, not \d+|was deleted or never saved|revision-conflict/.test(message);
}

/** The backend's compile response as the designer keeps it. */
function fromBackend(
  response: Awaited<ReturnType<typeof compileGraphTemplateInBackend>>,
): GraphDesignerCompile {
  return {
    source: "backend",
    ok: response.ok,
    launchable: response.launchable,
    ...(response.blockedBy ? { blockedBy: response.blockedBy } : {}),
    diagnostics: response.diagnostics,
    omittedDiagnostics: response.omittedDiagnostics,
    cost: response.cost,
    pendingAcknowledgements: response.pendingAcknowledgements,
    plan: response.plan ?? null,
  };
}

/**
 * JSON text to a template, or the reasons it is not one. `value` is the
 * parsed JSON when only the schema refused it: the compiler still reports
 * that as located `template-invalid` diagnostics.
 */
export function parseGraphDraft(
  text: string,
): { ok: true; template: GraphTemplateV1 } | { ok: false; errors: FieldError[]; value?: unknown } {
  const parsed = parseGraphTemplate(text);
  if (parsed.ok) return { ok: true, template: parsed.value };
  const syntax = parsed.errors.some(
    (error) => error.code === "invalid_json" || error.code === "too_large",
  );
  return syntax
    ? { ok: false, errors: parsed.errors }
    : { ok: false, errors: parsed.errors, value: JSON.parse(text) };
}

function freshEditor(
  template: GraphTemplateV1,
  revision: number,
  isNew: boolean,
): GraphDesignerEditor {
  return {
    draft: template,
    saved: template,
    baseRevision: revision,
    isNew,
    history: EMPTY_GRAPH_HISTORY,
    saving: false,
    error: null,
    saveErrors: [],
    conflict: false,
  };
}

/** Unsaved edits in the tab's editor (a new draft always counts). */
export function graphDraftDirty(editor: GraphDesignerEditor | null): boolean {
  return editor !== null && (editor.isNew || editor.draft !== editor.saved);
}

export const useGraphDesignerStore = create<GraphDesignerState>()((set, get) => {
  const tab = (tabId: string) => get().tabs.get(tabId) ?? EMPTY_TAB;
  const patchTab = (tabId: string, patch: Partial<GraphDesignerTabState>) =>
    set((state) => {
      const tabs = new Map(state.tabs);
      tabs.set(tabId, { ...(state.tabs.get(tabId) ?? EMPTY_TAB), ...patch });
      return { tabs };
    });
  /** Patches only while `request` is still the tab's latest load. */
  const patchIfCurrent = (
    tabId: string,
    request: number,
    patch: Partial<GraphDesignerTabState>,
  ) => {
    if (tab(tabId).request !== request) return;
    patchTab(tabId, patch);
  };
  const patchEditor = (tabId: string, patch: Partial<GraphDesignerEditor>) => {
    const editor = tab(tabId).editor;
    if (editor) patchTab(tabId, { editor: { ...editor, ...patch } });
  };

  /** After a save: the editor continues on the stored template (history kept). */
  const rebase = (tabId: string, saved: GraphTemplateDetail) => {
    const editor = tab(tabId).editor;
    patchTab(tabId, {
      detail: saved,
      selected: saved.summary.ref,
      detailStatus: "ready",
      detailError: null,
      editor: {
        ...freshEditor(saved.template, saved.summary.revision, false),
        history: editor?.history ?? EMPTY_GRAPH_HISTORY,
      },
    });
  };

  const load = async (tabId: string, ref: GraphTemplateRef, projectId: string | null) => {
    const request = tab(tabId).request + 1;
    const sameTemplate =
      tab(tabId).selected !== null &&
      graphTemplateRefKey(tab(tabId).selected!) === graphTemplateRefKey(ref);
    patchTab(tabId, {
      projectId,
      selected: ref,
      request,
      detailStatus: "loading",
      detailError: null,
      compileStatus: "loading",
      compileError: null,
      ...(sameTemplate ? {} : { detail: null, compile: null, selection: null, editor: null }),
    });
    const input = projectId ? { projectId } : {};
    const [detail, compiled] = await Promise.allSettled([
      getGraphTemplate(ref, input),
      compileGraphTemplateInBackend({ ref }, { ...input, includePlan: true }),
    ]);
    patchIfCurrent(
      tabId,
      request,
      detail.status === "fulfilled"
        ? { detail: detail.value, detailStatus: "ready", detailError: null }
        : { detail: null, detailStatus: "error", detailError: errorText(detail.reason) },
    );
    // A draft being edited keeps its own browser compile.
    if (tab(tabId).editor) {
      patchIfCurrent(tabId, request, { compileStatus: "ready", compileError: null });
      return;
    }
    patchIfCurrent(
      tabId,
      request,
      compiled.status === "fulfilled"
        ? { compile: fromBackend(compiled.value), compileStatus: "ready", compileError: null }
        : { compileStatus: "error", compileError: errorText(compiled.reason) },
    );
  };

  return {
    libraries: new Map(),
    tabs: new Map(),

    loadLibrary: async (projectId) => {
      const key = graphDesignerLibraryKey(projectId);
      const previous = get().libraries.get(key);
      const mark = (library: GraphDesignerLibrary) =>
        set((state) => {
          const libraries = new Map(state.libraries);
          libraries.set(key, library);
          return { libraries };
        });
      mark({ status: "loading", result: previous?.result ?? null, error: null });
      try {
        const result = await listGraphTemplates(projectId ? { projectId } : {});
        mark({ status: "ready", result, error: null });
      } catch (error) {
        mark({ status: "error", result: previous?.result ?? null, error: errorText(error) });
      }
    },

    openTemplate: (tabId, ref, projectId) => load(tabId, ref, projectId),

    refreshTab: async (tabId) => {
      const current = tab(tabId);
      if (!current.selected) return;
      await load(tabId, current.selected, current.projectId);
    },

    select: (tabId, selection, focus = false) => {
      const current = tab(tabId);
      patchTab(tabId, {
        selection,
        ...(focus ? { focusRequest: current.focusRequest + 1 } : {}),
      });
    },

    importTemplate: async (tabId, text, projectId) => {
      const result = await importGraphTemplate(text, projectId ? { projectId } : {});
      if (result.ok) {
        await get().loadLibrary(projectId);
        await load(tabId, result.detail.summary.ref, projectId);
      }
      return result;
    },

    duplicateTemplate: async (tabId, summary, projectId) => {
      const detail = await duplicateGraphTemplate(summary.ref, {
        ...(summary.scope === "project" ? { digest: summary.digest } : {}),
        ...(projectId ? { projectId } : {}),
      });
      await get().loadLibrary(projectId);
      await load(tabId, detail.summary.ref, projectId);
      return detail;
    },

    exportTemplate: (ref) => exportGraphTemplate(ref),

    setTrust: async (summary, action, tabId) => {
      if (summary.ref.scope !== "project") return;
      const { projectId, path } = summary.ref;
      await setGraphTemplateTrust(
        action === "approve"
          ? { projectId, path, action, digest: summary.digest }
          : { projectId, path, action },
      );
      await get().loadLibrary(projectId);
      if (tabId) await get().refreshTab(tabId);
    },

    openEditor: (tabId) => {
      const detail = tab(tabId).detail;
      if (!detail || detail.summary.scope !== "user") return;
      patchTab(tabId, { editor: freshEditor(detail.template, detail.summary.revision, false) });
    },

    openDraft: (tabId, template, projectId) => {
      const draft = { ...structuredClone(template), revision: 0 };
      delete draft.engine;
      patchTab(tabId, {
        projectId,
        selected: null,
        detail: null,
        detailStatus: "idle",
        detailError: null,
        compile: null,
        compileStatus: "idle",
        compileError: null,
        selection: null,
        request: tab(tabId).request + 1,
        editor: { ...freshEditor(draft, 0, true), saved: null },
      });
    },

    closeEditor: (tabId) => {
      const wasNew = tab(tabId).editor?.isNew ?? false;
      patchTab(tabId, { editor: null, ...(wasNew ? { compile: null, selection: null } : {}) });
      if (!wasNew) void get().refreshTab(tabId);
    },

    edit: (tabId, label, recipe, options = {}) => {
      const editor = tab(tabId).editor;
      if (!editor) return;
      const next = recipe(editor.draft);
      if (next === editor.draft) return;
      patchEditor(tabId, {
        draft: next,
        history: pushGraphHistory(editor.history, editor.draft, label, options),
        error: null,
        saveErrors: [],
      });
    },

    undo: (tabId) => {
      const editor = tab(tabId).editor;
      if (!editor) return null;
      const step = undoGraphHistory(editor.history, editor.draft);
      if (!step) return null;
      patchEditor(tabId, { draft: step.template, history: step.history, error: null });
      return step.label;
    },

    redo: (tabId) => {
      const editor = tab(tabId).editor;
      if (!editor) return null;
      const step = redoGraphHistory(editor.history, editor.draft);
      if (!step) return null;
      patchEditor(tabId, { draft: step.template, history: step.history, error: null });
      return step.label;
    },

    compileDraft: (tabId, context) => {
      const editor = tab(tabId).editor;
      if (!editor) return;
      const result = compile(editor.draft, {
        ...(context.providers && context.providers.length > 0
          ? { providers: [...context.providers] }
          : {}),
        ...(context.ceiling ? { ceiling: context.ceiling } : {}),
      });
      // A newer edit may have landed meanwhile; the next debounce compiles it.
      if (tab(tabId).editor?.draft !== editor.draft) return;
      patchTab(tabId, {
        compile: {
          source: "browser",
          ok: result.ok,
          launchable: result.launchable,
          diagnostics: result.diagnostics,
          omittedDiagnostics: result.omittedDiagnostics,
          cost: result.cost,
          pendingAcknowledgements: result.pendingAcknowledgements,
          plan: result.plan,
        },
        compileStatus: "ready",
        compileError: null,
      });
    },

    saveDraft: async (tabId) => {
      const current = tab(tabId);
      const editor = current.editor;
      if (!editor || editor.saving) return null;
      const template = { ...editor.draft, revision: editor.baseRevision };
      const guard = validateGraphTemplate(template);
      if (!guard.ok) {
        patchEditor(tabId, {
          saveErrors: guard.errors,
          error: "The template is not complete yet; fix these before saving.",
        });
        return null;
      }
      patchEditor(tabId, { saving: true, error: null, saveErrors: [], conflict: false });
      try {
        const saved = await saveGraphTemplate(template, {
          expectedRevision: editor.baseRevision,
          ...(current.projectId ? { projectId: current.projectId } : {}),
        });
        rebase(tabId, saved);
        void get().loadLibrary(current.projectId);
        return saved;
      } catch (error) {
        const conflict = isGraphRevisionConflict(error);
        patchEditor(tabId, {
          saving: false,
          conflict,
          error: conflict
            ? editor.isNew
              ? `A template with the id ${editor.draft.id} already exists. Save as a copy, or change the id.`
              : `Someone saved this template since you started editing (your edit is based on revision ${editor.baseRevision}). Your edits are kept: save them as a copy, or reload the latest revision.`
            : errorText(error),
        });
        return null;
      }
    },

    saveDraftAsCopy: async (tabId) => {
      const current = tab(tabId);
      const editor = current.editor;
      if (!editor || editor.saving) return null;
      const draft = editor.draft;
      const copy: GraphTemplateV1 = {
        ...draft,
        id: editor.isNew ? draft.id : graphIdFrom(`${draft.id}-copy`, "graph-copy"),
        name: editor.isNew ? draft.name : `${draft.name} (copy)`.slice(0, 200),
        revision: 0,
      };
      const guard = validateGraphTemplate(copy);
      if (!guard.ok) {
        patchEditor(tabId, {
          saveErrors: guard.errors,
          error: "The template is not complete yet; fix these before saving.",
        });
        return null;
      }
      patchEditor(tabId, { saving: true, error: null, saveErrors: [], conflict: false });
      try {
        // Import picks a free id when the copy's is taken.
        const result = await importGraphTemplate(
          graphTemplateExportText(copy),
          current.projectId ? { projectId: current.projectId } : {},
        );
        if (!result.ok) {
          patchEditor(tabId, {
            saving: false,
            saveErrors: result.errors,
            error: "The copy was refused.",
          });
          return null;
        }
        rebase(tabId, result.detail);
        void get().loadLibrary(current.projectId);
        return result.detail;
      } catch (error) {
        patchEditor(tabId, { saving: false, error: errorText(error) });
        return null;
      }
    },

    reloadDraft: async (tabId) => {
      const current = tab(tabId);
      if (!current.selected) return;
      const detail = await getGraphTemplate(
        current.selected,
        current.projectId ? { projectId: current.projectId } : {},
      );
      patchTab(tabId, {
        detail,
        editor: freshEditor(detail.template, detail.summary.revision, false),
      });
    },

    acknowledge: (tabId, ref) => {
      get().edit(tabId, `Acknowledge ${ref.code}`, (template) =>
        acknowledgeGraphWarning(template, ref),
      );
    },
  };
});

/** A tab's state, or the empty state before its first load. */
export function graphDesignerTab(tabId: string): GraphDesignerTabState {
  return useGraphDesignerStore.getState().tabs.get(tabId) ?? EMPTY_TAB;
}

export const EMPTY_GRAPH_DESIGNER_TAB = EMPTY_TAB;
