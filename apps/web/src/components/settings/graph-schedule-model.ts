import {
  graphLaunchEnvironmentKey,
  type GraphLaunchOptions,
} from "@orkestrator/protocol/graphs/launch";
import { graphTemplateRefKey, type GraphTemplateRef } from "@orkestrator/protocol/graphs/library";
import type { ScheduleAction, ScheduleGraphLaunch } from "@orkestrator/protocol/scheduled-jobs";
import {
  graphLaunchMember,
  graphLaunchProblems,
  graphLaunchRequest,
  graphLaunchTicketInput,
  initialGraphLaunchDraft,
  type GraphLaunchDraft,
} from "@/components/graph-launch/graph-launch-model";

/**
 * Settings → Schedules' "Run a graph" action (item 214): the form state and
 * the pure rules over it. The form reuses the launch dialog's draft and
 * checks (`graph-launch-model.ts`), compiled for the schedule's project and
 * environment by `graph_launch_options`, and produces the stored
 * `ScheduleGraphLaunch`: the launch request without `requestId` (each fire
 * supplies `sched:<fireId>`) or `saveDefaults`. With "use the saved launch
 * defaults" the request leaves roles and parameters out, so each fire takes
 * the template's saved defaults for the project at that time (then the
 * settings' and the template's own); otherwise it pins the ones chosen here.
 */
export interface GraphScheduleForm {
  projectId: string;
  ref: GraphTemplateRef | null;
  /** Leave roles and parameters to the saved launch defaults at fire time. */
  useDefaults: boolean;
  /** `graph_launch_options` for the template, project and environment chosen. */
  options: GraphLaunchOptions | null;
  draft: GraphLaunchDraft | null;
  /** The schedule's stored request (editing), applied to the first draft of its template. */
  original: ScheduleGraphLaunch | null;
  /** The person changed something; an untouched edit keeps the stored action. */
  touched: boolean;
}

export function initialGraphScheduleForm(action?: ScheduleAction): GraphScheduleForm {
  const original = action?.kind === "graph" ? action.request : null;
  return {
    projectId: original?.projectId ?? "",
    ref: original?.ref ?? null,
    useDefaults: original ? original.roles === undefined && original.params === undefined : true,
    options: null,
    draft: null,
    original,
    touched: false,
  };
}

/** True when the stored request is for this project and template. */
function sameTemplate(form: GraphScheduleForm): boolean {
  return (
    form.original !== null &&
    form.ref !== null &&
    form.original.projectId === form.projectId &&
    graphTemplateRefKey(form.original.ref) === graphTemplateRefKey(form.ref)
  );
}

/** What `graph_launch_options` is asked for: the draft's environment, else the stored one. */
export function graphScheduleOptionsQuery(form: GraphScheduleForm): {
  environmentId?: string;
  create?: "worktree" | "container";
} {
  if (form.draft) {
    if (form.draft.environment === "existing") {
      return form.draft.environmentId ? { environmentId: form.draft.environmentId } : {};
    }
    return { create: form.draft.environment === "new-container" ? "container" : "worktree" };
  }
  const environment = sameTemplate(form) ? form.original!.environment : null;
  if (!environment) return {};
  return environment.kind === "existing"
    ? { environmentId: environment.environmentId }
    : { create: environment.create };
}

/** The draft a stored request describes, over the defaults the options carry. */
export function graphScheduleDraftFromRequest(
  options: GraphLaunchOptions,
  request: ScheduleGraphLaunch,
): GraphLaunchDraft {
  const environmentId =
    request.environment.kind === "existing" ? request.environment.environmentId : null;
  const draft = initialGraphLaunchDraft(options, {
    environmentId,
    ticketTaskId: request.ticket?.taskId ?? null,
  });
  draft.environment = graphLaunchEnvironmentKey(request.environment);
  draft.environmentId = environmentId;
  for (const [key, binding] of Object.entries(request.roles ?? {})) {
    if (!(key in draft.roles)) continue;
    draft.roles[key] = (Array.isArray(binding) ? binding : [binding]).map(graphLaunchMember);
  }
  for (const parameter of options.parameters) {
    const value = request.params?.[parameter.key];
    if (value === undefined) continue;
    draft.params[parameter.key] =
      parameter.type === "boolean" ? value === true : value === null ? "" : String(value);
  }
  for (const [name, value] of Object.entries(request.inputs ?? {})) {
    draft.inputs[name] = JSON.stringify(value, null, 2);
  }
  return draft;
}

/** The form once options arrive: the first draft comes from the stored request or the defaults. */
export function graphScheduleWithOptions(
  form: GraphScheduleForm,
  options: GraphLaunchOptions,
): GraphScheduleForm {
  if (form.draft) return { ...form, options };
  const draft = sameTemplate(form)
    ? graphScheduleDraftFromRequest(options, form.original!)
    : initialGraphLaunchDraft(options, {});
  return { ...form, options, draft };
}

/**
 * The problems that keep the schedule from being saved, in display order.
 * The launch dialog's rules apply in both modes: with saved defaults the
 * draft holds exactly what a fire would use now, so a role or parameter
 * those defaults cannot fill is reported here rather than at fire time.
 */
export function graphScheduleProblems(form: GraphScheduleForm): string[] {
  if (!form.projectId) return ["Choose a project"];
  if (!form.ref) return ["Choose a template"];
  if (!form.options || !form.draft) return ["The template is still being compiled"];
  return graphLaunchProblems(form.options, form.draft).map((problem) =>
    form.useDefaults && /takes 1 to|choose a provider|needs a value/.test(problem)
      ? `${problem} (turn off saved defaults to set it here)`
      : problem,
  );
}

/** The stored launch request of a valid form; throws the first problem otherwise. */
export function graphScheduleRequest(form: GraphScheduleForm): ScheduleGraphLaunch {
  const problems = graphScheduleProblems(form);
  if (problems.length > 0) throw new Error(problems[0]);
  const {
    requestId: _requestId,
    saveDefaults: _saveDefaults,
    roles,
    params,
    ...rest
  } = graphLaunchRequest({
    ref: form.ref!,
    projectId: form.projectId,
    options: form.options!,
    draft: form.draft!,
    requestId: "schedule",
  });
  // A ticket is bound only when the template has a ticket input.
  if (rest.ticket && !graphLaunchTicketInput(form.options!)) delete rest.ticket;
  if (form.useDefaults) return rest;
  return {
    ...rest,
    ...(roles && Object.keys(roles).length > 0 ? { roles } : {}),
    ...(params && Object.keys(params).length > 0 ? { params } : {}),
  };
}
