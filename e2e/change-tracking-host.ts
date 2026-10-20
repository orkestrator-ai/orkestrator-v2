/** Real change commands in a disposable worktree; launched only by the browser spec. */
import { createServer } from "node:http";
import { writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { installFatalRejectionGuard } from "@orkestrator/protocol/fatal-rejections";
import { unknownCapabilities } from "@orkestrator/protocol/change-evidence";
import { ChangeEvidenceRecorder } from "@orkestrator/protocol/node/change-tracking/evidence-builders";
import { ChangeEvidenceSpool } from "@orkestrator/protocol/node/change-tracking/evidence-spool";
import { registerChangeCommands } from "../apps/backend/src/core/commands-registry-changes";
import type { CommandContext, CommandHandler } from "../apps/backend/src/core/commands-context";
import {
  createHarness,
  git,
  spoolSource,
} from "../apps/backend/src/core/change-tracking/service-test-support";

installFatalRejectionGuard({ label: "[change-tracking-browser-fixture]" });
const h = createHarness();
const service = h.service;
const handlers = new Map<string, CommandHandler>();
registerChangeCommands((name, handler) => handlers.set(name, handler));
const context = {
  runtime: { changeTracking: service, diffStats: { service: { isTracked: () => true } } },
} as unknown as CommandContext;
const scan = async () => {
  const at = new Date().toISOString();
  service.onDiffScanEvent({
    kind: "scanned",
    target: { kind: "local", environmentId: "env-1", worktreePath: h.repo, comparisonRef: "main" },
    result: {
      baseOid: git(h.repo, "rev-parse", "HEAD").trim(),
      stats: { additions: 1, deletions: 1, filesChanged: 1, truncated: false },
      changes: [
        {
          path: "a.txt",
          filename: "a.txt",
          directory: "",
          status: "M",
          additions: 1,
          deletions: 1,
        },
      ],
    },
    changed: true,
    at,
    startedAt: at,
  });
  await service.environments.idle();
};
const turn = {
  environmentId: "env-1",
  logicalSessionKey: "tab",
  requestId: "r1",
  provider: "codex",
};
await service.prepareTurnStart(turn);
service.markTurnDispatched("env-1", "tab", "r1", "accepted");
writeFileSync(join(h.repo, "a.txt"), "one\nFIRST\n");
service.rememberConversation("env-1", "codex", "s", "tab");
const spool = new ChangeEvidenceSpool();
const rec = new ChangeEvidenceRecorder({
  spool,
  provider: "codex",
  capabilities: unknownCapabilities("fixture"),
});
rec.tool(
  { conversationId: "s", callId: "edit" },
  {
    toolKind: "file-edit",
    phase: "succeeded",
    executionOccurrence: "started",
    evidence: [
      {
        kind: "patch",
        text: "--- a/a.txt\n+++ b/a.txt\n@@ -1,2 +1,2 @@\n one\n-two\n+FIRST\n",
        claim: "provider-reported",
      },
    ],
  },
);
await service.pullEvidence(spoolSource(spool, "codex"));
await service.finalizeTurn(turn);
await scan();

const server = createServer(async (request, response) => {
  try {
    let bytes = 0;
    const chunks: Buffer[] = [];
    for await (const chunk of request) {
      const buffer = Buffer.from(chunk);
      bytes += buffer.length;
      if (bytes > 1024 * 1024) throw new Error("request-limit");
      chunks.push(buffer);
    }
    const { command, args = {} } = JSON.parse(Buffer.concat(chunks).toString());
    let result: unknown;
    if (command === "fixture_edit") {
      writeFileSync(
        join(h.repo, "a.txt"),
        args.version === "second" ? "one\nSECOND\n" : "one\nFIRST\n",
      );
      await scan();
      result = null;
    } else if (command === "fixture_scan") {
      await scan();
      result = null;
    } else if (command === "fixture_content") result = readFileSync(join(h.repo, "a.txt"), "utf8");
    else {
      const handler = handlers.get(command);
      if (!handler) throw new Error("unsupported-command");
      result = await handler(args, context);
    }
    response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify({ result }));
  } catch {
    response.statusCode = 500;
    response.end(JSON.stringify({ error: "fixture-command-failed" }));
  }
});
server.listen(0, "127.0.0.1", () => {
  const address = server.address();
  if (address && typeof address !== "string")
    process.stdout.write(`CHANGES_PORT:${address.port}\n`);
});
process.stdin.resume();
process.stdin.on("end", () =>
  server.close(() => {
    h.cleanup();
    process.exit(0);
  }),
);
