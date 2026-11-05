import type {
  DiagnosticsBundleChunk,
  DiagnosticsBundlePlan,
} from "@orkestrator/protocol/backend-diagnostics";
import type { BackendDiagnostics } from "../backend-diagnostics.js";
import { DiagnosticsPlanError } from "../diagnostics-bundle.js";
import { diagnosticsSources } from "../diagnostics-sources.js";
import { PublicActionError } from "./errors.js";
import { onlyActionKeys, optionalInteger, requiredString } from "./input.js";
import type { PublicActionContext, PublicActionHandler, ReadActionHandler } from "./types.js";

/**
 * The diagnostics bundle (docs/architecture/logging.md, "The diagnostics bundle").
 * Both are reads: a plan sits in the backend's memory until it expires, nothing
 * reaches its disk or the network, and neither takes a request key or leaves a
 * receipt. The client that reads the bundle decides where it is saved.
 */

const UNAVAILABLE = "Diagnostics are not available in this backend";

function diagnostics(context: PublicActionContext): BackendDiagnostics {
  const service = context.command.diagnostics;
  if (!service) throw new PublicActionError("capability-unavailable", UNAVAILABLE);
  return service;
}

function unavailableReason(context: PublicActionContext): string | null {
  return context.command.diagnostics ? null : UNAVAILABLE;
}

const diagnosticsPlan: ReadActionHandler<Record<string, never>> = {
  kind: "read",
  action: "diagnostics.plan",
  parse(input) {
    onlyActionKeys(input, "diagnostics.plan");
    return {};
  },
  unavailableReason,
  async run(_input, context) {
    const plan: DiagnosticsBundlePlan = await diagnostics(context).bundles.plan(() =>
      diagnosticsSources(context.command),
    );
    return { result: plan };
  },
};

const diagnosticsRead: ReadActionHandler<{ planId: string; offset: number }> = {
  kind: "read",
  action: "diagnostics.read",
  parse(input) {
    onlyActionKeys(input, "diagnostics.read");
    return {
      planId: requiredString(input, "planId"),
      offset: optionalInteger(input, "offset", 0, Number.MAX_SAFE_INTEGER) ?? 0,
    };
  },
  unavailableReason,
  async run(input, context) {
    try {
      const chunk: DiagnosticsBundleChunk = diagnostics(context).bundles.read(
        input.planId,
        input.offset,
      );
      return { result: chunk };
    } catch (error) {
      if (error instanceof DiagnosticsPlanError) {
        throw new PublicActionError("not-found", error.message);
      }
      if (error instanceof RangeError) throw new PublicActionError("invalid-input", error.message);
      throw error;
    }
  },
};

export const DIAGNOSTICS_HANDLERS: PublicActionHandler[] = [diagnosticsPlan, diagnosticsRead];
