/**
 * Backend-owned web annotation service.
 *
 * A facade over collaborators that share one `WebAnnotationContext`
 * (`web-annotation-context.ts`: storage, change ring, metrics, options):
 *
 * - `web-annotation-service-store.ts`: capabilities, change hints, receipts,
 *   editor drafts, assets, and garbage collection.
 * - `web-annotation-service-threads.ts`: threads, captures, entries, listing,
 *   resolution, and archive/continuation.
 * - `web-annotation-service-results.ts`: after-capture evidence, agent
 *   results, follow-up selection, and the agent tool host.
 * - `web-annotation-service-requests.ts`: prepare/send, the durable queue
 *   handoff, cancellation/recovery, and the reconciler.
 * - `web-annotation-migration.ts`: legacy compose-draft import.
 *
 * Each part takes the context and the parts it calls; none extends another
 * (`tests/unit/inheritance-chains.test.ts`). Storage lives in
 * `web-annotation-storage.ts`; image validation and GC policy in
 * `web-annotation-assets.ts`; replay ring in `web-annotation-sync.ts`.
 */
import type { WebAnnotationRolloutMode } from "@orkestrator/protocol/web-annotations";
import {
  WebAnnotationContext,
  type WebAnnotationServiceOptions,
} from "./web-annotation-context.js";
import type { WebAnnotationMetrics } from "./web-annotation-metrics.js";
import { WebAnnotationMigration } from "./web-annotation-migration.js";
import { WebAnnotationRequests } from "./web-annotation-service-requests.js";
import { WebAnnotationResults } from "./web-annotation-service-results.js";
import { WebAnnotationStoreOperations } from "./web-annotation-service-store.js";
import { WebAnnotationThreads } from "./web-annotation-service-threads.js";
import type { WebAnnotationStorage } from "./web-annotation-storage.js";
import type { WebAnnotationChangeRing } from "./web-annotation-sync.js";

export {
  WebAnnotationServiceError,
  type WebAnnotationHostStorage,
  type WebAnnotationServiceOptions,
} from "./web-annotation-context.js";

export class WebAnnotationService {
  readonly storage: WebAnnotationStorage;
  readonly ring: WebAnnotationChangeRing;
  readonly metrics: WebAnnotationMetrics;
  private readonly context: WebAnnotationContext;
  private readonly storeOps: WebAnnotationStoreOperations;
  private readonly threads: WebAnnotationThreads;
  private readonly results: WebAnnotationResults;
  private readonly requests: WebAnnotationRequests;
  private readonly migration: WebAnnotationMigration;

  constructor(options: WebAnnotationServiceOptions) {
    this.context = new WebAnnotationContext(options);
    this.storage = this.context.storage;
    this.ring = this.context.ring;
    this.metrics = this.context.metrics;
    this.storeOps = new WebAnnotationStoreOperations(this.context);
    this.threads = new WebAnnotationThreads(this.context);
    this.results = new WebAnnotationResults(this.context, this.threads);
    this.requests = new WebAnnotationRequests(
      this.context,
      this.storeOps,
      this.threads,
      this.results,
    );
    this.migration = new WebAnnotationMigration(this.context, this.threads);
  }

  get generation(): string {
    return this.context.generation;
  }

  /** The rollout mode in force for client entry points. */
  get rolloutMode(): WebAnnotationRolloutMode {
    return this.context.rolloutMode;
  }

  get isInitialized(): boolean {
    return this.context.isInitialized;
  }

  initialize(): Promise<void> {
    return this.context.initialize();
  }

  /** Stops the reconciler and waits for in-flight request work, then closes storage. */
  close(): Promise<void> {
    return this.requests.close();
  }

  /** Drops the environment's pending preparations, then its stored state. */
  deleteEnvironment(environmentId: string): Promise<void> {
    return this.requests.deleteEnvironment(environmentId);
  }

  // -------------------------------------------------------------------------
  // Capabilities, change hints, receipts, drafts, assets and GC

  capabilities(
    ...args: Parameters<WebAnnotationStoreOperations["capabilities"]>
  ): ReturnType<WebAnnotationStoreOperations["capabilities"]> {
    return this.storeOps.capabilities(...args);
  }

  changes(
    ...args: Parameters<WebAnnotationStoreOperations["changes"]>
  ): ReturnType<WebAnnotationStoreOperations["changes"]> {
    return this.storeOps.changes(...args);
  }

  receipt(
    ...args: Parameters<WebAnnotationStoreOperations["receipt"]>
  ): ReturnType<WebAnnotationStoreOperations["receipt"]> {
    return this.storeOps.receipt(...args);
  }

  getDraft(
    ...args: Parameters<WebAnnotationStoreOperations["getDraft"]>
  ): ReturnType<WebAnnotationStoreOperations["getDraft"]> {
    return this.storeOps.getDraft(...args);
  }

