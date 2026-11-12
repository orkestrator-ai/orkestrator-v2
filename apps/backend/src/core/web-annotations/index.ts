// The web-annotations domain's public surface: the only module other backend
// code imports. Re-export by name (never `export *`) so the surface stays
// reviewable.
//
// Two leaf modules are named exceptions in `.oxlintrc.json`, because routing
// their importer through this file would close a runtime import cycle (this
// file reaches `storage-stores.ts` through `service.ts` and the storage layer,
// and `agent-tools.ts` through `dispatch.ts` and the native agent providers):
// `storage-stores.ts` imports `store-layout.js` and `agent-tools.ts` imports
// `tools.js` directly. Both are still re-exported here.
export { maxBase64Chars } from "./assets.js";
export { compileWebAnnotationBrief, composeWebAnnotationDispatchText } from "./brief.js";
export type { WebAnnotationToolHost } from "./contracts.js";
export { WebAnnotationDispatchAdapter } from "./dispatch.js";
export {
  CONTAINER_EVIDENCE_REMOVER,
  CONTAINER_EVIDENCE_WRITER,
  isAnnotationEvidencePath,
  runContainerEvidenceScript,
} from "./evidence-files.js";
export { WebAnnotationMetrics } from "./metrics.js";
export {
  WebAnnotationRollout,
  webAnnotationAccessAllowed,
  webAnnotationCommandAccess,
} from "./rollout.js";
export { errorOutcome, rolloutError } from "./service-errors.js";
export { WebAnnotationService } from "./service.js";
export { WEB_ANNOTATION_GC_EVERY_TICKS } from "./service-requests.js";
export { MAX_WORKSPACE_PATH_CHECKS, runContainerPathCheck } from "./source-checks.js";
export { WEB_ANNOTATION_STORE_LAYOUT, WEB_ANNOTATION_STORE_PREFIX } from "./store-layout.js";
export { WebAnnotationToolLimiter, registerWebAnnotationTools } from "./tools.js";
