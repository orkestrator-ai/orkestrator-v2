import { useEffect, useMemo, useState } from "react";
import { Loader2, Network } from "lucide-react";
import type { GraphLaunchOptions, GraphLaunchResult } from "@orkestrator/protocol/graphs/launch";
import {
  graphTemplateRefKey,
  type GraphTemplateRef,
  type GraphTemplateSummary,
} from "@orkestrator/protocol/graphs/library";
import { flatCatalog } from "@/components/review/MultiReviewLaunchDialog";
import { useReviewLensPresets } from "@/components/review/ReviewLensField";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useReviewModelCatalog } from "@/hooks/useBuildLaunchOptions";
import { getGraphLaunchOptions, launchGraphRun } from "@/lib/backend/graph-launch";
import { listGraphTemplates } from "@/lib/backend/graph-templates";
import { createUuid } from "@/lib/uuid";
import { useEnvironmentStore } from "@/stores/environmentStore";
import { useKanbanStore } from "@/stores/kanbanStore";
import {
  GraphLaunchEnvironmentField,
  GraphLaunchInputField,
  GraphLaunchParamField,
} from "./GraphLaunchFields";
import { GraphLaunchRoleField } from "./GraphLaunchRoleField";
import {
  graphLaunchCost,
  graphLaunchProblems,
  graphLaunchRequest,
  graphLaunchTicketInput,
  graphTemplateLaunchBlocker,
  initialGraphLaunchDraft,
  type GraphLaunchDraft,
} from "./graph-launch-model";

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export interface GraphLaunchDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projectId: string;
  /** The template to launch; without one the dialog starts with a template picker. */
  template?: GraphTemplateRef | null;
  /** The environment the dialog was opened in, preselected as "existing". */
  environmentId?: string | null;
  /** A Kanban ticket that fills the template's ticket input. */
  ticketTaskId?: string | null;
  onLaunched?: (result: GraphLaunchResult) => void;
}

/**
 * "Run graph…" (item 214, D17): a launch form generated from a saved
 * template. It shows the template's run inputs (a Kanban ticket fills a
 * `ticket@1` input), one picker per role offering only the providers that
 * meet each step's enforcement floor and can return its typed results (the
 * others are listed with the reason), panel editors with a focus per member,
 * the template's parameters, the environment choice and a cost estimate.
 * Everything comes from the backend's `graph_launch_options`, which compiles
 * the template for the chosen environment; the launch saves the choices as
 * the template's defaults for the project.
 */
