/**
 * How a prompt route's failure answers map to provider errors.
 *
 * A 500 or 502 does not prove the turn never started — a handler can fail after
 * its provider call, and Cursor's `dispatch-outcome-unknown` says so explicitly
 * — so both park as ambiguous with the retry-under-the-same-id and discard
 * controls. Statuses that mean "not processed" (503, including a failed
 * mandatory publication before any provider call) stay retryable.
 */
import { describe, expect, test } from "bun:test";
import {
  AmbiguousPromptDispatchError,
  ProviderUnavailableError,
} from "./agent-provider-contract.js";
import { cursorConnection, httpProvider } from "./agent-provider-test-support.js";

async function sendFailure(response: () => Response): Promise<unknown> {
  const { provider, requests } = httpProvider(() => response(), cursorConnection);
  const error = await provider
    .send("session-1", "synthetic prompt", { requestId: "request-1" })
    .then(() => undefined)
    .catch((caught: unknown) => caught);
  expect(requests).toHaveLength(1);
  expect(requests[0]!.url.endsWith("/session/session-1/prompt")).toBe(true);
  return error;
}

describe("Cursor prompt failure mapping", () => {
  test("502 dispatch-outcome-unknown parks as an ambiguous dispatch", async () => {
    const error = await sendFailure(() =>
      Response.json(
        {
          error: "Cursor could not confirm whether the prompt started",
          kind: "dispatch-outcome-unknown",
        },
        { status: 502 },
      ),
    );
    expect(error).toBeInstanceOf(AmbiguousPromptDispatchError);
  });

  test("503 persistence-unavailable is a retryable refusal, not an ambiguous dispatch", async () => {
    const error = await sendFailure(() =>
      Response.json(
        {
          error: "Cursor bridge could not save its session state",
          kind: "persistence-unavailable",
          code: "persistence-failed",
        },
        { status: 503 },
      ),
    );
    expect(error).toBeInstanceOf(ProviderUnavailableError);
    expect(error).not.toBeInstanceOf(AmbiguousPromptDispatchError);
  });

  test.each([
    ["a bare 502", () => new Response("Bad Gateway", { status: 502 })],
    ["a 502 with another kind", () => Response.json({ kind: "other" }, { status: 502 })],
    ["a generic 500", () => Response.json({ error: "Internal bridge error" }, { status: 500 })],
  ])("%s proves nothing and parks as ambiguous", async (_name, response) => {
    const error = await sendFailure(response);
    expect(error).toBeInstanceOf(AmbiguousPromptDispatchError);
  });

  test("a generic 503 (not processed) stays retryable", async () => {
    const error = await sendFailure(() =>
      Response.json({ error: "Bridge is shutting down" }, { status: 503 }),
    );
    expect(error).toBeInstanceOf(ProviderUnavailableError);
    expect(error).not.toBeInstanceOf(AmbiguousPromptDispatchError);
  });
});
