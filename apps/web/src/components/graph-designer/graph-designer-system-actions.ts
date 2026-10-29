import { GRAPH_TEMPLATE_BOUNDS } from "@orkestrator/protocol/graphs/grammar";
import type {
  GraphInputPortSpec,
  GraphOutputPortSpec,
  GraphSystemAction,
  GraphSystemParamValue,
} from "@orkestrator/protocol/graphs/template";

/**
 * The designer's catalogue of system actions (report §6.6, plan P2.7): what
 * each does, and the ports a new node of that action starts with, following
 * the built-in templates and the report's examples. The ports are a starting
 * point the user may change; the compiler and the action's executor (item
 * 207) are the authority on what an action accepts.
 *
 * Params: the template schema allows up to 16 keys, each a scalar or a list
 * of scalars. Per-action param rules belong to the executor (item 207); until
 * the protocol exports them, `params` lists only keys the built-ins already
 * use, and the editor accepts any key within the template bounds.
 */

export type GraphSystemParamKind = "string" | "number" | "boolean" | "string-list";

export interface GraphSystemParamField {
  key: string;
  label: string;
  kind: GraphSystemParamKind;
  description: string;
  /** Suggested values for a string param. */
  options?: readonly string[];
}

export interface GraphSystemActionInfo {
  action: GraphSystemAction;
  label: string;
  description: string;
  inputs: readonly GraphInputPortSpec[];
  outputs: readonly GraphOutputPortSpec[];
  params: readonly GraphSystemParamField[];
}

const CODE_IN: GraphInputPortSpec = { name: "code", type: "workspace@1" };
const CODE_OUT: GraphOutputPortSpec = { name: "code", type: "workspace@1" };
const PLAN_IN: GraphInputPortSpec = { name: "plan", type: "validation-plan@1" };

export const GRAPH_SYSTEM_ACTION_CATALOGUE: Readonly<
  Record<GraphSystemAction, GraphSystemActionInfo>
> = Object.freeze({
  "prepare-environment": {
    action: "prepare-environment",
    label: "Prepare environment",
    description: "Sets up the run's environment for the ticket and hands on its workspace.",
    inputs: [{ name: "ticket", type: "ticket@1" }],
    outputs: [CODE_OUT],
    params: [],
  },
  "run-validation": {
    action: "run-validation",
    label: "Run validation",
    description: "Runs a validation plan's commands against the workspace.",
    inputs: [PLAN_IN, CODE_IN],
    outputs: [CODE_OUT],
    params: [],
  },
  "run-validation-and-seal": {
    action: "run-validation-and-seal",
    label: "Run validation and seal",
    description: "Runs the validation plan and seals a hash-verified review package.",
    inputs: [PLAN_IN, CODE_IN],
    outputs: [{ name: "package", type: "review-package@2" }],
    params: [],
  },
  "push-branch": {
    action: "push-branch",
    label: "Push branch",
    description: "Pushes the workspace's commit to the remote, once per commit.",
    inputs: [CODE_IN],
    outputs: [],
    params: [],
  },
  "open-pull-request": {
    action: "open-pull-request",
    label: "Open pull request",
    description: "Pushes, then opens or updates the pull request with the given description.",
    inputs: [CODE_IN, { name: "description", type: "pr-description@1" }],
    outputs: [{ name: "pr", type: "pr-result@1" }],
    params: [],
  },
  "wait-for-checks": {
    action: "wait-for-checks",
    label: "Wait for checks",
    description: "Waits, within a bound, for the pull request's CI checks and reports them.",
    inputs: [{ name: "pr", type: "pr-result@1" }],
    outputs: [{ name: "checks", type: "check-summary@1" }],
    params: [],
  },
  "update-ticket": {
    action: "update-ticket",
    label: "Update ticket",
    description: "Moves the ticket, comments on it or records its acceptance criteria.",
    inputs: [],
    outputs: [],
    params: [
      {
        key: "record",
        label: "Record",
        kind: "string",
        description: "What to record on the ticket, such as the acceptance criteria results.",
        options: ["criteria"],
      },
    ],
  },
  notify: {
    action: "notify",
    label: "Notify",
    description: "Sends agent mail to the coordinator or a tab.",
    inputs: [],
    outputs: [],
    params: [],
  },
});

/** Keys, string sizes and list lengths a system node's params stay within. */
export const GRAPH_SYSTEM_PARAM_BOUNDS = Object.freeze({
  maxParams: GRAPH_TEMPLATE_BOUNDS.maxSystemParams,
  maxListItems: GRAPH_TEMPLATE_BOUNDS.maxSystemParamListItems,
  maxStringBytes: GRAPH_TEMPLATE_BOUNDS.maxSystemParamStringBytes,
});

/** The editor's kind for a param value it finds in a template. */
export function graphSystemParamKind(value: GraphSystemParamValue): GraphSystemParamKind {
  if (Array.isArray(value)) return "string-list";
  if (typeof value === "number") return "number";
  if (typeof value === "boolean") return "boolean";
  return "string";
}