  saveDraft(
    ...args: Parameters<WebAnnotationStoreOperations["saveDraft"]>
  ): ReturnType<WebAnnotationStoreOperations["saveDraft"]> {
    return this.storeOps.saveDraft(...args);
  }

  deleteDraft(
    ...args: Parameters<WebAnnotationStoreOperations["deleteDraft"]>
  ): ReturnType<WebAnnotationStoreOperations["deleteDraft"]> {
    return this.storeOps.deleteDraft(...args);
  }

  stageAsset(
    ...args: Parameters<WebAnnotationStoreOperations["stageAsset"]>
  ): ReturnType<WebAnnotationStoreOperations["stageAsset"]> {
    return this.storeOps.stageAsset(...args);
  }

  getAsset(
    ...args: Parameters<WebAnnotationStoreOperations["getAsset"]>
  ): ReturnType<WebAnnotationStoreOperations["getAsset"]> {
    return this.storeOps.getAsset(...args);
  }

  collectGarbage(
    ...args: Parameters<WebAnnotationStoreOperations["collectGarbage"]>
  ): ReturnType<WebAnnotationStoreOperations["collectGarbage"]> {
    return this.storeOps.collectGarbage(...args);
  }

  // -------------------------------------------------------------------------
  // Threads, captures and entries

  list(
    ...args: Parameters<WebAnnotationThreads["list"]>
  ): ReturnType<WebAnnotationThreads["list"]> {
    return this.threads.list(...args);
  }

  entries(
    ...args: Parameters<WebAnnotationThreads["entries"]>
  ): ReturnType<WebAnnotationThreads["entries"]> {
    return this.threads.entries(...args);
  }

  capture(
    ...args: Parameters<WebAnnotationThreads["capture"]>
  ): ReturnType<WebAnnotationThreads["capture"]> {
    return this.threads.capture(...args);
  }

  create(
    ...args: Parameters<WebAnnotationThreads["create"]>
  ): ReturnType<WebAnnotationThreads["create"]> {
    return this.threads.create(...args);
  }

  appendEntryCommand(
    ...args: Parameters<WebAnnotationThreads["appendEntryCommand"]>
  ): ReturnType<WebAnnotationThreads["appendEntryCommand"]> {
    return this.threads.appendEntryCommand(...args);
  }

  editEntry(
    ...args: Parameters<WebAnnotationThreads["editEntry"]>
  ): ReturnType<WebAnnotationThreads["editEntry"]> {
    return this.threads.editEntry(...args);
  }

  update(
    ...args: Parameters<WebAnnotationThreads["update"]>
  ): ReturnType<WebAnnotationThreads["update"]> {
    return this.threads.update(...args);
  }

  replaceCapture(
    ...args: Parameters<WebAnnotationThreads["replaceCapture"]>
  ): ReturnType<WebAnnotationThreads["replaceCapture"]> {
    return this.threads.replaceCapture(...args);
  }

  resolve(
    ...args: Parameters<WebAnnotationThreads["resolve"]>
  ): ReturnType<WebAnnotationThreads["resolve"]> {
    return this.threads.resolve(...args);
  }

  reopen(
    ...args: Parameters<WebAnnotationThreads["reopen"]>
  ): ReturnType<WebAnnotationThreads["reopen"]> {
    return this.threads.reopen(...args);
  }

  delete(
    ...args: Parameters<WebAnnotationThreads["delete"]>
  ): ReturnType<WebAnnotationThreads["delete"]> {
    return this.threads.delete(...args);
  }

  archive(
    ...args: Parameters<WebAnnotationThreads["archive"]>
  ): ReturnType<WebAnnotationThreads["archive"]> {
    return this.threads.archive(...args);
  }

  // -------------------------------------------------------------------------
  // Results and the agent tool host

  get(...args: Parameters<WebAnnotationResults["get"]>): ReturnType<WebAnnotationResults["get"]> {
    return this.results.get(...args);
  }

  getRequest(
    ...args: Parameters<WebAnnotationResults["getRequest"]>
  ): ReturnType<WebAnnotationResults["getRequest"]> {
    return this.results.getRequest(...args);
  }

  captureResult(
    ...args: Parameters<WebAnnotationResults["captureResult"]>
  ): ReturnType<WebAnnotationResults["captureResult"]> {
    return this.results.captureResult(...args);
  }

  followUpCandidates(
    ...args: Parameters<WebAnnotationResults["followUpCandidates"]>
  ): ReturnType<WebAnnotationResults["followUpCandidates"]> {
    return this.results.followUpCandidates(...args);
  }

  assignedRequest(
    ...args: Parameters<WebAnnotationResults["assignedRequest"]>
  ): ReturnType<WebAnnotationResults["assignedRequest"]> {
    return this.results.assignedRequest(...args);
  }

