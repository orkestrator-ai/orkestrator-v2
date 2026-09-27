/**
 * Backend-owned web annotation service.
 *
 * Composition (each layer in its own file to stay reviewable):
 *
 * - `web-annotation-service-core.ts`: threads, captures, drafts, assets,
 *   listing, receipts, change hints, capabilities.
 * - `web-annotation-service-requests.ts`: prepare/send, the durable queue
 *   handoff, cancellation/recovery, results, the reconciler, and the agent
 *   tool host.
 * - `web-annotation-migration.ts`: legacy compose-draft import.
 *
 * Storage lives in `web-annotation-storage.ts`; image validation and GC
 * policy in `web-annotation-assets.ts`; replay ring in `web-annotation-sync.ts`.
 */
import { WebAnnotationServiceMigration } from "./web-annotation-migration.js";

export {
  WebAnnotationServiceError,
  type WebAnnotationHostStorage,
  type WebAnnotationServiceOptions,
} from "./web-annotation-service-core.js";

export class WebAnnotationService extends WebAnnotationServiceMigration {}
