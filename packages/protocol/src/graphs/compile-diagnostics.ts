/**
 * Diagnostics of the graph compiler (plan P1.7, report §7.4).
 *
 * Every rule the compiler owns has one code here, with its severity and a
 * one-line summary the designer can show beside it. Capability checks (item
 * 106, `capability-*`) and prompt lints (item 105, `prompt-*`) keep their own
 * codes and pass through unchanged; `GraphCompileDiagnostic.code` admits all
 * three families. Messages are content-free apart from names the author
 * wrote (ids, ports, paths), as for every graph diagnostic.
 */
import type { GraphCapabilityIssueCode } from "./capability-profiles.js";
import type { GraphPromptDiagnosticCode } from "./prompt-template.js";
import type { GraphAcknowledgementKind } from "./template-model.js";

export type GraphCompileSeverity = "error" | "warning" | "info";

interface CodeInfo {
  severity: GraphCompileSeverity;
  summary: string;
}

/** The compiler's own codes, with their default severity (report §7.4). */
export const GRAPH_COMPILE_DIAGNOSTICS = Object.freeze({
  // Template shape and references (item 101 leaves references to the compiler).
  "template-invalid": {
    severity: "error",
    summary: "The template fails the schema guard; `detail` carries the guard's code.",
  },
  "type-invalid": {
    severity: "error",
    summary: "A custom type fails the type checks, such as an unknown schema keyword.",
  },
  "type-conflict": {
    severity: "error",
    summary: "The template and the type library define the same type differently.",
  },
  "type-unresolved": {
    severity: "error",
    summary: "A port or run input names a type that does not resolve.",
  },
  "unknown-node": { severity: "error", summary: "A reference names a node that does not exist." },
  "unknown-port": {
    severity: "error",
    summary: "A reference names a port the node does not declare in that direction.",
  },
  "unknown-input": { severity: "error", summary: "An edge reads a run input that does not exist." },
  "unknown-outlet": {
    severity: "error",
    summary: "An edge reads an outlet the gate or human node does not have.",
  },
  "outlet-required": {
    severity: "error",
    summary: "An edge from a gate or human node must name one of its outlets.",
  },
  "outlet-not-applicable": {
    severity: "error",
    summary: "Only gate and human nodes have outlets.",
  },
  "unknown-role": {
    severity: "error",
    summary: "A node or lens names a role that does not exist.",
  },
  "role-multiplicity": {
    severity: "error",
    summary:
      "Panel roles are for panel replication only, and panel replication needs a panel role.",
  },
  "subgraph-unsupported": {
    severity: "error",
    summary: "Sub-graph nodes are not yet supported (Phase 4, item 402).",
  },
  "replicate-items-input": {
    severity: "error",
    summary:
      "An `items` fan-out replicates over an input port of type `list<T>` or of a type that declares `items` (item 401).",
  },
  "error-port-type": {
    severity: "error",
    summary: "An output port named `error` must have type `error@1`.",
  },
  "output-port-list": {
    severity: "error",
    summary:
      "An agent node submits one value per output port; declare `T`, not `list<T>` (replication lifts it).",
  },
  "output-port-reserved": {
    severity: "error",
    summary:
      "The output port's name collides with an existing result tool (`submit_<name>`); rename it.",
  },
  "route-without-error-port": {
    severity: "error",
    summary: "`onFailure: route` needs an `error` output port of type `error@1`.",
  },
  "system-param-invalid": {
    severity: "error",
    summary:
      "A system node's parameter is unknown to its action, of the wrong type, out of range, missing or contradictory (`detail`: unknown, type, range, format, required, conflict).",
  },
  "system-port-unsupported": {
    severity: "error",
    summary:
      "A system node's port carries a type its action does not read or produce, or carries one twice (`detail`).",
  },
  "system-input-missing": {
    severity: "error",
    summary: "A system node has no input port of a type its action (or its parameters) needs.",
  },

  // Topology and loops.
  "graph-cycle": {
    severity: "error",
    summary: "Edges form a cycle; iterations feed back only through a loop's `carry`.",
  },
  "loop-unbounded": { severity: "error", summary: "A loop has no `maxIterations` bound." },
  "loop-bound-exceeded": {
    severity: "error",
    summary: "A loop's `maxIterations` is above the maximum of 10.",
  },
  "loop-overlap": { severity: "error", summary: "A node belongs to more than one loop." },
  "loop-not-contiguous": {
    severity: "error",
    summary: "A path leaves a loop region and re-enters it.",
  },
  "loop-carry-outside": {
    severity: "error",
    summary: "A carry must run from a member's output to a member's input of the same loop.",
  },
  "first-iteration-invalid": {
    severity: "error",
    summary: "A `firstIterationFrom` option does not describe a loop entry (see `detail`).",
  },

  // Ports, types and producers (report §5.10).
  "edge-type-mismatch": {
    severity: "error",
    summary: "The value an edge delivers does not fit the target port's type.",
  },
  "edge-cardinality": {
    severity: "error",
    summary: "One value reaches a list port, or a list reaches a single-value port.",
  },
  "edge-transform-invalid": {
    severity: "error",
    summary: "An edge transform does not apply to the value it receives.",
  },
  "edge-zip-invalid": {
    severity: "error",
    summary: "A zip edge needs replicated nodes on both ends with the same replication source.",
  },
  "input-unbound": { severity: "error", summary: "A required input has no producer." },
  "input-multiple-producers": {
    severity: "error",
    summary:
      "Several producers feed one single-value port outside mutually exclusive gate branches.",
  },
  "collect-unsatisfiable": {
    severity: "error",
    summary: "A collect policy needs more successful branches than the producer can have.",
  },
  "collect-without-fan-in": {
    severity: "warning",
    summary: "A collect policy on a port that no replicated node feeds has no effect.",
  },
  "merge-invalid": {
    severity: "error",
    summary: "A merge node's strategy does not fit its input and output types.",
  },
  "output-type-mismatch": {
    severity: "error",
    summary: "A run output's source port does not fit the output's declared type.",
  },
  "condition-invalid": {
    severity: "error",
    summary: "A condition path or operator does not fit the producer's schema (see `detail`).",
  },

  // Workspace (D3, report §6.7).
  "workspace-unavailable": {
    severity: "error",
    summary: "A node reads or writes the workspace in a template without one.",
  },
  "workspace-concurrent-writers": {
    severity: "error",
    summary: "Two nodes that can run at the same time both write the workspace.",
  },
  "workspace-read-write-race": {
    severity: "error",
    summary: "A node can read the workspace while another writes it.",
  },
  "replicated-writer": {
    severity: "error",
    summary: "A replicated node may not write the workspace in version 1 (D3).",
  },

  // Enforcement, taint and acknowledgements (D4, report §5.13).
  "enforcement-unmet": {
    severity: "error",
    summary: "No enabled provider meets the node's `minEnforcement`.",
  },
  "enforcement-floor-lowered": {
    severity: "warning",
    summary: "The node lowers its profile's enforcement floor; needs an acknowledgement.",
  },
  "taint-reaches-side-effect": {
    severity: "warning",
    summary: "Untrusted content can reach a side-effecting node; needs an acknowledgement.",
  },
  "acknowledgement-stale": {
    severity: "info",
    summary: "An acknowledgement matches no current warning; it can be removed.",
  },

  // Conversation handoffs (report §5.2).
  "session-source-invalid": {
    severity: "error",
    summary: "`session.from` must name another agent node.",
  },
  "session-role-mismatch": {
    severity: "error",
    summary: "A continued session needs the same single-model role as its source.",
  },
  "session-not-predecessor": {
    severity: "error",
    summary: "A continued session's source must feed the node directly.",
  },
  "session-replicated": {
    severity: "error",
    summary: "Neither end of a continued session may be replicated.",
  },

  // Limits and cost (report §5.11).
  "limit-agent-sessions": {
    severity: "error",
    summary: "The worst-case agent sessions exceed `limits.maxAgentSessions`.",
  },
  "limit-activations": {
    severity: "error",
    summary: "The worst-case activations exceed the hard cap of 200 per run.",
  },
  "fanout-too-wide": {
    severity: "error",
    summary: "A node can replicate into more than 32 branches.",
  },
  "concurrency-capped": {
    severity: "info",
    summary: "More agents could run at once than `limits.maxConcurrentAgents` admits.",
  },

  // Template lints (lint.ts).
  "output-unused": {
    severity: "warning",
    summary: "An output port of a non-terminal node is never consumed.",
  },
  "run-input-unused": { severity: "warning", summary: "A run input is never read." },
  "outlet-unused": { severity: "info", summary: "A gate or human outlet leads nowhere." },
  "iteration-outside-loop": {
    severity: "warning",
    summary: "A condition outside every loop reads `run.iteration`, which is always 1 there.",
  },
  "workspace-unpinned": {
    severity: "warning",
    summary: "A node that reads or writes the workspace has no input naming the commit it sees.",
  },
} satisfies Record<string, CodeInfo>);

