import { randomUUID } from "node:crypto";
import { AGENT_MAIL_MAX_STORE_BYTES } from "@orkestrator/protocol/agent-mail";
import { recurringWorkMetrics } from "../src/core/recurring-work-metrics.js";
import type {
  AgentMailStore,
  PersistedAgentMailStore,
} from "../src/core/storage-agent-mail-store.js";
import { openBackendDatabase } from "../src/core/storage-stores.js";
import {
  readStoredValue,
  seedStore,
  storageDatabase,
  storageInternals,
} from "../src/core/storage-test-support.js";
import { benchOption as option, createAgentMailBenchFixture } from "./agent-mail-bench-fixture.js";

/**
 * What a mail write, an inject change and the mailbox list cost as the agent
 * mail store grows towards its 32 MiB bound, and what the read model keeps in
 * memory. Against a synthetic data directory in the system temporary
 * directory; no provider is involved:
 *
 *   mise exec -- bun --expose-gc apps/backend/scripts/agent-mail-store-size-bench.ts \
 *     [--environments 100] [--tabs 6] [--iterations 20] [--sizes 1,8,16,31]
 *
 * For each target size (MiB) the store is filled with acknowledged 1.8 KB
 * messages spread evenly over every mailbox, the newest of each pending
 * injection (up to 1,000), then:
 *
 * - `loadMs`: the whole-store parse every writer starts with (`load`).
 * - `sendMs`: `sendAgentMail`, one `enqueue` write (load, change, serialise
 *   every row, write the changed ones).
 * - `injectClaimMs`: `beginAgentMailInject`, which changes a message and its
 *   pending-inject entry.
 * - `backoffResetMs`: `resetAgentMailInjectBackoff`, which changes only
 *   pending-inject entries (the envelope).
 * - `listWarmMs`: `listAgentMailboxes` on an unchanged store (one revision
 *   query); `listAfterWriteMs`: the same after a send, so one changed mailbox
 *   row is parsed again; `listRebuildMs`: the first list after a restart,
 *   which parses every row.
 * - `presenceBytesAfterWrite` and `presenceBytesAfterOtherProcessWrite`: the
 *   `storage-read` bytes the recurring-work metrics charge to one
 *   `mail-presence` list after a send in this process, and after another
 *   connection changed one mailbox (what the metric can show on a real host).
 * - `readModelRetainedBytes`: heap the parsed read model holds (the largest
 *   change in heap used, after a full collection, as it is dropped and
 *   rebuilt), next to `storeBytes` (the serialised rows, which the
 *   database's row cache also holds) and `bodyBytes` (message bodies, the
 *   part a body-free list would not keep).
 *
 * Each timing is the mean wall and CPU milliseconds per call. Figures are
 * machine- and load-specific; compare runs on one host only. Todo 6760 records
 * measured runs.
 */

const environments = Math.max(2, option("environments", 100));
const tabs = Math.max(1, option("tabs", 6));
const iterations = Math.max(1, option("iterations", 20));
const sizesArg = process.argv[process.argv.indexOf("--sizes") + 1];
const sizes = (process.argv.includes("--sizes") && sizesArg ? sizesArg : "1,8,16,31")
  .split(",")
  .map(Number)
  .filter((value) => Number.isFinite(value) && value > 0);
const PENDING_INJECTS = 1_000;
const BODY = "m".repeat(1_800);
recurringWorkMetrics.setEnabled(true);

const gc = (globalThis as { gc?: () => void }).gc ?? (() => Bun.gc(true));
const round = (value: number) => Math.round(value * 100) / 100;
/** JS heap plus string and buffer storage outside it, after a full collection. */
const heapUsed = () => {
  gc();
  gc();
  const usage = process.memoryUsage();
  return usage.heapUsed + usage.external;
};

// Sends evict the oldest settled message once a mailbox is full; the seeded
// mail is acknowledged, so the store stays at its seeded size.
const fixture = await createAgentMailBenchFixture({
  prefix: "ork-mail-size-bench-",
  environments,
  tabs,
  messages: environments,
});
const { storage, dataDir } = fixture;
const { repos } = storageInternals(storage);
const mailStore = (repos.agentMail as unknown as { store: AgentMailStore }).store;
const readModelHolder = mailStore as unknown as { readModel: unknown };
let sequence = 0;

