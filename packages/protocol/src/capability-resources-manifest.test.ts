import { describe, expect, test } from "bun:test";

import {
  findCapabilitySecrets,
  isPortableCapabilitySelector,
  looksLikeHostPath,
  validateCapabilityIntent,
  validateCapabilityLockfile,
} from "./capability-resources-manifest.js";

const source = {
  kind: "git",
  repo: "https://github.com/example/agent-tools",
  subpath: "skills/frontend",
};
const digest = `sha256:${"a".repeat(64)}`;

describe("intent", () => {
  test("a valid intent parses", () => {
    const { intent, issues } = validateCapabilityIntent({
      version: 1,
      setups: {
        frontend: {
          packages: [{ source, revision: "1a2b3c4d", required: true }],
          providers: ["claude", "pi"],
          machines: ["development"],
          updatePolicy: "approve",
        },
      },
    });
    expect(issues).toEqual([]);
    expect(intent?.setups.frontend?.packages[0]?.required).toBe(true);
  });

  test("credentials, host paths and local installations are refused", () => {
    const { issues } = validateCapabilityIntent({
      version: 1,
      setups: {
        bad: {
          description: "token ghp_abcdefghijklmnopqrstuvwxyz0123456789",
          packages: [
            { source: { kind: "local", sourceMachineId: "bk_1", sourceId: "x/y" } },
            { source: { kind: "git", repo: "/home/me/repo", subpath: "" } },
          ],
          token: "x",
        },
      },
    });
    const messages = issues.map((issue) => issue.message).join("\n");
    expect(messages).toContain("GitHub token");
    expect(messages).toContain("local installation");
    expect(messages).toContain('"token" field');
  });

  test("bad names and versions are reported, not thrown", () => {
    const { issues } = validateCapabilityIntent({
      version: 2,
      setups: { "Bad Name": { packages: [] } },
    });
    expect(issues.length).toBe(2);
    expect(validateCapabilityIntent("nope").intent).toBeNull();
  });
});

describe("lockfile", () => {
  test("ids must match their source and every intent package must be locked", () => {
    const intent = validateCapabilityIntent({
      version: 1,
      setups: { frontend: { packages: [{ source }] } },
    }).intent;
    const { issues } = validateCapabilityLockfile(
      {
        formatVersion: 1,
        packages: [{ id: "wrong", source, artifactDigest: digest, components: [] }],
        setups: {},
      },
      intent,
    );
    const text = issues.map((issue) => issue.message).join("\n");
    expect(text).toContain("does not match the source");
    expect(text).toContain("Missing from the lockfile");
    const ok = validateCapabilityLockfile(
      {
        formatVersion: 1,
        packages: [
          {
            id: "git:github.com/example/agent-tools//skills/frontend",
            source,
            artifactDigest: digest,
            revision: "abc",
            components: [],
          },
        ],
        setups: {
          frontend: { packageIds: ["git:github.com/example/agent-tools//skills/frontend"] },
        },
      },
      intent,
    );
    expect(ok.issues).toEqual([]);
  });
});

describe("helpers", () => {
  test("secrets are named by kind only", () => {
    expect(findCapabilitySecrets("key sk-ant-abcdefghijklmnopqrstuvwxyz")).toEqual([
      "Anthropic key",
    ]);
    expect(findCapabilitySecrets("-----BEGIN OPENSSH PRIVATE KEY-----")).toEqual(["private key"]);
    expect(findCapabilitySecrets("Use the review checklist.")).toEqual([]);
  });

  test("host paths and private selectors", () => {
    expect(looksLikeHostPath("/Users/me")).toBe(true);
    expect(looksLikeHostPath("~/x")).toBe(true);
    expect(looksLikeHostPath("C:\\x")).toBe(true);
    expect(looksLikeHostPath("skills/x")).toBe(false);
    expect(isPortableCapabilitySelector("group:development")).toBe(true);
    expect(isPortableCapabilitySelector("machine:bk_1")).toBe(false);
  });
});