export type GraphCompileDiagnosticCode = keyof typeof GRAPH_COMPILE_DIAGNOSTICS;

/** Every code the compiler owns, in table order. */
export const GRAPH_COMPILE_DIAGNOSTIC_CODES = Object.freeze(
  Object.keys(GRAPH_COMPILE_DIAGNOSTICS) as GraphCompileDiagnosticCode[],
);

/** Any code a compile diagnostic can carry. */
export type GraphAnyDiagnosticCode =
  GraphCompileDiagnosticCode | GraphCapabilityIssueCode | GraphPromptDiagnosticCode;

export interface GraphCompileDiagnostic {
  code: GraphAnyDiagnosticCode;
  severity: GraphCompileSeverity;
  message: string;
  nodeId?: string;
  edgeId?: string;
  loopId?: string;
  /** Template path: `nodes[3].inputs[1]`, `edges[2].transform[0]`, `$` for the root. */
  path?: string;
  /** The delegated checker's own code: guard, predicate, assignability or transform. */
  detail?: string;
  /** The port the diagnostic is about. */
  port?: string;
  /** Prompt diagnostics: UTF-16 offset and length in the node's template. */
  offset?: number;
  length?: number;
  /**
   * Warnings that need the user's acknowledgement (D4, §5.13). `accepted`
   * when the template holds an acknowledgement with this digest; the
   * diagnostic is then reported as `info`.
   */
  acknowledgement?: { kind: GraphAcknowledgementKind; digest: string; accepted: boolean };
}

