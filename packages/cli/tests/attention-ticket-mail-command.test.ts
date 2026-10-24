import { afterEach, describe, expect, test } from "bun:test";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { publicSuccessEnvelope, type PublicReceipt } from "@orkestrator/protocol/public-api";
import type {
  PublicAttentionItem,
  PublicAttentionPage,
} from "@orkestrator/protocol/public-api-resources";
import { PUBLIC_API_FIXTURES } from "@orkestrator/protocol/testing/public-api-fixtures";
import {
  createSandbox,
  defaultResponder,
  envelope,
  startFakeGateway,
  type ClientSandbox,
  type FakeGateway,
  type RecordedRequest,
} from "./support/client-harness.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

function receipt(action: PublicReceipt["action"]): PublicReceipt {
  return {
    ...PUBLIC_API_FIXTURES.runCompleted.receipt!,
    operationId: "op-1790000000000-0a1b2c3d-000000000000000011",
    action,
    state: "succeeded",
    stage: "completed",
  };
}

async function fixture(
  respond: (request: RecordedRequest) => Response | undefined,
): Promise<{ box: ClientSandbox; gateway: FakeGateway }> {
  const box = await createSandbox();
  const gateway = await startFakeGateway(
    (request) => respond(request) ?? defaultResponder()(request),
  );
  cleanups.push(
    () => box.cleanup(),
    () => gateway.stop(),
  );
  const dataDir = await box.publishDescriptor(gateway);
  await box.run(["connection", "add", "local", "--data-dir", dataDir, "--default", "--no-check"]);
  return { box, gateway };
}

function requestsFor(gateway: FakeGateway, action: string) {
  return gateway.requests.filter((request) => request.body.args.action === action);
}

const APPROVAL: PublicAttentionItem = {
  kind: "interaction",
  at: "2026-10-24T10:00:00.000Z",
  sessionId: "ses_abc",
  environmentId: "env-1",
  environmentName: "auth-fix",
  agent: "claude",
  interactionId: "approval-1",
  interactionKind: "command-approval",
  revision: 2,
  blocking: true,
  title: "Run rm -rf dist",
};

describe("orkestrator attention", () => {
  test("prints one line per item and the cursor to continue from", async () => {
    const page: PublicAttentionPage = {
      items: [APPROVAL],
      more: 0,
      counts: { interactions: 1, runs: 0, setups: 0 },
      cursor: "att1-abc",
    };
    const { box, gateway } = await fixture((request) =>
      request.body.args.action === "attention.list"
        ? envelope(publicSuccessEnvelope("attention.list", page))
        : undefined,
    );
    const run = await box.run(["attention", "--limit", "5"]);
    expect(run.code).toBe(0);
    expect(run.out).toContain("waiting  claude in auth-fix: Run rm -rf dist");
    expect(run.out).toContain("cursor: att1-abc");
    expect(requestsFor(gateway, "attention.list")[0]?.body.args.input).toEqual({ limit: 5 });
    const jsonl = await box.run(["attention", "--jsonl"]);
    expect(jsonl.code).toBe(2);
  });

  test("--follow --jsonl prints each new item once and feeds the cursor back", async () => {
    let reads = 0;
    const { box, gateway } = await fixture((request) => {
      if (request.body.args.action !== "attention.list") return undefined;
      reads += 1;
      const items: PublicAttentionItem[] =
        reads === 1
          ? [APPROVAL]
          : [
              APPROVAL,
              {
                kind: "run",
                at: "2026-10-24T10:01:00.000Z",
                operationId: "op-1",
                action: "session.prompt",
                state: "succeeded",
                sessionId: "ses_abc",
                environmentId: "env-1",
                errorCode: null,
              },
            ];
      return envelope(
        publicSuccessEnvelope("attention.list", {
          items,
          more: 0,
          counts: { interactions: 1, runs: items.length - 1, setups: 0 },
          cursor: `att1-${reads}`,
        }),
      );
    });
    const run = await box.run(["attention", "--follow", "--jsonl", "--timeout", "1s"]);
    expect(run.code).toBe(0);
    const records = run.out
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { type?: string; item?: PublicAttentionItem });
    const items = records.filter((record) => record.type === "attention");
    expect(items.map((record) => record.item?.kind)).toEqual(["interaction", "run"]);
    const cursors = requestsFor(gateway, "attention.list").map(
      (request) => (request.body.args.input as { cursor?: string }).cursor,
    );
    expect(cursors[0]).toBeUndefined();
    expect(cursors[1]).toBe("att1-1");
  });
});

describe("orkestrator ticket and mail", () => {
  test("ticket create sends the action input and a request key", async () => {
    const { box, gateway } = await fixture((request) =>
      request.body.args.action === "ticket.create"
        ? envelope(
            publicSuccessEnvelope(
              "ticket.create",
              { ticketId: "ticket-9", projectId: "project-1", status: "backlog" },
              receipt("ticket.create"),
            ),
          )
        : undefined,
    );
    const run = await box.run([
      "ticket",
      "create",
      "--project",
      "project-1",
      "--title",
      "Fix login",
      "--criteria",
      "Redirects home",
      "--status",
      "backlog",
      "--request-id",
      "ticket-key",
      "--output",
      "id",
    ]);
    expect(run.code).toBe(0);
    expect(run.out.trim()).toBe("ticket-9");
    const sent = requestsFor(gateway, "ticket.create")[0]!.body.args;
    expect(sent.input).toEqual({
      projectId: "project-1",
      title: "Fix login",
      acceptanceCriteria: "Redirects home",
      status: "backlog",
    });
    expect((sent.request as { requestId: string }).requestId).toBe("ticket-key");

    const missing = await box.run(["ticket", "create", "--project", "project-1"]);
    expect(missing.code).toBe(2);
    const badStatus = await box.run(["ticket", "update", "t-1", "--project", "p", "--status", "x"]);
    expect(badStatus.code).toBe(2);
  });

  test("mail send reads the body from a file and never prints it", async () => {
    const { box, gateway } = await fixture((request) =>
      request.body.args.action === "mail.send"
        ? envelope(
            publicSuccessEnvelope(
              "mail.send",
              {
                messageId: "message-1",
                toEnvironmentId: "env-1",
                toTabId: "tab-1",
                placement: "stored",
              },
              receipt("mail.send"),
            ),
          )
        : undefined,
    );
    await writeFile(path.join(box.root, "message.txt"), "Rebase on main, please.");
    const run = await box.run(["mail", "send", "env-1", "tab-1", "--body-file", "message.txt"]);
    expect(run.code).toBe(0);
    expect(run.out).toContain("sent message message-1");
    expect(run.out).not.toContain("Rebase on main");
    expect(requestsFor(gateway, "mail.send")[0]?.body.args.input).toEqual({
      toEnvironmentId: "env-1",
      toTabId: "tab-1",
      body: "Rebase on main, please.",
    });
    const noBody = await box.run(["mail", "send", "env-1", "tab-1"]);
    expect(noBody.code).toBe(2);
  });
});
