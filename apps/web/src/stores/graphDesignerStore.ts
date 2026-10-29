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
import { parseGraphTemplate, type GraphTemplateV1 } from "@orkestrator/protocol/graphs/template";
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

/**
 * State of the Graphs designer (item 110): the template library per project
 * and, per designer tab, the template shown, its compile result, the canvas
 * selection and the JSON editor of a user template.
 *
 * Every template, summary and compile result is a backend snapshot: the
 * library and the shown template are re-read on mount, on `graph-template`
 * changes and on view safety checks, so a remounted or reloaded tab shows the
 * same thing. Only an unsaved JSON draft lives here alone, and it is compiled
 * in the browser with the same compiler (107); a stored template is compiled
 * by the backend, under the project's capability ceiling (D18).
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
  /** The JSON being edited. */
  text: string;
  /** The store revision the edit started from; saving compares and swaps on it. */
  baseRevision: number;
  /** Why the text is not a template (JSON or schema), when it is not. */
  parseErrors: FieldError[];
  saving: boolean;
  error: string | null;
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
  openEditor: (tabId: string) => void;
  closeEditor: (tabId: string) => void;
  editDraft: (tabId: string, text: string) => void;
  /** Compiles the draft in the browser; called debounced by the editor. */
  compileDraft: (tabId: string, context: GraphDraftCompileContext) => void;
  /** Saves the draft with compare-and-swap on its base revision. */
  saveDraft: (tabId: string) => Promise<boolean>;
  /** Drops the draft's edits and starts again from the stored template. */
  reloadDraft: (tabId: string) => Promise<void>;
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
    if (tab(tabId).editor) return;
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
      patchTab(tabId, {
        editor: {
          text: graphTemplateExportText(detail.template),
          baseRevision: detail.summary.revision,
          parseErrors: [],
          saving: false,
          error: null,
          conflict: false,
        },
      });
    },

    closeEditor: (tabId) => {
      patchTab(tabId, { editor: null });
      void get().refreshTab(tabId);
    },

    editDraft: (tabId, text) => patchEditor(tabId, { text, error: null }),

    compileDraft: (tabId, context) => {
      const editor = tab(tabId).editor;
      if (!editor) return;
      const parsed = parseGraphDraft(editor.text);
      if (!parsed.ok && parsed.value === undefined) {
        patchEditor(tabId, { parseErrors: parsed.errors });
        return;
      }
      const result = compile(parsed.ok ? parsed.template : parsed.value, {
        ...(context.providers && context.providers.length > 0
          ? { providers: [...context.providers] }
          : {}),
        ...(context.ceiling ? { ceiling: context.ceiling } : {}),
      });
      patchTab(tabId, {
        editor: { ...tab(tabId).editor!, parseErrors: [] },
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
      if (!editor || editor.saving) return false;
      const parsed = parseGraphDraft(editor.text);
      if (!parsed.ok) {
        patchEditor(tabId, { parseErrors: parsed.errors, error: "Fix the errors before saving." });
        return false;
      }
      patchEditor(tabId, { saving: true, error: null, conflict: false });
      try {
        const saved = await saveGraphTemplate(parsed.template, {
          expectedRevision: editor.baseRevision,
          ...(current.projectId ? { projectId: current.projectId } : {}),
        });
        patchTab(tabId, {
          detail: saved,
          selected: saved.summary.ref,
          editor: {
            text: graphTemplateExportText(saved.template),
            baseRevision: saved.summary.revision,
            parseErrors: [],
            saving: false,
            error: null,
            conflict: false,
          },
        });
        void get().loadLibrary(current.projectId);
        return true;
      } catch (error) {
        patchEditor(tabId, {
          saving: false,
          conflict: isGraphRevisionConflict(error),
          error: isGraphRevisionConflict(error)
            ? `Someone saved this template since you started editing (your edit is based on revision ${editor.baseRevision}). Your text is kept: copy what you need, then reload the latest revision.`
            : errorText(error),
        });
        return false;
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
        editor: {
          text: graphTemplateExportText(detail.template),
          baseRevision: detail.summary.revision,
          parseErrors: [],
          saving: false,
          error: null,
          conflict: false,
        },
      });
    },
  };
});

/** A tab's state, or the empty state before its first load. */
export function graphDesignerTab(tabId: string): GraphDesignerTabState {
  return useGraphDesignerStore.getState().tabs.get(tabId) ?? EMPTY_TAB;
}

export const EMPTY_GRAPH_DESIGNER_TAB = EMPTY_TAB;