async function measure(operation: (index: number) => Promise<unknown>, count = iterations) {
  await operation(-1);
  const cpuBefore = process.cpuUsage();
  const started = performance.now();
  for (let index = 0; index < count; index += 1) await operation(index);
  const wall = performance.now() - started;
  const cpu = process.cpuUsage(cpuBefore);
  return { ms: round(wall / count), cpuMs: round((cpu.user + cpu.system) / 1_000 / count) };
}

const env = (index: number) => `env-${(index + environments) % environments}`;
const send = (index: number) =>
  storage.sendAgentMail(
    { kind: "tab", environmentId: env(index), projectId: "project", tabId: "tab-0" },
    {
      requestId: `size-bench-${(sequence += 1)}`,
      toEnvironmentId: env(index + 1),
      toTabId: `tab-${(index + tabs) % tabs}`,
      body: BODY,
    },
  );

/** Fills every mailbox to `perMailbox` acknowledged messages and seeds pending injects. */
function seed(perMailbox: number): {
  pending: Array<{ mailboxId: string; messageId: string; incarnationId: string }>;
} {
  const current = readStoredValue<PersistedAgentMailStore>(dataDir, "agent-mail.json")!;
  const mailboxes = Object.values(current.mailboxes);
  const template = mailboxes.flatMap((mailbox) => mailbox.messages)[0]!;
  const now = Date.now();
  const pending: Array<{ mailboxId: string; messageId: string; incarnationId: string }> = [];
  const pendingInject: PersistedAgentMailStore["pendingInject"] = [];
  let created = 0;
  for (const [mailboxIndex, mailbox] of mailboxes.entries()) {
    mailbox.messages = Array.from({ length: perMailbox }, (_, index) => {
      const id = randomUUID();
      const isPending = pending.length < PENDING_INJECTS && index === perMailbox - 1;
      created += 1;
      const message = {
        ...structuredClone(template),
        id,
        toEnvironmentId: mailbox.environmentId,
        toTabId: mailbox.tabId,
        toIncarnationId: mailbox.incarnationId,
        createdAt: new Date(now - (perMailbox - index) * 60_000).toISOString(),
        sequence: created,
        revision: 1,
      };
      if (isPending) {
        message.placement = "pending-inject";
        delete message.ackedAt;
        delete message.placementReason;
        pending.push({
          mailboxId: mailbox.mailboxId,
          messageId: id,
          incarnationId: mailbox.incarnationId,
        });
        pendingInject.push({
          mailboxId: mailbox.mailboxId,
          messageId: id,
          // Every other mailbox carries busy backoff for the reset to clear.
          ...(mailboxIndex % 2 === 1
            ? { nextAttemptAt: new Date(now + 3_600_000).toISOString(), attempts: 1 }
            : {}),
        });
      } else {
        message.placement = "injected";
        message.ackedAt = message.createdAt;
      }
      return message;
    });
    mailbox.revision += 1;
  }
  seedStore(dataDir, "agent-mail.json", {
    ...current,
    revision: current.revision + created,
    pendingInject,
  });
  return { pending };
}

/** `storage-read` bytes one `mail-presence` mailbox list is charged. */
async function presenceBytes(): Promise<number> {
  const before = recurringWorkMetrics.snapshot().kinds["mail-presence"]?.bytes ?? 0;
  await recurringWorkMetrics.observe("mail-presence", () =>
    storage.listAgentMailboxes({ limit: 200 }),
  );
  return (recurringWorkMetrics.snapshot().kinds["mail-presence"]?.bytes ?? 0) - before;
}

/** Renames one mailbox through a second connection, as another process would. */
function writeFromOtherProcess(index: number): void {
  const database = openBackendDatabase(dataDir);
  try {
    const value = database.readStore("agent-mail")!.value as PersistedAgentMailStore;
    const mailbox = Object.values(value.mailboxes)[index % Object.keys(value.mailboxes).length]!;
    mailbox.title = `renamed ${index}`;
    mailbox.revision += 1;
    database.writeStore("agent-mail", value);
  } finally {
    database.close();
  }
}

