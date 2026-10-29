import { GRAPH_TEMPLATE_BOUNDS, isGraphKey } from "@orkestrator/protocol/graphs/grammar";
import {
  GRAPH_SYSTEM_ACTION_SPECS,
  type GraphSystemParamSpec,
} from "@orkestrator/protocol/graphs/system-actions";
import type {
  GraphInputPortSpec,
  GraphOutputPortSpec,
  GraphSystemAction,
} from "@orkestrator/protocol/graphs/template";
import type { GraphTypeLibrary } from "@orkestrator/protocol/graphs/types";

/**
 * The designer's view of the system actions (items 207, 212). What each
 * action is called, does, reads, produces and takes as parameters comes from
 * the protocol's `GRAPH_SYSTEM_ACTION_SPECS`, the table the compiler and the
 * backend executor read; only presentation lives here: the name a new port of
 * each type gets (the built-in templates' names, since the spec binds ports
 * by type) and how a parameter's default and range read in a form.
 */

/** The name a new port carrying each type gets, as the built-in templates name them. */
const PORT_NAMES: Readonly<Record<string, string>> = {
  "workspace@1": "code",
  "list<workspace@1>": "candidates",
  "decision@1": "decision",
  "ticket@1": "ticket",
  "validation-plan@1": "plan",
  "validation-results@1": "results",
  "review-package@2": "package",
  "pr-description@1": "description",
  "pr-result@1": "pr",
  "pull-request-state@1": "state",
  "check-summary@1": "checks",
  "verification-verdict@1": "verdict",
  "text@1": "text",
  "markdown@1": "markdown",
};

/** A port name for `type`: the built-ins' name, else the type's name as an identifier. */
export function graphSystemPortName(type: string): string {
  const known = PORT_NAMES[type];
  if (known) return known;
  const words = type.replace(/@.*$/, "").split(/[^A-Za-z0-9]+/);
  const name = words
    .filter(Boolean)
    .map((word, index) =>
      index === 0
        ? word.charAt(0).toLowerCase() + word.slice(1)
        : word.charAt(0).toUpperCase() + word.slice(1),
    )
    .join("");
  return isGraphKey(name) ? name : "port";
}

/**
 * The ports a new node of `action` starts with: one per input the action
 * requires and one per output it produces whose type the template can name
 * (`pull-request-state@1` is a custom type a template declares, so it is
 * left out until the template does). Optional inputs are added from the
 * node's form.
 */
export function graphSystemDefaultPorts(
  action: GraphSystemAction,
  library: GraphTypeLibrary,
): { inputs: GraphInputPortSpec[]; outputs: GraphOutputPortSpec[] } {
  const spec = GRAPH_SYSTEM_ACTION_SPECS[action];
  return {
    inputs: spec.inputs
      .filter((port) => port.required)
      .map((port) => ({ name: graphSystemPortName(port.type), type: port.type })),
    outputs: spec.outputs
      .filter((port) => library.resolve(port.type).ok)
      .map((port) => ({ name: graphSystemPortName(port.type), type: port.type })),
  };
}

/** How a parameter's default reads in a form ("Default (yes)"), or "Not set". */
export function graphSystemParamDefaultLabel(spec: GraphSystemParamSpec): string {
  if (spec.type === "string" || spec.default === undefined) return "Not set";
  if (spec.type === "boolean") return `Default (${spec.default ? "yes" : "no"})`;
  return `Default (${spec.default})`;
}

/**
 * The bounds of a parameter as a short hint: "1–360", "at most 200
 * characters". A text parameter the spec allows to be longer than a template
 * stores one (101's per-value byte bound) shows the template's bound.
 */
export function graphSystemParamBoundsHint(spec: GraphSystemParamSpec): string | null {
  switch (spec.type) {
    case "integer":
      return `${spec.min}–${spec.max}`;
    case "string": {
      const format =
        spec.format === "branch"
          ? "a branch name, "
          : spec.format === "id"
            ? "one word without spaces, "
            : "";
      const bytes = GRAPH_TEMPLATE_BOUNDS.maxSystemParamStringBytes;
      return spec.maxChars > bytes
        ? `${format}at most ${bytes} bytes in a template`
        : `${format}at most ${spec.maxChars} characters`;
    }
    default:
      return null;
  }
}
