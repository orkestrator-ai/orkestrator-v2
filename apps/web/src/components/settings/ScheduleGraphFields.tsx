import { useEffect, useMemo, useState } from "react";
import { Loader2 } from "lucide-react";
import {
  graphTemplateRefKey,
  type GraphTemplateSummary,
} from "@orkestrator/protocol/graphs/library";
import {
  GraphLaunchEnvironmentField,
  GraphLaunchInputField,
  GraphLaunchParamField,
} from "@/components/graph-launch/GraphLaunchFields";
import { GraphLaunchRoleField } from "@/components/graph-launch/GraphLaunchRoleField";
import {
  graphLaunchTicketInput,
  graphTemplateLaunchBlocker,
  type GraphLaunchDraft,
} from "@/components/graph-launch/graph-launch-model";
import { flatCatalog } from "@/components/review/MultiReviewLaunchDialog";
import { useReviewLensPresets } from "@/components/review/ReviewLensField";
import { Checkbox } from "@/components/ui/checkbox";
import { useReviewModelCatalog } from "@/hooks/useBuildLaunchOptions";
import { getGraphLaunchOptions } from "@/lib/backend/graph-launch";
import { listGraphTemplates } from "@/lib/backend/graph-templates";
import { useEnvironmentStore } from "@/stores/environmentStore";
import { useKanbanStore } from "@/stores/kanbanStore";
import {
  graphScheduleOptionsQuery,
  graphScheduleWithOptions,
  type GraphScheduleForm,
} from "./graph-schedule-model";

const SELECT_CLASS =
  "h-9 w-full min-w-0 rounded-md border border-zinc-700/80 bg-zinc-900 px-2 text-sm text-zinc-200 disabled:opacity-60";

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The "Run a graph" action of a schedule (item 214): project, a launchable
 * template, where each run works and its inputs, with roles and parameters
 * either left to the template's saved launch defaults at fire time or pinned
 * here with the launch dialog's own pickers. Controlled: the dialog owns the
 * {@link GraphScheduleForm}; this component reads the template list and the
 * launch options and reports every change through `onChange`.
 */
