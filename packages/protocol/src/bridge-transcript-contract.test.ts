/**
 * The shared v2 transcript contract, run against a minimal reference bridge
 * built only from the route helpers, plus the defects it exists to catch.
 */
import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import {
  bridgeTranscriptContract,
  type BridgeTranscriptContractAdapter,
  type ContractMessage,
} from "./bridge-transcript-contract.js";
import {
  bridgeTranscriptRouteBody,
  bridgeTranscriptSubReadBody,
  isBridgeTranscriptSubRead,
  type BridgeTranscriptSource,
} from "./bridge-transcript-routes.js";

interface ReferenceSession {
  id: string;
  messages: ContractMessage[];
  epoch: number;
  revision: number;
}

interface ReferenceOptions {
  /** A restart that keeps the previous process's generation: the defect to catch. */
  reuseGenerationOnRestart?: boolean;
  /** A rewrite that forgets to start a new epoch. */
  keepEpochOnRewrite?: boolean;
}

/** The smallest bridge: one generation per "process", sessions in a map. */
function referenceBridge(
  options: ReferenceOptions = {},
): BridgeTranscriptContractAdapter<ReferenceSession> & { sessions: Map<string, ReferenceSession> } {
  const sessions = new Map<string, ReferenceSession>();
  const reader = (generation: string) => async (path: string) => {
    const url = new URL(path, "http://bridge");
    const match = /^\/session\/([^/]+)\/transcript(?:\/([^/]+))?$/.exec(url.pathname);
    if (!match) throw new Error(`no route for ${path}`);
    const session = sessions.get(decodeURIComponent(match[1]!));
    const source: BridgeTranscriptSource<ContractMessage> | undefined = session && {
      messages: session.messages,
      sessionIdentity: session.id,
      generation,
      contentEpoch: session.epoch,
      revision: session.revision,
      complete: true,
    };
    const query = (name: string) => url.searchParams.get(name);
    const sub = match[2];
    if (sub === undefined) {
      if (!source) throw new Error("the summary route answers 404 for an unknown session");
      return JSON.parse(JSON.stringify(bridgeTranscriptRouteBody(source, query)));
    }
    if (!isBridgeTranscriptSubRead(sub)) throw new Error(`no route for ${path}`);
    return JSON.parse(JSON.stringify(bridgeTranscriptSubReadBody(source, sub, query)));
  };
  let generation = randomUUID();
  return {
    sessions,
    read: reader(generation),
    async seed(messages) {
      const session = {
        id: randomUUID(),
        messages: structuredClone(messages),
        epoch: 0,
        revision: 1,
      };
      sessions.set(session.id, session);
      return session;
    },
    append(session, message) {
      session.messages.push(structuredClone(message));
      session.revision += 1;
    },
    setToolOutput(session, messageId, output) {
      const part = session.messages.find((message) => message.id === messageId)!.parts[0]!;
      if (part.type === "tool-invocation") part.toolOutput = output;
      session.revision += 1;
    },
    rewrite(session) {
      session.messages.splice(200);
      if (!options.keepEpochOnRewrite) session.epoch += 1;
      session.revision += 1;
    },
    async restart(session) {
      // Persisted state survives; the in-process counters restart with it.
      if (!options.reuseGenerationOnRestart) generation = randomUUID();
      return { read: reader(generation), session };
    },
  };
}

describe("the shared bridge transcript contract", () => {
  for (const scenario of bridgeTranscriptContract) {
    test(`reference bridge: ${scenario.name}`, async () => {
      await scenario.run(referenceBridge());
    });
  }

  const scenario = (prefix: string) =>
    bridgeTranscriptContract.find((candidate) => candidate.name.startsWith(prefix))!;

  test("fails a bridge whose restart keeps the previous generation", async () => {
    await expect(
      scenario("a restarted bridge").run(referenceBridge({ reuseGenerationOnRestart: true })),
    ).rejects.toThrow("never answers unchanged");
  });

  test("fails a bridge whose rewrite keeps the content epoch", async () => {
    await expect(
      scenario("a rewrite").run(referenceBridge({ keepEpochOnRewrite: true })),
    ).rejects.toThrow("new content epoch");
  });
});
