/**
 * Compiler pass: system nodes against their action (plan P2.7, item 207).
 *
 * Each system node's parameters must be ones its action takes, with the
 * right types and ranges and no contradiction (`system-param-invalid`, the
 * rule in `detail`); every input port must carry a type the action reads,
 * once (`system-port-unsupported`); every type the action needs must be on
 * some input port (`system-input-missing`); and every output port, apart
 * from a routed `error`, must carry a type the action produces
 * (`system-port-unsupported`). The action table is `system-actions.ts`.
 */
import type { GraphCompileState } from "./compile-state.js";
import { portKey } from "./compile-state.js";
import {
  checkGraphSystemParams,
  GRAPH_PULL_REQUEST_STATE_TYPE,
  GRAPH_SYSTEM_ACTION_SPECS,
  graphPullRequestStateType,
  graphSystemRequiredInputs,
} from "./system-actions.js";
import { isGraphSchemaSubtype } from "./type-assignability.js";
import type { GraphJsonSchema } from "./artifact-type-def.js";

/** The schema of an output type the action defines but templates declare. */
function producedCustomSchema(ref: string): GraphJsonSchema | null {
  return ref === GRAPH_PULL_REQUEST_STATE_TYPE ? graphPullRequestStateType().schema : null;
}

export function checkGraphSystemNodes(state: GraphCompileState): void {
  const { diagnostics } = state;
  for (const { node, path } of state.nodes.values()) {
    if (node.kind !== "system") continue;
    const spec = GRAPH_SYSTEM_ACTION_SPECS[node.action];
    const params = node.params ?? {};

    for (const issue of checkGraphSystemParams(node.action, params)) {
      diagnostics.add("system-param-invalid", issue.message, {
        nodeId: node.id,
        path: issue.param === undefined ? `${path}.params` : `${path}.params.${issue.param}`,
        detail: issue.code,
      });
    }

    const readable = new Set(spec.inputs.map((input) => input.type));
    const seen = new Map<string, string>();
    (node.inputs ?? []).forEach((input, index) => {
      const at = { nodeId: node.id, port: input.name, path: `${path}.inputs[${index}].type` };
      if (!readable.has(input.type)) {
        diagnostics.add(
          "system-port-unsupported",
          `${node.action} does not read ${input.type}${spec.inputs.length > 0 ? `; it reads ${spec.inputs.map((entry) => entry.type).join(", ")}` : ""}`,
          { ...at, detail: "input-type" },
        );
        return;
      }
      const other = seen.get(input.type);
      if (other !== undefined) {
        diagnostics.add(
          "system-port-unsupported",
          `${node.action} reads one ${input.type}; ${other} already carries it`,
          { ...at, detail: "duplicate" },
        );
        return;
      }
      seen.set(input.type, input.name);
    });

    for (const { type, because } of graphSystemRequiredInputs(node.action, params)) {
      if (seen.has(type)) continue;
      diagnostics.add(
        "system-input-missing",
        `${node.id} needs an input of type ${type} (${because})`,
        { nodeId: node.id, path: `${path}.inputs` },
      );
    }

    const produced = new Set(spec.outputs.map((output) => output.type));
    const outputSeen = new Map<string, string>();
    (node.outputs ?? []).forEach((output, index) => {
      if (output.name === "error") return;
      const at = { nodeId: node.id, port: output.name, path: `${path}.outputs[${index}].type` };
      if (!produced.has(output.type)) {
        diagnostics.add(
          "system-port-unsupported",
          `${node.action} does not produce ${output.type}${spec.outputs.length > 0 ? `; it produces ${spec.outputs.map((entry) => entry.type).join(", ")}` : ""}`,
          { ...at, detail: "output-type" },
        );
        return;
      }
      const other = outputSeen.get(output.type);
      if (other !== undefined) {
        diagnostics.add(
          "system-port-unsupported",
          `${node.action} produces one ${output.type}; ${other} already carries it`,
          { ...at, detail: "duplicate" },
        );
        return;
      }
      outputSeen.set(output.type, output.name);
      // A type the action defines but templates declare: theirs must accept the action's shape.
      // Same name is not enough here: compare the shapes.
      const source = producedCustomSchema(output.type);
      const declared = state.outputTypes.get(portKey(node.id, output.name));
      if (!source || declared?.kind !== "named") return;
      const fit = isGraphSchemaSubtype(source, declared.definition.schema);
      if (!fit.ok) {
        diagnostics.add(
          "system-port-unsupported",
          `The template's ${output.type} does not accept what ${node.action} reports: ${fit.message}`,
          { ...at, detail: "schema_mismatch" },
        );
      }
    });
  }
}