  toolEvidence(
    ...args: Parameters<WebAnnotationResults["toolEvidence"]>
  ): ReturnType<WebAnnotationResults["toolEvidence"]> {
    return this.results.toolEvidence(...args);
  }

  reportToolResult(
    ...args: Parameters<WebAnnotationResults["reportToolResult"]>
  ): ReturnType<WebAnnotationResults["reportToolResult"]> {
    return this.results.reportToolResult(...args);
  }

  toolHost(
    ...args: Parameters<WebAnnotationResults["toolHost"]>
  ): ReturnType<WebAnnotationResults["toolHost"]> {
    return this.results.toolHost(...args);
  }

  // -------------------------------------------------------------------------
  // Requests and the background reconciler

  destinations(
    ...args: Parameters<WebAnnotationRequests["destinations"]>
  ): ReturnType<WebAnnotationRequests["destinations"]> {
    return this.requests.destinations(...args);
  }

  prepare(
    ...args: Parameters<WebAnnotationRequests["prepare"]>
  ): ReturnType<WebAnnotationRequests["prepare"]> {
    return this.requests.prepare(...args);
  }

  send(
    ...args: Parameters<WebAnnotationRequests["send"]>
  ): ReturnType<WebAnnotationRequests["send"]> {
    return this.requests.send(...args);
  }

  listRequests(
    ...args: Parameters<WebAnnotationRequests["listRequests"]>
  ): ReturnType<WebAnnotationRequests["listRequests"]> {
    return this.requests.listRequests(...args);
  }

  cancelRequest(
    ...args: Parameters<WebAnnotationRequests["cancelRequest"]>
  ): ReturnType<WebAnnotationRequests["cancelRequest"]> {
    return this.requests.cancelRequest(...args);
  }

  cancelFromChatQueue(
    ...args: Parameters<WebAnnotationRequests["cancelFromChatQueue"]>
  ): ReturnType<WebAnnotationRequests["cancelFromChatQueue"]> {
    return this.requests.cancelFromChatQueue(...args);
  }

  recoverRequest(
    ...args: Parameters<WebAnnotationRequests["recoverRequest"]>
  ): ReturnType<WebAnnotationRequests["recoverRequest"]> {
    return this.requests.recoverRequest(...args);
  }

  followUp(
    ...args: Parameters<WebAnnotationRequests["followUp"]>
  ): ReturnType<WebAnnotationRequests["followUp"]> {
    return this.requests.followUp(...args);
  }

  requestResponse(
    ...args: Parameters<WebAnnotationRequests["requestResponse"]>
  ): ReturnType<WebAnnotationRequests["requestResponse"]> {
    return this.requests.requestResponse(...args);
  }

  startReconciler(
    ...args: Parameters<WebAnnotationRequests["startReconciler"]>
  ): ReturnType<WebAnnotationRequests["startReconciler"]> {
    return this.requests.startReconciler(...args);
  }

  stopReconciler(
    ...args: Parameters<WebAnnotationRequests["stopReconciler"]>
  ): ReturnType<WebAnnotationRequests["stopReconciler"]> {
    return this.requests.stopReconciler(...args);
  }

  reconcileOnce(
    ...args: Parameters<WebAnnotationRequests["reconcileOnce"]>
  ): ReturnType<WebAnnotationRequests["reconcileOnce"]> {
    return this.requests.reconcileOnce(...args);
  }

  noteTurnEnded(
    ...args: Parameters<WebAnnotationRequests["noteTurnEnded"]>
  ): ReturnType<WebAnnotationRequests["noteTurnEnded"]> {
    return this.requests.noteTurnEnded(...args);
  }

  // -------------------------------------------------------------------------
  // Legacy compose-draft migration

  migrationStatus(
    ...args: Parameters<WebAnnotationMigration["migrationStatus"]>
  ): ReturnType<WebAnnotationMigration["migrationStatus"]> {
    return this.migration.migrationStatus(...args);
  }

  migrate(
    ...args: Parameters<WebAnnotationMigration["migrate"]>
  ): ReturnType<WebAnnotationMigration["migrate"]> {
    return this.migration.migrate(...args);
  }

  mapMigratedComposeDraft(
    ...args: Parameters<WebAnnotationMigration["mapMigratedComposeDraft"]>
  ): ReturnType<WebAnnotationMigration["mapMigratedComposeDraft"]> {
    return this.migration.mapMigratedComposeDraft(...args);
  }

  reconcileDraft(
    ...args: Parameters<WebAnnotationMigration["reconcileDraft"]>
  ): ReturnType<WebAnnotationMigration["reconcileDraft"]> {
    return this.migration.reconcileDraft(...args);
  }
}
