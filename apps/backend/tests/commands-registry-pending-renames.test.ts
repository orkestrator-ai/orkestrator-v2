import { describe, expect, spyOn, test } from "bun:test";
import { existsSync } from "node:fs";

import { captureLogs, type LogCapture } from "@orkestrator/protocol/testing/log-capture";
import { createCommandFixtures } from "./command-fixtures";

function renameEntries(logs: LogCapture) {
  return logs
    .records()
    .filter((record) => record.event.startsWith("rename."))
    .map((record) => [record.event, record.fields]);
}

const {
  ASYNC_TEST_BUDGET_MS,
  codexSlugScript,
  createCommandRegistry,
  createContext,
  createEnvironment,
  fs,
  isolateCodexBinaryLookup,
  waitForCondition,
  withFakeCodex,
} = await createCommandFixtures();

describe("pending environment rename recovery", () => {
  for (const pendingRenamePrompt of [undefined, "A replacement intent"]) {
    test(
      `does not report recovery when an in-flight retry's intent becomes ${pendingRenamePrompt === undefined ? "cleared" : "replaced"}`,
      async () => {
        const environment = createEnvironment({
          id: "env-declined-retry",
          name: "20260415-123456",
          branch: "20260415-123456",
          status: "running",
          worktreePath: undefined,
          pendingRenamePrompt: "The original intent",
        });
        const { context, emitted } = createContext(environment);
        await isolateCodexBinaryLookup(context);
        const commands = createCommandRegistry();
        const reconcile = () => commands.get("reconcile_pending_environment_renames")!({}, context);
        const logs = captureLogs();
        const realNow = Date.now.bind(Date);
        let elapsed = 0;
        const now = spyOn(Date, "now").mockImplementation(() => realNow() + elapsed);

        try {
          await withFakeCodex(
            codexSlugScript("Retry Recovered").replace(
              'out=""',
              `if [ ! -f "$FAKE_CODEX_LOG.failed" ]; then
  touch "$FAKE_CODEX_LOG.failed"
  exit 1
fi
if [ ! -f "$FAKE_CODEX_LOG.waiting" ]; then
  touch "$FAKE_CODEX_LOG.waiting"
  attempts=0
  while [ ! -f "$FAKE_CODEX_LOG.release" ]; do
    attempts=$((attempts + 1))
    [ "$attempts" -lt 1000 ] || exit 2
    sleep 0.01
  done
fi
out=""`,
            ),
            async (logPath) => {
              await reconcile();
              expect(renameEntries(logs)).toEqual([
                ["rename.failed", expect.objectContaining({ environmentId: environment.id })],
              ]);

              elapsed += 30_000;
              const retry = reconcile();
              try {
                await waitForCondition(
                  () => existsSync(`${logPath}.waiting`),
                  "Codex retry in flight",
                );
                await context.storage.updateEnvironment(environment.id, {
                  name: "manual-choice",
                  pendingRenamePrompt,
                });
              } finally {
                await fs.writeFile(`${logPath}.release`, "");
                await retry;
              }

              expect(environment.name).toBe("manual-choice");
              expect(environment.pendingRenamePrompt).toBe(pendingRenamePrompt);
              expect(emitted.filter(({ event }) => event === "environment-renamed")).toHaveLength(
                0,
              );
              expect(renameEntries(logs)).toHaveLength(1);

              // Resuming the same intent proves a declined retry kept its history.
              await context.storage.updateEnvironment(environment.id, {
                pendingRenamePrompt: "The original intent",
              });
              await reconcile();
              expect(environment.name).toBe("retry-recovered");
              expect(environment.pendingRenamePrompt).toBeUndefined();
              expect(renameEntries(logs).at(-1)).toEqual([
                "rename.recovered",
                { environmentId: environment.id, failures: 1 },
              ]);
            },
          );
        } finally {
          now.mockRestore();
          logs.restore();
        }
      },
      ASYNC_TEST_BUDGET_MS,
    );
  }

  test(
    "reconciliation retains failure history for stopped intents and prunes cleared intents",
    async () => {
      const prompt = "Keep this intent while stopped";
      const environment = createEnvironment({
        id: "env-retained-failures",
        name: "20260415-123456",
        branch: "20260415-123456",
        status: "running",
        worktreePath: undefined,
        pendingRenamePrompt: prompt,
      });
      const { context } = createContext(environment);
      await isolateCodexBinaryLookup(context);
      const commands = createCommandRegistry();
      const reconcile = () => commands.get("reconcile_pending_environment_renames")!({}, context);
      const logs = captureLogs();
      const now = spyOn(Date, "now").mockReturnValue(100_000);

      try {
        await withFakeCodex("#!/bin/sh\nexit 1\n", async () => {
          await reconcile();
          environment.status = "stopped";
          now.mockReturnValue(130_000);
          await reconcile();
          expect(renameEntries(logs)).toHaveLength(1);

          environment.status = "running";
          await reconcile();
          expect(renameEntries(logs).at(-1)).toEqual([
            "rename.still-failing",
            { environmentId: environment.id, failures: 2, reason: "command-failed" },
          ]);

          environment.pendingRenamePrompt = undefined;
          await reconcile();
          expect(renameEntries(logs)).toHaveLength(2);

          // Reuse the same prompt to distinguish pruning from intent replacement.
          environment.pendingRenamePrompt = prompt;
          now.mockReturnValue(160_000);
          await reconcile();
          expect(renameEntries(logs)).toEqual([
            ["rename.failed", expect.objectContaining({ environmentId: environment.id })],
            [
              "rename.still-failing",
              { environmentId: environment.id, failures: 2, reason: "command-failed" },
            ],
            ["rename.failed", expect.objectContaining({ environmentId: environment.id })],
          ]);
        });
      } finally {
        now.mockRestore();
        logs.restore();
      }
    },
    ASYNC_TEST_BUDGET_MS,
  );
});
