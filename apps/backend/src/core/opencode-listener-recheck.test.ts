import { describe, expect, test } from "bun:test";
import { ProviderUnavailableError } from "./agent-provider-contract.js";
import type { OpenCodeListenerJudgement } from "./opencode-listener-identity.js";
import {
  OPENCODE_LISTENER_RECHECK_INTERVAL_MS,
  OPENCODE_LISTENER_REPLACED_MESSAGE,
  openCodeListenerRecheckFetch,
  unexpectedOpenCodeResponse,
} from "./opencode-listener-recheck.js";

function harness(
  answers: Array<Response | Error>,
  judgements: Array<OpenCodeListenerJudgement | undefined | Error>,
) {
  let clock = 0;
  const sent: string[] = [];
  let checks = 0;
  const inner = (async (input: RequestInfo | URL) => {
    sent.push(String(input));
    const answer = answers.shift() ?? new Response("{}");
    if (answer instanceof Error) throw answer;
    return answer;
  }) as typeof fetch;
  const wrapped = openCodeListenerRecheckFetch(
    inner,
    async () => {
      checks++;
      const judgement = judgements.shift();
      if (judgement instanceof Error) throw judgement;
      return judgement;
    },
    "opencode",
    () => clock,
  );
  return {
    wrapped,
    sent,
    checks: () => checks,
    advance: (ms: number) => {
      clock += ms;
    },
  };
}

test("only an answer the password does not open is unexpected", () => {
  expect(unexpectedOpenCodeResponse(new Response(null, { status: 401 }))).toBe(true);
  expect(unexpectedOpenCodeResponse(new Response(null, { status: 403 }))).toBe(true);
  for (const status of [200, 204, 400, 404, 409, 500, 503]) {
    expect(unexpectedOpenCodeResponse(new Response(null, { status }))).toBe(false);
  }
});

describe("openCodeListenerRecheckFetch", () => {
  test("ordinary answers never ask root", async () => {
    const h = harness([new Response("{}"), new Response("no", { status: 404 })], []);
    expect((await h.wrapped.fetch("http://x/a")).status).toBe(200);
    expect((await h.wrapped.fetch("http://x/b")).status).toBe(404);
    expect(h.checks()).toBe(0);
  });

  test("a 401 from a replaced listener stops every later request before it is sent", async () => {
    const h = harness([new Response("no", { status: 401 })], ["replaced", "replaced"]);
    await expect(h.wrapped.fetch("http://x/a")).rejects.toThrow(OPENCODE_LISTENER_REPLACED_MESSAGE);
    expect(h.wrapped.replaced).toBe(true);
    const later = h.wrapped.fetch("http://x/b");
    await expect(later).rejects.toBeInstanceOf(ProviderUnavailableError);
    // Within the interval nothing is asked or sent.
    expect(h.sent).toEqual(["http://x/a"]);
    expect(h.checks()).toBe(1);
  });

  test("a refused connection re-checks; a server that is still ours keeps working", async () => {
    const refused = Object.assign(new TypeError("fetch failed"), { code: "ECONNREFUSED" });
    const h = harness([refused, new Response("{}")], ["ours"]);
    await expect(h.wrapped.fetch("http://x/a")).rejects.toThrow("fetch failed");
    expect(h.wrapped.replaced).toBe(false);
    expect((await h.wrapped.fetch("http://x/b")).status).toBe(200);
    expect(h.checks()).toBe(1);
  });

  test("an abort is the caller's, not the listener's", async () => {
    const abort = new DOMException("aborted", "AbortError");
    const h = harness([abort], []);
    await expect(h.wrapped.fetch("http://x/a")).rejects.toBe(abort);
    expect(h.checks()).toBe(0);
  });

  test("a check that cannot run changes nothing", async () => {
    const h = harness(
      [new Response("no", { status: 401 }), new Response("no", { status: 401 })],
      [undefined, new Error("docker exec failed")],
    );
    expect((await h.wrapped.fetch("http://x/a")).status).toBe(401);
    expect((await h.wrapped.fetch("http://x/b")).status).toBe(401);
    expect(h.wrapped.replaced).toBe(false);
  });

  test("failures in flight share one check", async () => {
    let release: (value: OpenCodeListenerJudgement) => void = () => undefined;
    let checks = 0;
    const wrapped = openCodeListenerRecheckFetch(
      (async () => new Response("no", { status: 401 })) as unknown as typeof fetch,
      () => {
        checks++;
        return new Promise((resolve) => {
          release = resolve;
        });
      },
      "opencode2",
    );
    const settled = Promise.allSettled([wrapped.fetch("http://x/a"), wrapped.fetch("http://x/b")]);
    await Bun.sleep(5);
    release("replaced");
    for (const result of await settled) {
      expect(result.status).toBe("rejected");
      expect(String((result as PromiseRejectedResult).reason)).toContain(
        OPENCODE_LISTENER_REPLACED_MESSAGE,
      );
    }
    expect(checks).toBe(1);
  });

  test("once a fresh start recorded its own socket, requests flow again", async () => {
    const h = harness(
      [new Response("no", { status: 401 }), new Response("{}")],
      ["replaced", "ours"],
    );
    await expect(h.wrapped.fetch("http://x/a")).rejects.toThrow(OPENCODE_LISTENER_REPLACED_MESSAGE);
    h.advance(OPENCODE_LISTENER_RECHECK_INTERVAL_MS);
    expect((await h.wrapped.fetch("http://x/b")).status).toBe(200);
    expect(h.wrapped.replaced).toBe(false);
    expect(h.sent).toEqual(["http://x/a", "http://x/b"]);
  });
});
