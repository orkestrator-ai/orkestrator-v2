import { StorageService } from "../src/core/storage/service.js";
import { benchOption as option, createAgentMailBenchFixture } from "./agent-mail-bench-fixture.js";

/**
 * What the agent mail calls cost the backend, against a synthetic data
 * directory in the system temporary directory:
 *
 *   mise exec -- bun apps/backend/scripts/agent-mail-store-bench.ts \
 *     [--environments 100] [--tabs 6] [--messages 600] [--iterations 200]
 *
 * Times the storage reads behind `check_inbox` (identity, then the inbox),
 * `send_message` (directory, send, recipient mailbox), `message_status`, the
 * inject sweep and the UI summary, and two writes (send and acknowledge).
 * The after-write reads target one fixed environment and inbox after a
 * second connection sends elsewhere. Only unrelated mail grows with
 * `--messages`. The receipt-only samples prepare a fresh message in the same
 * recipient mailbox on that second connection outside the timed interval.
 * Figures are mean wall and CPU milliseconds per call. Compare runs on one
 * host with the same environment, tab and iteration counts.
 */

const environments = Math.max(3, option("environments", 100));
const tabs = Math.max(1, option("tabs", 6));
const messages = option("messages", 600);
const iterations = Math.max(1, option("iterations", 200));

const fixture = await createAgentMailBenchFixture({
  prefix: "ork-mail-store-bench-",
  environments,
  tabs,
  messages,
  reserveFirstEnvironment: true,
});
const { storage } = fixture;
const writer = new StorageService(fixture.dataDir);
const round = (value: number) => Math.round(value * 100) / 100;
let sequence = 0;

async function measure(operation: (index: number) => Promise<unknown>) {
  for (let index = 0; index < 5; index += 1) await operation(index);
  const cpuBefore = process.cpuUsage();
  const started = performance.now();
  for (let index = 0; index < iterations; index += 1) await operation(index);
  const wall = performance.now() - started;
  const cpu = process.cpuUsage(cpuBefore);
  return {
    ms: round(wall / iterations),
    cpuMs: round((cpu.user + cpu.system) / 1_000 / iterations),
  };
}

/** Time the operation alone, after a commit on the other connection. */
async function measureAfterSend(
  prepare: (index: number) => ReturnType<typeof send>,
  operation: (message: Awaited<ReturnType<typeof send>>) => Promise<unknown>,
) {
  let wall = 0;
  let cpu = 0;
  for (let index = 0; index < iterations + 5; index += 1) {
    const message = await prepare(index);
    const cpuBefore = process.cpuUsage();
    const started = performance.now();
    await operation(message);
    if (index < 5) continue;
    wall += performance.now() - started;
    const used = process.cpuUsage(cpuBefore);
    cpu += (used.user + used.system) / 1_000;
  }
  return { ms: round(wall / iterations), cpuMs: round(cpu / iterations) };
}

const env = (index: number) => `env-${1 + (index % (environments - 1))}`;
const tab = (index: number) => `tab-${index % tabs}`;
const target = { environmentId: "env-0", tabId: "tab-0" };
const send = (index: number, recipient = { environmentId: env(index + 1), tabId: tab(index) }) =>
  writer.sendAgentMail(
    { kind: "tab", environmentId: env(index), projectId: "project", tabId: "tab-0" },
    {
      requestId: `bench-run-${(sequence += 1)}`,
      toEnvironmentId: recipient.environmentId,
      toTabId: recipient.tabId,
      body: "m".repeat(1_800),
    },
  );

const sendElsewhere = (index: number) => send(index);
const sendToTarget = (index: number) => send(index, target);

try {
  await writer.init();
  const sent = await sendToTarget(0);
  const results = {
    pullTabIdsMs: await measure((index) => storage.listAgentMailPullTabIds(env(index))),
    directoryMs: await measure((index) =>
      storage.listAgentMailboxes({
        environmentId: env(index),
        currentEnvironmentId: env(index),
        limit: 200,
      }),
    ),
    inboxMs: await measure((index) =>
      storage.getAgentMailMailbox(env(index), tab(index), { unreadOnly: true, limit: 50 }),
    ),
    statusMs: await measure(() => storage.getAgentMailStatus(sent.id)),
    pendingInjectsMs: await measure(() => storage.listPendingAgentMailInjects(100)),
    summaryMs: await measure(() => storage.getAgentMailSummary()),
    sendMs: await measure((index) => send(index)),
    ackMs: await measure(async (index) => {
      const message = await send(index);
      await storage.ackAgentMail(message.toEnvironmentId, message.toTabId, message.id);
    }),
    identityAfterWriteMs: await measureAfterSend(sendElsewhere, () =>
      storage.listAgentMailPullTabIds(target.environmentId),
    ),
    directoryAfterWriteMs: await measureAfterSend(sendElsewhere, () =>
      storage.listAgentMailboxes({
        environmentId: target.environmentId,
        currentEnvironmentId: target.environmentId,
        limit: 200,
      }),
    ),
    inboxAfterWriteMs: await measureAfterSend(sendElsewhere, () =>
      storage.getAgentMailMailbox(target.environmentId, target.tabId, {
        unreadOnly: true,
        limit: 50,
      }),
    ),
    mailboxBatchAfterWriteMs: await measureAfterSend(sendElsewhere, () =>
      storage.getAgentMailMailboxes([target]),
    ),
    statusAfterWriteMs: await measureAfterSend(sendElsewhere, () =>
      storage.getAgentMailStatus(sent.id),
    ),
    acknowledgeOnlyMs: await measureAfterSend(sendToTarget, (message) =>
      storage.ackAgentMail(target.environmentId, target.tabId, message.id),
    ),
    seenOnlyMs: await measureAfterSend(sendToTarget, (message) =>
      storage.markAgentMailSeen(target.environmentId, target.tabId, message.id),
    ),
  };
  fixture.log(JSON.stringify({ environments, tabs, messages, iterations, ...results }));
} finally {
  writer.close();
  await fixture.dispose();
}
process.exit(0);
