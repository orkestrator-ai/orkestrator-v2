import {
  LIST_ENVIRONMENT_HYDRATION_COMMAND,
  MAX_ENVIRONMENT_HYDRATION_IDS,
  type EnvironmentHydrationBatch,
  type EnvironmentHydrationPart,
} from "@orkestrator/protocol/environment-hydration";
import { backendForScope } from "@/lib/backend/scope-backend";
import type { NodeScope } from "@/lib/node-scope/node-scope";
import { appCommandScope, defineScopedSlot } from "@/lib/node-scope-slots";
import { applyMultiReviewWorkflowsForEnvironment } from "@/lib/multi-review-persistence";
import {
  applyPromptQueuesForEnvironment,
  type PromptQueueSource,
} from "@/lib/prompt-queue-persistence";
import { incompatibility } from "@orkestrator/protocol/contract/errors";
import { hydrationActivity } from "@/lib/hydration-activity";
import type { MultiReviewWorkflow } from "@orkestrator/protocol/multi-review";
import type { PersistedPromptQueue, PersistedWorkflowRecord } from "@/types";

/**
 * The renderer's boot restore of per-environment lists, batched.
 *
 * Restoring prompt queues and Multi Review workflows used to cost one
 * `list_prompt_queues` and one `list_multi_review_workflows` request per
 * environment. Requests made in the same task (every environment of a newly
 * loaded project, from both restore hooks) are collected and sent as
 * `list_environment_hydration` calls of at most `MAX_ENVIRONMENT_HYDRATION_IDS`
 * environments each, so a project of 40 environments costs one request
 * instead of 80. Every call goes through the renderer's hydration bound
 * (`hydration-request-limiter.ts`). Each environment, and each of its two
 * lists, settles on its own: one failed read rejects only that list.
 *
 * Only requests not yet sent are joined; a request made while a batch is in
 * flight goes in the next one, so it never receives a read that predates it.
 * A backend without the command answers "unknown command" once, and from then
 * on the batcher reads each requested list per environment, as before.
 */

type PartName = "promptQueues" | "multiReviewWorkflows";

type Waiter<T> = { resolve(value: T): void; reject(error: unknown): void };

interface PendingEnvironment {
  promptQueues: Array<Waiter<PersistedPromptQueue[]>>;
  multiReviewWorkflows: Array<Waiter<Array<PersistedWorkflowRecord<unknown>>>>;
}

export interface EnvironmentHydrationDependencies {
  listBatch(
    environmentIds: string[],
  ): Promise<EnvironmentHydrationBatch<PersistedPromptQueue, PersistedWorkflowRecord<unknown>>>;
  listPromptQueues(environmentId: string): Promise<PersistedPromptQueue[]>;
  listMultiReviewWorkflows(environmentId: string): Promise<Array<PersistedWorkflowRecord<unknown>>>;
  /** Runs `flush` once the current task's requests are in; defaults to a zero-delay timer. */
  schedule?(flush: () => void): void;
}

export class EnvironmentHydrationBatcher {
  private pending = new Map<string, PendingEnvironment>();
  private scheduled = false;
  private batchSupported = true;

  constructor(private readonly dependencies: EnvironmentHydrationDependencies) {}

  promptQueues(environmentId: string): Promise<PersistedPromptQueue[]> {
    return new Promise((resolve, reject) => {
      this.entry(environmentId).promptQueues.push({ resolve, reject });
      this.scheduleFlush();
    });
  }

  multiReviewWorkflows(environmentId: string): Promise<Array<PersistedWorkflowRecord<unknown>>> {
    return new Promise((resolve, reject) => {
      this.entry(environmentId).multiReviewWorkflows.push({ resolve, reject });
      this.scheduleFlush();
    });
  }

  private entry(environmentId: string): PendingEnvironment {
    let entry = this.pending.get(environmentId);
    if (!entry) {
      entry = { promptQueues: [], multiReviewWorkflows: [] };
      this.pending.set(environmentId, entry);
    }
    return entry;
  }

  private scheduleFlush(): void {
    if (this.scheduled) return;
    this.scheduled = true;
    const schedule =
      this.dependencies.schedule ?? ((flush: () => void) => void globalThis.setTimeout(flush, 0));
    schedule(() => {
      this.scheduled = false;
      const batch = this.pending;
      this.pending = new Map();
      void this.send(batch);
    });
  }

  private async send(batch: Map<string, PendingEnvironment>): Promise<void> {
    const ids = Array.from(batch.keys());
    const chunks: string[][] = [];
    for (let index = 0; index < ids.length; index += MAX_ENVIRONMENT_HYDRATION_IDS) {
      chunks.push(ids.slice(index, index + MAX_ENVIRONMENT_HYDRATION_IDS));
    }
    // The limiter bounds how many of these run at once.
    await Promise.all(chunks.map((chunk) => this.sendChunk(chunk, batch)));
  }