export function ScheduleGraphFields({
  form,
  projects,
  onChange,
}: {
  form: GraphScheduleForm;
  projects: ReadonlyArray<{ id: string; name: string }>;
  onChange: (update: (current: GraphScheduleForm) => GraphScheduleForm) => void;
}) {
  const [templates, setTemplates] = useState<{
    projectId: string;
    list: GraphTemplateSummary[];
  } | null>(null);
  const [templatesError, setTemplatesError] = useState<string | null>(null);
  const [optionsError, setOptionsError] = useState<string | null>(null);
  const { projectId, ref, options, draft } = form;

  const catalog = useReviewModelCatalog(projectId, Boolean(projectId) && !form.useDefaults);
  const models = useMemo(() => flatCatalog(catalog), [catalog]);
  const lensPresets = useReviewLensPresets();
  const allEnvironments = useEnvironmentStore((state) => state.environments);
  const environments = useMemo(
    () =>
      allEnvironments.filter(
        (environment) => environment.projectId === projectId && !environment.deletionRequestedAt,
      ),
    [allEnvironments, projectId],
  );
  const allTasks = useKanbanStore((state) => state.tasks);
  const loadTasks = useKanbanStore((state) => state.loadTasks);
  const tickets = useMemo(
    () => (allTasks ?? []).filter((task) => task.projectId === projectId),
    [allTasks, projectId],
  );
  const ticketInput = options ? graphLaunchTicketInput(options) : null;

  useEffect(() => {
    if (!projectId) return;
    let cancelled = false;
    listGraphTemplates({ projectId })
      .then((result) => {
        if (cancelled) return;
        setTemplates({ projectId, list: result.templates });
        setTemplatesError(null);
      })
      .catch((error: unknown) => {
        if (!cancelled) setTemplatesError(errorText(error));
      });
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  useEffect(() => {
    if (projectId && ticketInput) void loadTasks(projectId);
  }, [projectId, ticketInput, loadTasks]);

  // Compiled for the chosen environment, as the launch dialog does; the draft
  // survives a re-read.
  const query = graphScheduleOptionsQuery(form);
  const queryKey =
    projectId && ref
      ? `${projectId}|${graphTemplateRefKey(ref)}|${query.environmentId ?? ""}|${query.create ?? ""}`
      : null;
  useEffect(() => {
    if (!queryKey || !ref) return;
    let cancelled = false;
    const [queriedProject, , environmentId, create] = queryKey.split("|");
    getGraphLaunchOptions({
      ref,
      projectId: queriedProject!,
      ...(environmentId ? { environmentId } : {}),
      ...(create === "worktree" || create === "container" ? { create } : {}),
    })
      .then((result) => {
        if (cancelled) return;
        setOptionsError(null);
        onChange((current) =>
          current.projectId === queriedProject &&
          current.ref &&
          graphTemplateRefKey(current.ref) === graphTemplateRefKey(ref)
            ? graphScheduleWithOptions(current, result)
            : current,
        );
      })
      .catch((error: unknown) => {
        if (!cancelled) setOptionsError(errorText(error));
      });
    return () => {
      cancelled = true;
    };
    // `onChange` is the dialog's state setter (stable); `ref` changes only with an edit.
  }, [queryKey, ref, onChange]);

  const edit = (patch: Partial<GraphScheduleForm>) =>
    onChange((current) => ({ ...current, ...patch, touched: true }));
  const editDraft = (patch: Partial<GraphLaunchDraft>) =>
    onChange((current) =>
      current.draft
        ? { ...current, draft: { ...current.draft, ...patch }, touched: true }
        : current,
    );
  const listed = templates?.projectId === projectId ? templates.list : null;

  return (
    <div className="space-y-4" data-testid="schedule-graph-fields">
      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1.5">
          <label htmlFor="schedule-graph-project" className="text-sm font-medium">
            Project
          </label>
          <select
            id="schedule-graph-project"
            className={SELECT_CLASS}
            value={projectId}
            onChange={(event) =>
              edit({ projectId: event.target.value, ref: null, options: null, draft: null })
            }
          >
            <option value="">Choose a project…</option>
            {projects.map((project) => (
              <option key={project.id} value={project.id}>
                {project.name}
              </option>
            ))}
          </select>
        </div>
        <div className="space-y-1.5">
          <label htmlFor="schedule-graph-template" className="text-sm font-medium">
            Template
          </label>
          {templatesError ? (
            <p className="text-xs text-red-400">Could not list templates: {templatesError}</p>
          ) : (
            <select
              id="schedule-graph-template"
              className={SELECT_CLASS}
              disabled={!projectId}
              value={ref ? graphTemplateRefKey(ref) : ""}
              onChange={(event) => {
                const summary = listed?.find(
                  (entry) => graphTemplateRefKey(entry.ref) === event.target.value,
                );
                edit({ ref: summary?.ref ?? null, options: null, draft: null });
              }}
            >
              <option value="">
                {!projectId
                  ? "Choose a project first"
                  : listed
                    ? "Choose a template…"
                    : "Loading templates…"}
              </option>
              {/* The stored template, while the list loads or when it is no longer listed. */}
              {ref &&
              !listed?.some(
                (entry) => graphTemplateRefKey(entry.ref) === graphTemplateRefKey(ref),
              ) ? (
                <option value={graphTemplateRefKey(ref)}>
                  {ref.scope === "project" ? ref.path : ref.id}
                </option>
              ) : null}
              {(listed ?? []).map((summary) => {
                const blocker = graphTemplateLaunchBlocker(summary);
                return (
                  <option
                    key={graphTemplateRefKey(summary.ref)}
                    value={graphTemplateRefKey(summary.ref)}
                    disabled={blocker !== null}
                  >
                    {summary.name}
                    {blocker ? ` — ${blocker}` : ""}
                  </option>
                );
              })}
            </select>
          )}
        </div>
      </div>

      {ref && !options && !optionsError ? (
        <p className="flex items-center gap-2 text-xs text-muted-foreground">
          <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
          Compiling the template for launch…
        </p>
      ) : null}
      {optionsError ? <p className="text-xs text-red-400">{optionsError}</p> : null}

      {options && draft ? (
        <>
          {!options.launchable ? (
            <p
              role="alert"
              className="rounded-md border border-red-500/40 p-2 text-xs text-red-300"
            >
              {options.blockedReason ?? "This template cannot be launched."}
            </p>
          ) : null}
          {options.inputs.length > 0 ? (
            <section aria-label="Graph inputs" className="space-y-2">
              <h3 className="text-xs font-semibold text-foreground">Inputs</h3>
              {options.inputs.map((input) => (
                <GraphLaunchInputField
                  key={input.name}
                  input={input}
                  draft={draft}
                  ticketInput={ticketInput?.name ?? null}
                  tickets={tickets}
                  onText={(text) => editDraft({ inputs: { ...draft.inputs, [input.name]: text } })}
                  onTicket={(taskId) => editDraft({ ticketTaskId: taskId })}
                />
              ))}
            </section>
          ) : null}
          <GraphLaunchEnvironmentField
            options={options}
            draft={draft}
            environments={environments}
            onChange={(environment, environmentId) => editDraft({ environment, environmentId })}
          />
          {options.roles.length > 0 || options.parameters.length > 0 ? (
            <div className="flex items-start gap-2">
              <Checkbox
                id="schedule-graph-defaults"
                checked={form.useDefaults}
                onCheckedChange={(checked) => edit({ useDefaults: checked === true })}
              />
              <div className="min-w-0">
                <label htmlFor="schedule-graph-defaults" className="text-xs font-medium">
                  Use the saved launch defaults
                </label>
                <p className="text-[11px] leading-snug text-muted-foreground">
                  Each run takes the roles and parameters last saved for this template in this
                  project (Run graph… saves them), else Settings and the template's own. Turn off to
                  pin them here.
                </p>
              </div>
            </div>
          ) : null}
          {!form.useDefaults && options.roles.length > 0 ? (
            <section aria-label="Graph roles" className="space-y-3">
              <h3 className="text-xs font-semibold text-foreground">Roles</h3>
              {options.roles.map((option) => (
                <GraphLaunchRoleField
                  key={option.role.key}
                  option={option}
                  members={draft.roles[option.role.key] ?? []}
                  catalog={catalog}
                  models={models}
                  lensPresets={lensPresets}
                  onChange={(members) =>
                    editDraft({ roles: { ...draft.roles, [option.role.key]: members } })
                  }
                />
              ))}
            </section>
          ) : null}
          {!form.useDefaults && options.parameters.length > 0 ? (
            <section aria-label="Graph parameters" className="space-y-2">
              <h3 className="text-xs font-semibold text-foreground">Parameters</h3>
              {options.parameters.map((parameter) => (
                <GraphLaunchParamField
                  key={parameter.key}
                  parameter={parameter}
                  value={draft.params[parameter.key]}
                  onChange={(value) =>
                    editDraft({ params: { ...draft.params, [parameter.key]: value } })
                  }
                />
              ))}
            </section>
          ) : null}
        </>
      ) : null}
    </div>
  );
}