export function GraphLaunchDialog({
  open,
  onOpenChange,
  projectId,
  template = null,
  environmentId = null,
  ticketTaskId = null,
  onLaunched,
}: GraphLaunchDialogProps) {
  const [chosen, setChosen] = useState<GraphTemplateRef | null>(template);
  const [templates, setTemplates] = useState<GraphTemplateSummary[] | null>(null);
  const [templatesError, setTemplatesError] = useState<string | null>(null);
  const [options, setOptions] = useState<GraphLaunchOptions | null>(null);
  const [optionsError, setOptionsError] = useState<string | null>(null);
  const [draft, setDraft] = useState<GraphLaunchDraft | null>(null);
  const [launching, setLaunching] = useState(false);
  const [launchError, setLaunchError] = useState<string | null>(null);
  const [requestId, setRequestId] = useState(createUuid);
  const [openedFor, setOpenedFor] = useState<string | null>(null);

  // Each opening starts afresh from the template it was opened with.
  const openKey = open
    ? `${template ? graphTemplateRefKey(template) : ""}|${ticketTaskId ?? ""}`
    : null;
  if (openKey !== openedFor) {
    setOpenedFor(openKey);
    if (openKey !== null) {
      setChosen(template);
      setOptions(null);
      setOptionsError(null);
      setDraft(null);
      setLaunchError(null);
      setRequestId(createUuid());
    }
  }

  const catalog = useReviewModelCatalog(projectId, open);
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

  // The template picker lists the project's templates when none was given.
  useEffect(() => {
    if (!open || template) return;
    let cancelled = false;
    listGraphTemplates({ projectId })
      .then((result) => {
        if (!cancelled) setTemplates(result.templates);
      })
      .catch((error: unknown) => {
        if (!cancelled) setTemplatesError(errorText(error));
      });
    return () => {
      cancelled = true;
    };
  }, [open, template, projectId]);

  useEffect(() => {
    if (open && ticketInput) void loadTasks(projectId);
  }, [open, ticketInput, loadTasks, projectId]);

  // The options are compiled for the environment chosen: re-read them when
  // it changes, keeping the user's draft.
  const environmentQuery =
    draft === null
      ? { environmentId }
      : draft.environment === "existing"
        ? { environmentId: draft.environmentId }
        : { create: draft.environment === "new-container" ? "container" : "worktree" };
  const queryKey = chosen
    ? `${graphTemplateRefKey(chosen)}|${environmentQuery.environmentId ?? ""}|${environmentQuery.create ?? ""}`
    : null;
  useEffect(() => {
    if (!open || !chosen || !queryKey) return;
    let cancelled = false;
    const [, queriedEnvironment, create] = queryKey.split("|");
    getGraphLaunchOptions({
      ref: chosen,
      projectId,
      ...(queriedEnvironment ? { environmentId: queriedEnvironment } : {}),
      ...(create === "worktree" || create === "container" ? { create } : {}),
    })
      .then((result) => {
        if (cancelled) return;
        setOptions(result);
        setOptionsError(null);
        setDraft(
          (current) => current ?? initialGraphLaunchDraft(result, { environmentId, ticketTaskId }),
        );
      })
      .catch((error: unknown) => {
        if (!cancelled) setOptionsError(errorText(error));
      });
    return () => {
      cancelled = true;
    };
  }, [open, chosen, queryKey, projectId, environmentId, ticketTaskId]);

  const problems = options && draft ? graphLaunchProblems(options, draft) : [];
  const cost = options && draft ? graphLaunchCost(options, draft) : null;
  const update = (patch: Partial<GraphLaunchDraft>) =>
    setDraft((current) => (current ? { ...current, ...patch } : current));

  const launch = async () => {
    if (!chosen || !options || !draft || problems.length > 0) return;
    setLaunching(true);
    setLaunchError(null);
    try {
      const result = await launchGraphRun(
        graphLaunchRequest({ ref: chosen, projectId, options, draft, requestId }),
      );
      onOpenChange(false);
      onLaunched?.(result);
    } catch (error) {
      setLaunchError(errorText(error));
    } finally {
      setLaunching(false);
    }
  };

  const title = options?.summary.name ?? "Run graph";
  return (
    <Dialog open={open} onOpenChange={(next) => !launching && onOpenChange(next)}>
      <DialogContent className="flex max-h-[90vh] flex-col gap-3 sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Network aria-hidden className="size-4 text-indigo-400" />
            {chosen ? `Run ${title}` : "Run graph"}
          </DialogTitle>
          <DialogDescription>
            {options?.summary.description ??
              "Launch a saved graph template. Each role runs on a provider that meets its steps' floors."}
          </DialogDescription>
        </DialogHeader>
        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto pr-1">
          {!template && (
            <div className="space-y-1">
              <label
                htmlFor="graph-launch-template"
                className="text-xs font-semibold text-foreground"
              >
                Template
              </label>
              {templatesError ? (
                <p className="text-xs text-red-400">Could not list templates: {templatesError}</p>
              ) : (
                <select
                  id="graph-launch-template"
                  value={chosen ? graphTemplateRefKey(chosen) : ""}
                  onChange={(event) => {
                    const summary = templates?.find(
                      (entry) => graphTemplateRefKey(entry.ref) === event.target.value,
                    );
                    setChosen(summary?.ref ?? null);
                    setOptions(null);
                    setDraft(null);
                  }}
                  className="h-8 w-full rounded-md border border-zinc-700/80 bg-zinc-900 px-2 text-xs text-zinc-200"
                >
                  <option value="">
                    {templates ? "Choose a template…" : "Loading templates…"}
                  </option>
                  {(templates ?? []).map((summary) => {
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
          )}
          {chosen && !options && !optionsError && (
            <p className="flex items-center gap-2 text-xs text-muted-foreground">
              <Loader2 className="size-3.5 animate-spin" />
              Compiling the template for launch…
            </p>
          )}
          {optionsError && <p className="text-xs text-red-400">{optionsError}</p>}
          {options && draft && (
            <>
              {!options.launchable && (
                <div
                  role="alert"
                  className="rounded-md border border-red-500/40 p-2 text-xs text-red-300"
                >
                  {options.blockedReason ?? "This template cannot be launched."}
                  {options.errors.slice(0, 5).map((diagnostic, index) => (
                    <p key={index} className="mt-1 text-[11px]">
                      {diagnostic.nodeId ? `${diagnostic.nodeId}: ` : ""}
                      {diagnostic.message}
                    </p>
                  ))}
                </div>
              )}
              {options.inputs.length > 0 && (
                <section aria-label="Inputs" className="space-y-2">
                  <h3 className="text-xs font-semibold text-foreground">Inputs</h3>
                  {options.inputs.map((input) => (
                    <GraphLaunchInputField
                      key={input.name}
                      input={input}
                      draft={draft}
                      ticketInput={ticketInput?.name ?? null}
                      tickets={tickets}
                      onText={(text) => update({ inputs: { ...draft.inputs, [input.name]: text } })}
                      onTicket={(taskId) => update({ ticketTaskId: taskId })}
                    />
                  ))}
                </section>
              )}
              {options.roles.length > 0 && (
                <section aria-label="Roles" className="space-y-3">
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
                        update({ roles: { ...draft.roles, [option.role.key]: members } })
                      }
                    />
                  ))}
                </section>
              )}
              {options.parameters.length > 0 && (
                <section aria-label="Parameters" className="space-y-2">
                  <h3 className="text-xs font-semibold text-foreground">Parameters</h3>
                  {options.parameters.map((parameter) => (
                    <GraphLaunchParamField
                      key={parameter.key}
                      parameter={parameter}
                      value={draft.params[parameter.key]}
                      onChange={(value) =>
                        update({ params: { ...draft.params, [parameter.key]: value } })
                      }
                    />
                  ))}
                </section>
              )}
              <GraphLaunchEnvironmentField
                options={options}
                draft={draft}
                environments={environments}
                onChange={(environment, chosenEnvironment) =>
                  update({ environment, environmentId: chosenEnvironment })
                }
              />
              {cost && (
                <p className="text-xs text-muted-foreground" data-graph-launch-cost>
                  Estimated agent sessions:{" "}
                  {cost.best === cost.worst ? cost.worst : `${cost.best}–${cost.worst}`}
                </p>
              )}
            </>
          )}
        </div>
        {launchError && (
          <p role="alert" className="text-xs text-red-400">
            {launchError}
          </p>
        )}
        {options && draft && problems.length > 0 && options.launchable && (
          <p className="text-[11px] text-amber-300" data-graph-launch-problem>
            {problems[0]}
          </p>
        )}
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={launching}>
            Cancel
          </Button>
          <Button
            onClick={() => void launch()}
            disabled={!options || !draft || problems.length > 0 || launching}
          >
            {launching && <Loader2 className="size-3.5 animate-spin" />}
            Launch
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
