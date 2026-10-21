import { expect, test } from "bun:test";
import {
  repositoryHint,
  toNodeProjectSummary,
  toNodeEnvironmentSummary,
} from "./node-summaries.js";
import { classifyRouteFailure } from "./node/node-link/routes.js";

test("repository identities retain namespaces and ports and normalize HTTPS/SCP remotes", () => {
  const first = "https://gitlab.example/team-a/shared/app.git";
  const second = "https://gitlab.example/team-b/shared/app.git";
  expect(repositoryHint(first)).toBe("gitlab.example/team-a/shared/app");
  expect(repositoryHint(first)).toBe(repositoryHint("git@gitlab.example:team-a/shared/app.git"));
  expect(repositoryHint(first)).not.toBe(repositoryHint(second));
  expect(repositoryHint("ssh://git@gitlab.example:2222/team-a/shared/app.git")).not.toBe(
    repositoryHint(first),
  );
  expect(
    toNodeProjectSummary("bk_test" as never, { id: "p", gitUrl: first }, 0)?.repositoryHint,
  ).toBe(repositoryHint(first));
});

test("raw and wrapped TLS verification failures quarantine without fallback", () => {
  for (const code of [
    "CERT_HAS_EXPIRED",
    "DEPTH_ZERO_SELF_SIGNED_CERT",
    "ERR_TLS_CERT_ALTNAME_INVALID",
    "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  ]) {
    const raw = Object.assign(new Error("fetch failed"), { code });
    for (const error of [
      raw,
      new TypeError("fetch failed", { cause: raw }),
      Object.assign(new Error("unreachable"), { code: "unreachable", retryable: true, cause: raw }),
    ]) {
      expect(classifyRouteFailure(error)).toMatchObject({
        quarantine: true,
        retryable: false,
        state: "trust-blocked",
      });
    }
  }
});

test("environment summaries use finite owner order or the storage index fallback", () => {
  const raw = { id: "e", projectId: "p" };
  expect(toNodeEnvironmentSummary("bk_test" as never, { ...raw, order: -3 }, 8)?.order).toBe(-3);
  for (const order of [undefined, null, "2", NaN, Infinity, -Infinity]) {
    expect(toNodeEnvironmentSummary("bk_test" as never, { ...raw, order }, 8)?.order).toBe(8);
    expect(toNodeProjectSummary("bk_test" as never, { ...raw, order }, 8)?.order).toBe(8);
  }
  expect(toNodeEnvironmentSummary("bk_test" as never, raw)?.order).toBe(0);
});
