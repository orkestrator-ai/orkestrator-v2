import { GRAPH_TEMPLATE_BOUNDS } from "@orkestrator/protocol/graphs/grammar";
import {
  GRAPH_FAILURE_POLICIES,
  GRAPH_RETRY_CAUSES,
  type GraphFailurePolicy,
  type GraphNodeSpec,
  type GraphRetryCause,
  type GraphSystemNode,
} from "@orkestrator/protocol/graphs/template";
import { useGraphNodeEdit } from "./graph-editor-context";
import { CheckboxField, FormSection, NumberField, SelectField } from "./graph-form-controls";

/**
 * Retry, timeout and failure policy for the editable inspector (item 212), as
 * far as a node's kind has them: agent, system and sub-graph nodes all three,
 * human nodes a timeout and a policy, merges a policy, gates none.
 */

const B = GRAPH_TEMPLATE_BOUNDS;

const FAILURE_LABELS: Readonly<Record<GraphFailurePolicy, string>> = {
  "fail-run": "Fail the run (default)",
  skip: "Skip: its consumers are skipped",
  route: "Route an error@1 to its error port",
};

const RETRY_CAUSE_LABELS: Readonly<Record<GraphRetryCause, string>> = {
  "provider-error": "Provider errors",
  "invalid-result": "Invalid results",
  timeout: "Timeouts",
};

/** A copy graphWithoutField one optional field. */
export function graphWithoutField<T extends object, K extends keyof T>(value: T, key: K): T {
  const copy = { ...value };
  delete copy[key];
  return copy;
}

/** Retry, timeout and failure policy, as far as the node's kind has them. */
export function GraphNodeExecutionFields({ node }: { node: GraphNodeSpec }) {
  const editNode = useGraphNodeEdit(node.id);
  if (node.kind === "gate") return null;
  const hasRetry = node.kind === "agent" || node.kind === "system" || node.kind === "subgraph";
  const hasTimeout = hasRetry || node.kind === "human";
  const retry = hasRetry ? node.retry : undefined;
  const timeoutMs = hasTimeout ? (node as { timeoutMs?: number }).timeoutMs : undefined;
  return (
    <FormSection title="Failure handling">
      {hasRetry ? (
        <>
          <NumberField
            label="Attempts"
            value={retry?.attempts ?? 1}
            min={1}
            max={B.maxRetryAttempts}
            hint="Total attempts, the first included; 1 means no retry."
            onCommit={(attempts) =>
              editNode<GraphNodeSpec & { retry?: GraphSystemNode["retry"] }>(
                "Set retry",
                (current) =>
                  !attempts || attempts <= 1
                    ? graphWithoutField(current, "retry")
                    : {
                        ...current,
                        retry: { attempts, on: current.retry?.on ?? ["provider-error"] },
                      },
              )
            }
          />
          {retry && retry.attempts > 1 ? (
            <div role="group" aria-label="Retry on" className="flex flex-col gap-1 pl-1">
              {GRAPH_RETRY_CAUSES.map((cause) => {
                const checked = retry.on.includes(cause);
                return (
                  <CheckboxField
                    key={cause}
                    label={`Retry on ${RETRY_CAUSE_LABELS[cause].toLowerCase()}`}
                    checked={checked}
                    disabled={checked && retry.on.length === 1}
                    onChange={(next) =>
                      editNode<GraphSystemNode>("Set retry causes", (current) => ({
                        ...current,
                        retry: {
                          attempts: retry.attempts,
                          on: next
                            ? GRAPH_RETRY_CAUSES.filter(
                                (entry) => entry === cause || retry.on.includes(entry),
                              )
                            : retry.on.filter((entry) => entry !== cause),
                        },
                      }))
                    }
                  />
                );
              })}
            </div>
          ) : null}
        </>
      ) : null}
      {hasTimeout ? (
        <NumberField
          label="Timeout (seconds)"
          value={timeoutMs === undefined ? undefined : timeoutMs / 1000}
          optional
          min={B.minTimeoutMs / 1000}
          max={B.maxTimeoutMs / 1000}
          hint={
            node.kind === "human"
              ? "Without a timeout the run waits for a person, paused rather than failed."
              : "Empty: no timeout."
          }
          onCommit={(seconds) =>
            editNode<GraphNodeSpec & { timeoutMs?: number }>("Set timeout", (current) =>
              seconds === undefined
                ? graphWithoutField(current, "timeoutMs")
                : { ...current, timeoutMs: Math.round(seconds * 1000) },
            )
          }
        />
      ) : null}
      <SelectField
        label="On failure"
        value={(node as { onFailure?: GraphFailurePolicy }).onFailure ?? "fail-run"}
        options={GRAPH_FAILURE_POLICIES.map((policy) => ({
          value: policy,
          label: FAILURE_LABELS[policy],
        }))}
        onChange={(value) =>
          editNode<GraphNodeSpec & { onFailure?: GraphFailurePolicy }>(
            "Set failure policy",
            (current) =>
              value === "fail-run"
                ? graphWithoutField(current, "onFailure")
                : { ...current, onFailure: value as GraphFailurePolicy },
          )
        }
      />
    </FormSection>
  );
}