  private async sendChunk(ids: string[], batch: Map<string, PendingEnvironment>): Promise<void> {
    if (this.batchSupported) {
      let response: Awaited<ReturnType<EnvironmentHydrationDependencies["listBatch"]>>;
      try {
        response = await this.dependencies.listBatch(ids);
      } catch (error) {
        // A failed batch must not make an unrelated environment's lists fail.
        // Only an unsupported command disables batching for future requests;
        // transient transport/validation failures fall back for this chunk.
        if (
          incompatibility(error, LIST_ENVIRONMENT_HYDRATION_COMMAND)?.code === "unknown-command"
        ) {
          this.batchSupported = false;
        }
        return this.sendSeparately(ids, batch);
      }
      const answered = new Map(response.environments.map((entry) => [entry.environmentId, entry]));
      for (const id of ids) {
        const waiting = batch.get(id)!;
        const entry = answered.get(id);
        settle(waiting.promptQueues, entry?.promptQueues, "promptQueues");
        settle(waiting.multiReviewWorkflows, entry?.multiReviewWorkflows, "multiReviewWorkflows");
      }
      return;
    }
    return this.sendSeparately(ids, batch);
  }

  /** Isolated reads when a batch fails or the backend lacks the command. */
  private async sendSeparately(
    ids: string[],
    batch: Map<string, PendingEnvironment>,
  ): Promise<void> {
    await Promise.all(
      ids.flatMap((id) => {
        const waiting = batch.get(id)!;
        return [
          waiting.promptQueues.length > 0
            ? forward(waiting.promptQueues, () => this.dependencies.listPromptQueues(id))
            : null,
          waiting.multiReviewWorkflows.length > 0
            ? forward(waiting.multiReviewWorkflows, () =>
                this.dependencies.listMultiReviewWorkflows(id),
              )
            : null,
        ].filter((task): task is Promise<void> => task !== null);
      }),
    );
  }
}

function settle<T>(
  waiters: Array<Waiter<T[]>>,
  part: EnvironmentHydrationPart<T> | undefined,
  name: PartName,
): void {
  if (part?.status === "ok") {
    for (const waiter of waiters) waiter.resolve(part.records);
    return;
  }
  const error = new Error(
    part ? `The ${name} read failed for this environment` : `The batch omitted ${name}`,
  );
  for (const waiter of waiters) waiter.reject(error);
}

async function forward<T>(waiters: Array<Waiter<T>>, load: () => Promise<T>): Promise<void> {
  try {
    const value = await load();
    for (const waiter of waiters) waiter.resolve(value);
  } catch (error) {
    for (const waiter of waiters) waiter.reject(error);
  }
}

/**
 * One batcher per node scope (plan item 4007): a node's boot restore reads
 * its own node, and two nodes' environments never share a batch.
 */
const scopeHydration = defineScopedSlot("environment-hydration", (scope) => {
  const node = () => backendForScope(scope);
  return new EnvironmentHydrationBatcher({
    listBatch: (environmentIds) => node().listEnvironmentHydration(environmentIds),
    listPromptQueues: (environmentId) => node().listPromptQueues(environmentId),
    listMultiReviewWorkflows: (environmentId) => node().listMultiReviewWorkflows(environmentId),
  });
});

/** `scope`'s batcher; the app's command scope when omitted. */
export function environmentHydrationFor(scope: NodeScope = appCommandScope()) {
  return scopeHydration(scope);
}

/**
 * Boot restore of one environment's prompt queues, through its node's batcher,
 * into `sources` (that node's: `createPromptQueueSources(scope)`).
 */
export async function hydrateBootPromptQueues(
  environmentId: string,
  sources: ReadonlyArray<PromptQueueSource>,
  batcher: EnvironmentHydrationBatcher = environmentHydrationFor(),
): Promise<void> {
  return hydrationActivity.track(async () => {
    applyPromptQueuesForEnvironment(
      environmentId,
      await batcher.promptQueues(environmentId),
      sources,
    );
  });
}

/**
 * Boot restore of one environment's Multi Review workflows, through its
 * node's batcher, into that node's store. Same result as
 * `hydrateMultiReviewWorkflowsForEnvironment`, which stays the single read
 * for callers that need one environment now.
 */
export async function hydrateBootMultiReviewWorkflows(
  environmentId: string,
  batcher: EnvironmentHydrationBatcher = environmentHydrationFor(),
  scope: NodeScope = appCommandScope(),
): Promise<MultiReviewWorkflow[]> {
  return hydrationActivity.track(async () =>
    applyMultiReviewWorkflowsForEnvironment(
      environmentId,
      await batcher.multiReviewWorkflows(environmentId),
      scope,
    ),
  );
}
