import { describe, expect, test } from "bun:test";

import { summarizeRequests, type ProbeRequest } from "../scripts/static-revalidation-probe.js";

function request(
  ifNoneMatch: boolean,
  ifModifiedSince: boolean,
  overrides: Partial<ProbeRequest> = {},
): ProbeRequest {
  return {
    step: "reload",
    path: "/app.js",
    status: ifNoneMatch || ifModifiedSince ? 304 : 200,
    ifNoneMatch,
    ifModifiedSince,
    contentEncoding: "br",
    ...overrides,
  };
}

// The figures this helper produces are the evidence for to-do 6160 (retired;
// docs/architecture/remote-gateway.md), so each kind of request is pinned on
// its own before a mixed run.
describe("summarizeRequests", () => {
  test("an empty run has no revalidations", () => {
    expect(summarizeRequests([])).toEqual({ revalidations: 0, dateOnlyRevalidations: 0 });
  });

  test("a request with no validator is not a revalidation", () => {
    expect(summarizeRequests([request(false, false)])).toEqual({
      revalidations: 0,
      dateOnlyRevalidations: 0,
    });
  });

  test("a request with both validators revalidates by tag, not by date alone", () => {
    expect(summarizeRequests([request(true, true)])).toEqual({
      revalidations: 1,
      dateOnlyRevalidations: 0,
    });
  });

  test("a request with only a tag revalidates, but not by date alone", () => {
    expect(summarizeRequests([request(true, false)])).toEqual({
      revalidations: 1,
      dateOnlyRevalidations: 0,
    });
  });

  test("a request with only a date is a date-only revalidation", () => {
    expect(summarizeRequests([request(false, true)])).toEqual({
      revalidations: 1,
      dateOnlyRevalidations: 1,
    });
  });

  test("the outcome depends only on the validators, not on status, path or coding", () => {
    const dateOnly = request(false, true, {
      step: "fetch-no-cache",
      path: "/style.css",
      status: 200,
      contentEncoding: "identity",
    });
    expect(summarizeRequests([dateOnly])).toEqual({
      revalidations: 1,
      dateOnlyRevalidations: 1,
    });
  });

  test("a mixed run counts each kind once", () => {
    const run = [
      request(false, false, { step: "first-load", path: "/" }),
      request(false, false, { step: "first-load" }),
      request(false, false, { step: "first-load", path: "/style.css" }),
      request(true, true, { path: "/" }),
      request(true, true),
      request(true, false, { path: "/style.css" }),
      request(false, true, { step: "fetch-no-cache" }),
      request(false, true, { step: "navigate-again", path: "/style.css" }),
    ];
    expect(summarizeRequests(run)).toEqual({ revalidations: 5, dateOnlyRevalidations: 2 });
  });
});
