import { afterEach, describe, expect, test } from "bun:test";

import {
  CODEX_USER_NAMESPACE_PROBE_TTL_MS,
  codexUserNamespaceRefusal,
  probeCodexUserNamespace,
  resetCodexUserNamespaceProbeForTests,
} from "./codex-user-namespace-probe.js";

afterEach(() => resetCodexUserNamespaceProbeForTests());

describe("probeCodexUserNamespace", () => {
  test("bubblewrap creating its namespace means the sandbox can run", () => {
    const calls: string[] = [];
    expect(
      probeCodexUserNamespace({
        onPath: () => true,
        run: (command) => (calls.push(command), { ok: true, stderr: "" }),
      }),
    ).toBeUndefined();
    expect(calls).toEqual(["bwrap"]);
  });

  test("a refused namespace is reported with the first error line", () => {
    expect(
      probeCodexUserNamespace({
        onPath: (name) => name === "bwrap",
        run: () => ({
          ok: false,
          stderr: "\nbwrap: No permissions to create a new namespace\nmore",
        }),
      }),
    ).toBe("bwrap: No permissions to create a new namespace");
  });

  test("without bwrap on PATH it falls back to unshare", () => {
    const calls: string[] = [];
    expect(
      probeCodexUserNamespace({
        onPath: (name) => name === "unshare",
        run: (command) => (
          calls.push(command),
          { ok: false, stderr: "unshare: Operation not permitted" }
        ),
      }),
    ).toBe("unshare: Operation not permitted");
    expect(calls).toEqual(["unshare"]);
  });

  test("with neither program the answer is unknown, not a refusal", () => {
    expect(
      probeCodexUserNamespace({
        onPath: () => false,
        run: () => {
          throw new Error("must not run");
        },
      }),
    ).toBeUndefined();
  });
});

describe("codexUserNamespaceRefusal", () => {
  test("answers are cached until the TTL passes", () => {
    const first = codexUserNamespaceRefusal(1_000);
    expect(codexUserNamespaceRefusal(1_000 + CODEX_USER_NAMESPACE_PROBE_TTL_MS - 1)).toBe(first);
  });
});
