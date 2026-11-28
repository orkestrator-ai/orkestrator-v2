import { createHash } from "node:crypto";
import type { Request } from "@playwright/test";
import {
  NATIVE_AGENT_DISCOVERY_SECTIONS,
  type NativeAgentDiscoveryUpdate,
  type NativeAgentDiscoveryView,
} from "@orkestrator/protocol/native-agent";

type DiscoveryArgs = { logicalSessionKey?: string; knownToken?: unknown; forceSnapshot?: unknown };
type SessionRequest = {
  at: number;
  command: string;
  wireBytes: number;
  discovery?: ReturnType<typeof discoveryShape>;
};
type RequestObservation = {
  at: number;
  collection: Promise<SessionRequest>;
  record?: SessionRequest;
};
type FinishedRequest = Pick<Request, "url" | "postDataJSON" | "sizes"> & {
  response(): Promise<{ text(): Promise<string> } | null>;
};
type SessionPage = {
  on(event: "requestfinished", listener: (request: FinishedRequest) => void): unknown;
};

const shortHash = (value: unknown) =>
  createHash("sha256")
    .update(JSON.stringify(value) ?? "")
    .digest("hex")
    .slice(0, 10);

/** Describe what contributed to the bytes without retaining provider content. */
function discoveryShape(text: string, sent: DiscoveryArgs) {
  const metadata = {
    sentToken: typeof sent.knownToken === "string" ? shortHash(sent.knownToken) : null,
    forceSnapshot: sent.forceSnapshot === true,
    responseBytes: Buffer.byteLength(text),
  };
  let envelope: { result?: NativeAgentDiscoveryUpdate; error?: unknown } | null;
  try {
    envelope = JSON.parse(text) as typeof envelope;
  } catch {
    return { ...metadata, status: "unreadable", token: null };
  }
  if (envelope?.error != null) return { ...metadata, status: "gateway-error", token: null };

  const result = envelope?.result;
  switch (result?.status) {
    case "snapshot":
      return {
        ...metadata,
        status: result.status,
        resetReason: result.resetReason,
        token: typeof result.token === "string" ? shortHash(result.token) : null,
        sections: discoverySections(result.value?.sections),
      };
    case "unchanged":
      return {
        ...metadata,
        status: result.status,
        token: typeof result.token === "string" ? shortHash(result.token) : null,
      };
    case "missing":
    case "unavailable":
      return { ...metadata, status: result.status, token: null };
    default:
      return { ...metadata, status: "unreadable", token: null };
  }
}

function discoverySections(sections: NativeAgentDiscoveryView["sections"] | undefined) {
  if (!sections) return undefined;
  return Object.fromEntries(
    NATIVE_AGENT_DISCOVERY_SECTIONS.flatMap((name) => {
      const section = sections[name];
      if (!section) return [];
      const value = section.value;
      const summary = name === "runtime" ? sections.runtime?.value?.summary : undefined;
      const unknownEvents = summary?.drift?.unknownEvents;
      return [
        [
          name,
          {
            availability: section.availability,
            revision: section.revision,
            bytes: Buffer.byteLength(JSON.stringify(section)),
            valueHash: shortHash(value),
            ...(Array.isArray(value) ? { entries: value.length } : {}),
            ...("catalogue" in section && section.catalogue
              ? { catalogueHash: shortHash(section.catalogue) }
              : {}),
            ...(section.error ? { error: true } : {}),
            ...(summary
              ? {
                  summary: Object.fromEntries(
                    Object.entries(summary).map(([key, inner]) => [key, shortHash(inner)]),
                  ),
                }
              : {}),
            ...(typeof unknownEvents === "number" ? { unknownEvents } : {}),
          },
        ],
      ];
    }),
  );
}

async function collect(request: FinishedRequest, at: number, command: string, args: DiscoveryArgs) {
  const sizes = await request.sizes();
  const wireBytes =
    sizes.requestHeadersSize +
    sizes.requestBodySize +
    sizes.responseHeadersSize +
    sizes.responseBodySize;
  if (command !== "get_native_agent_discovery_update") return { at, command, wireBytes };

  const response = await request.response().catch(() => null);
  const text = response ? await response.text().catch(() => "") : "";
  return { at, command, wireBytes, discovery: discoveryShape(text, args) };
}

/** Register before opening the tab so an immediate mount answer is captured. */
export async function openRecordedSession(
  page: SessionPage,
  logicalSessionKey: string,
  open: () => Promise<void>,
  now = Date.now,
) {
  const requests: RequestObservation[] = [];
  page.on("requestfinished", (request) => {
    const at = now();
    if (!request.url().endsWith("/__orkestrator/invoke")) return;
    let body: { command?: unknown; args?: DiscoveryArgs } | null;
    try {
      body = request.postDataJSON() as typeof body;
    } catch {
      return;
    }
    if (typeof body?.command !== "string" || body.args?.logicalSessionKey !== logicalSessionKey)
      return;
    const observation: RequestObservation = {
      at,
      collection: collect(request, at, body.command, body.args),
    };
    void observation.collection.then(
      (record) => {
        observation.record = record;
      },
      // The window surfaces eligible collection failures when it drains.
      () => undefined,
    );
    requests.push(observation);
  });
  await open();

  return {
    completedSince(from: number) {
      return requests.flatMap(({ at, record }) => (at >= from && record ? [record] : []));
    },
    async measure(from: number, to: number) {
      // Choose by the event timestamp before awaiting collection to keep membership and order fixed.
      const records = await Promise.all(
        requests.filter((entry) => entry.at < to).map((entry) => entry.collection),
      );
      return {
        summary: summarize(records, from, to),
        timeline: records.flatMap(({ at, discovery, wireBytes }) =>
          discovery ? [{ atMs: at - from, inWindow: at >= from, wireBytes, ...discovery }] : [],
        ),
      };
    },
  };
}

/** The one-viewer case can stop after measurement to save a billed turn. */
export async function runOptionalReconnect(reconnect: () => Promise<void>): Promise<void> {
  if (process.env.ORKESTRATOR_AGENT_TEST_TAB_REQUESTS_SKIP_RECONNECT === "1") return;
  await reconnect();
}

function summarize(requests: SessionRequest[], from: number, to: number) {
  const slice = requests.filter((request) => request.at >= from && request.at < to);
  const byCommand: Record<string, number> = {};
  for (const request of slice) byCommand[request.command] = (byCommand[request.command] ?? 0) + 1;
  // A round has exactly one read of the session's turn state, alone or combined.
  const rounds = Math.max(
    0,
    ...Object.entries(byCommand)
      .filter(([command]) => !command.includes("discovery"))
      .map(([, count]) => count),
  );
  return {
    seconds: Math.round((to - from) / 1_000),
    requests: slice.length,
    rounds,
    requestsPerRound: rounds > 0 ? Number((slice.length / rounds).toFixed(2)) : null,
    requestsPerSecond: Number((slice.length / ((to - from) / 1_000)).toFixed(2)),
    wireBytes: slice.reduce((total, request) => total + request.wireBytes, 0),
    byCommand,
  };
}