function storeShape() {
  const serialized = storageDatabase(storage).readStoreSerialized("agent-mail")!;
  let storeBytes = serialized.document ? Buffer.byteLength(serialized.document) : 0;
  let mailboxRowBytes = 0;
  for (const row of serialized.rows) {
    const bytes = Buffer.byteLength(row.value);
    storeBytes += bytes;
    if (row.collection === "mailboxes") mailboxRowBytes += bytes;
  }
  return {
    storeBytes,
    envelopeBytes: serialized.document ? Buffer.byteLength(serialized.document) : 0,
    mailboxRowBytes,
  };
}

try {
  const mailboxes = environments * tabs;
  // Calibrate the serialised size of one seeded message with two per mailbox.
  seed(2);
  const messageBytes = storeShape().mailboxRowBytes / (2 * mailboxes);
  for (const mib of sizes) {
    const perMailbox = Math.max(
      1,
      Math.min(200, Math.floor((mib * 1024 * 1024) / mailboxes / messageBytes)),
    );
    const { pending } = seed(perMailbox);
    const shape = storeShape();
    await storage.listAgentMailboxes({ limit: 200 });
    const bodyBytes = Object.values((await mailStore.snapshot()).mailboxes).reduce(
      (sum, mailbox) =>
        sum + mailbox.messages.reduce((inner, message) => inner + message.body.length, 0),
      0,
    );
    // Heap the read model holds: dropped and rebuilt four times. Bun's heap
    // accounting can lag a collection, so a reading may come out near zero;
    // the largest fall or rise after the first cycle is the figure.
    const deltas: number[] = [];
    for (let cycle = 0; cycle < 4; cycle += 1) {
      const withModel = heapUsed();
      readModelHolder.readModel = null;
      const withoutModel = heapUsed();
      await storage.listAgentMailboxes({ limit: 200 });
      if (cycle > 0) deltas.push(withModel - withoutModel, heapUsed() - withoutModel);
    }
    const readModelRetainedBytes = Math.max(...deltas);

    const loadMs = await measure(() => mailStore.load());
    const listWarmMs = await measure(() => storage.listAgentMailboxes({ limit: 200 }));
    const listRebuildMs = await measure(async () => {
      readModelHolder.readModel = null;
      await storage.listAgentMailboxes({ limit: 200 });
    });
    const sendMs = await measure((index) => send(index));
    let listAfterWriteWall = 0;
    for (let index = 0; index < iterations; index += 1) {
      await send(index);
      const started = performance.now();
      await storage.listAgentMailboxes({ limit: 200 });
      listAfterWriteWall += performance.now() - started;
    }
    const listAfterWriteMs = { ms: round(listAfterWriteWall / iterations) };
    await send(0);
    const presenceBytesAfterWrite = await presenceBytes();
    writeFromOtherProcess(mib);
    const presenceBytesAfterOtherProcessWrite = await presenceBytes();
    const claimable = pending.filter((_, index) => index % 2 === 0);
    let claim = 0;
    const injectClaimMs = await measure(async () => {
      const target = claimable[claim++ % claimable.length]!;
      await storage.beginAgentMailInject(target.mailboxId, target.messageId, target.incarnationId);
    });
    const backedOff = pending.filter((_, index) => index % 2 === 1);
    let reset = 0;
    const backoffResetMs = await measure(async () => {
      const target = backedOff[reset++ % backedOff.length]!;
      await storage.resetAgentMailInjectBackoff(target.mailboxId);
    });
    fixture.log(
      JSON.stringify({
        targetMiB: mib,
        maxStoreBytes: AGENT_MAIL_MAX_STORE_BYTES,
        mailboxes,
        messagesPerMailbox: perMailbox,
        pendingInjects: pending.length,
        ...shape,
        bodyBytes,
        readModelRetainedBytes,
        iterations,
        loadMs,
        sendMs,
        injectClaimMs,
        backoffResetMs,
        listWarmMs,
        listAfterWriteMs,
        listRebuildMs,
        presenceBytesAfterWrite,
        presenceBytesAfterOtherProcessWrite,
      }),
    );
  }
} finally {
  await fixture.dispose();
}
process.exit(0);