/** Diagnostics kept per compile; the rest are counted. */
export const GRAPH_COMPILE_MAX_DIAGNOSTICS = 500;

export type GraphDiagnosticLocation = Omit<GraphCompileDiagnostic, "code" | "severity" | "message">;

const SEVERITY_RANK: Readonly<Record<GraphCompileSeverity, number>> = {
  error: 0,
  warning: 1,
  info: 2,
};

/** A bounded diagnostic list. */
export class GraphCompileDiagnostics {
  readonly list: GraphCompileDiagnostic[] = [];
  omitted = 0;
  /** Every error, kept or omitted. */
  errorCount = 0;

  add(
    code: GraphCompileDiagnosticCode,
    message: string,
    at: GraphDiagnosticLocation = {},
    severity: GraphCompileSeverity = GRAPH_COMPILE_DIAGNOSTICS[code].severity,
  ): void {
    this.push({ code, severity, message, ...at });
  }

  push(diagnostic: GraphCompileDiagnostic): void {
    if (diagnostic.severity === "error") this.errorCount++;
    if (this.list.length >= GRAPH_COMPILE_MAX_DIAGNOSTICS) {
      this.omitted++;
      return;
    }
    const entry: GraphCompileDiagnostic = {
      ...diagnostic,
      message: diagnostic.message.slice(0, 600),
    };
    for (const key of Object.keys(entry) as (keyof GraphCompileDiagnostic)[]) {
      if (entry[key] === undefined) delete entry[key];
    }
    this.list.push(entry);
  }

  /** Errors first, then warnings, then info; discovery order within each. */
  sorted(): GraphCompileDiagnostic[] {
    return this.list
      .map((entry, index) => ({ entry, index }))
      .sort(
        (a, b) =>
          SEVERITY_RANK[a.entry.severity] - SEVERITY_RANK[b.entry.severity] || a.index - b.index,
      )
      .map(({ entry }) => entry);
  }
}
