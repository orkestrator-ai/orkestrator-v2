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
 * `readAfterWriteMs` is an inbox read that follows a send, so it never finds
 * the store unchanged. Each figure is the mean milliseconds per call and the
 * CPU milliseconds per call. Figures are machine- and load-specific; compare
 * runs on one host only. Todo 0741 records measured runs.
 */

const environments = Math.max(2, option("environments", 100));
const tabs = Math.max(1, option("tabs", 6));
const messages = option("messages", 600);
const iterations = Math.max(1, option("iterations", 200));

const fixture = await createAgentMailBenchFixture({
  prefix: "ork-mail-store-bench-",
  environments,
  tabs,
  messages,
});
const { storage } = fixture;
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

const env = (index: number) => `env-${index % environments}`;
const tab = (index: number) => `tab-${index % tabs}`;
const send = (index: number) =>
  storage.sendAgentMail(
    { kind: "tab", environmentId: env(index), projectId: "project", tabId: "tab-0" },
    {
      requestId: `bench-run-${(sequence += 1)}`,
      toEnvironmentId: env(index + 1),
      toTabId: tab(index),
      body: "m".repeat(1_800),
    },
  );

try {
  const sent = await send(0);
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
    readAfterWriteMs: await measure(async (index) => {
      const message = await send(index);
      await storage.getAgentMailMailbox(message.toEnvironmentId, message.toTabId, { limit: 50 });
    }),
  };
  fixture.log(JSON.stringify({ environments, tabs, messages, iterations, ...results }));
} finally {
  await fixture.dispose();
}
process.exit(0);
