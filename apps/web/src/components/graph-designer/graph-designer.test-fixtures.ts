import { graphBuiltInTemplate } from "@orkestrator/protocol/graphs/builtins";
import { compile } from "@orkestrator/protocol/graphs/compile";
import type {
  GraphTemplateCompileResponse,
  GraphTemplateDetail,
  GraphTemplateRef,
  GraphTemplatesListResult,
  GraphTemplateSummary,
} from "@orkestrator/protocol/graphs/library";
import type { GraphTemplateV1 } from "@orkestrator/protocol/graphs/template";

/** Backend-shaped fixtures for the Graphs designer's tests. */

export function fixtureSummary(
  template: GraphTemplateV1,
  ref: GraphTemplateRef,
  patch: Partial<GraphTemplateSummary> = {},
): GraphTemplateSummary {
  const result = compile(template);
  const errors = result.diagnostics.filter((d) => d.severity === "error").length;
  const warnings = result.diagnostics.filter((d) => d.severity === "warning").length;
  return {
    ref,
    scope: ref.scope,
    id: template.id,
    name: template.name,
    ...(template.engine ? { engine: template.engine } : {}),
    revision: template.revision,
    digest: `digest-${template.id}-${template.revision}`,
    readOnly: ref.scope !== "user",
    trust: "trusted",
    launchable: false,
    compile: {
      ok: result.ok,
      launchable: result.launchable,
      errors,
      warnings,
      infos: result.diagnostics.length - errors - warnings,
      pendingAcknowledgements: result.pendingAcknowledgements.length,
      planDigest: result.plan?.digest ?? null,
      cost: result.cost
        ? {
            agentSessions: result.cost.agentSessions,
            peakParallelism: result.cost.peakParallelism,
          }
        : null,
    },
    ...patch,
  };
}

export function builtInDetail(id: "build-pipeline" | "multi-review" | "looped-review") {
  const builtIn = graphBuiltInTemplate(id)!;
  const ref: GraphTemplateRef = { scope: "builtin", id };
  return {
    summary: fixtureSummary(builtIn.template, ref, { engineStatus: builtIn.engineStatus }),
    template: builtIn.template,
  } satisfies GraphTemplateDetail;
}

export function userDetail(template: GraphTemplateV1, revision = 1): GraphTemplateDetail {
  const stored = { ...structuredClone(template), revision };
  delete stored.engine;
  return {
    summary: fixtureSummary(stored, { scope: "user", id: stored.id }),
    template: stored,
  };
}

export function compileResponse(template: GraphTemplateV1): GraphTemplateCompileResponse {
  const result = compile(template);
  return {
    summary: null,
    ok: result.ok,
    launchable: result.launchable,
    diagnostics: result.diagnostics,
    omittedDiagnostics: result.omittedDiagnostics,
    cost: result.cost,
    pendingAcknowledgements: result.pendingAcknowledgements,
    planDigest: result.plan?.digest ?? null,
    plan: result.plan,
    ceiling: { deny: [] },
  };
}

export function listResult(
  templates: GraphTemplateSummary[],
  project: GraphTemplatesListResult["project"] = null,
): GraphTemplatesListResult {
  return { templates, project, ceiling: { deny: [] } };
}
