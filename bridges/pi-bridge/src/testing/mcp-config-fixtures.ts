/**
 * `mcp.json` fixtures shared by the two Pi MCP parity tests:
 *
 * - `src/mcp-config-upstream.test.ts` runs each through the bridge's
 *   `resolvePiMcpServers` and through the pinned Pi package's own
 *   `loadMcpConfig`, so a Pi upgrade that changes the loader fails a test.
 * - `apps/backend/src/core/mcp-management/pi-mcp-parity.test.ts` runs each
 *   through the bridge and through the backend MCP catalogue, so the editor
 *   never shows a server as in use that the bridge does not start, or the
 *   reverse.
 */

/**
 * A fixture file written verbatim, for bytes `JSON.stringify` cannot produce
 * (a byte order mark, a syntax error).
 */
export class RawMcpConfigText {
  constructor(readonly text: string) {}
}

/** The exact text a fixture's `user` or `project` file is written with. */
export function mcpConfigFileText(value: unknown): string {
  return value instanceof RawMcpConfigText ? value.text : JSON.stringify(value);
}

export interface PiMcpConfigFixture {
  name: string;
  /** `<agentDir>/mcp.json`, written with {@link mcpConfigFileText}. */
  user?: unknown;
  /** `<cwd>/.pi/mcp.json`, written with {@link mcpConfigFileText}. */
  project?: unknown;
  /** The bridge's environment, for `$NAME` values. */
  env?: Record<string, string>;
  /** `scope:id` of every server the bridge starts with project resources on, sorted. */
  bridge: string[];
  /** Accepted but non-launching `scope:id` entries and catalogue reason fragments. */
  launchBlocked?: Record<string, string>;
  /** Set where Pi's own loader enables something else: what, sorted, and why the bridge differs. */
  pi?: { enabled: string[]; why: string };
}

function servers(count: number, entry: (index: number) => unknown): Record<string, unknown> {
  return Object.fromEntries(
    Array.from({ length: count }, (_, index) => [
      `s${String(index).padStart(2, "0")}`,
      entry(index),
    ]),
  );
}

export const PI_MCP_CONFIG_FIXTURES: readonly PiMcpConfigFixture[] = [
  {
    name: "IPv6 loopback HTTP auth is retained and blocks a namespace fallback",
    user: {
      mcpServers: {
        "local-auth": { url: "http://[::1]/mcp", auth: { provider: "github" } },
        local_auth: { command: "fallback" },
      },
    },
    bridge: [],
    launchBlocked: { "user:local-auth": "signs in with a Pi provider" },
    pi: {
      enabled: ["user:local-auth"],
      why: "Pi accepts IPv6 loopback auth; the bridge retains the entry but holds no Pi provider token.",
    },
  },
  {
    name: "header and environment maps at the bridge limits are preserved",
    user: {
      mcpServers: {
        web: { url: "https://w.example/mcp", headers: configMap(16) },
        local: { command: "x", env: configMap(32) },
      },
    },
    bridge: ["user:local", "user:web"],
  },
  {
    name: "oversized maps block launch and keep project definitions shadowing",
    user: { mcpServers: { web: { command: "user-web" }, local: { command: "user-local" } } },
    project: {
      mcpServers: {
        web: { url: "https://w.example/mcp", headers: configMap(17) },
        local: { command: "x", env: configMap(33) },
      },
    },
    bridge: [],
    launchBlocked: {
      "project:web": "at most 16 headers",
      "project:local": "at most 32 environment variables",
    },
    pi: {
      enabled: ["project:local", "project:web"],
      why: "Pi's own loader has no map limits; the bridge keeps oversized entries but never drops their maps to launch them.",
    },
  },
  {
    name: "stdio and HTTP servers",
    user: {
      mcpServers: {
        docs: { url: "https://docs.example/mcp" },
        local: { command: "uvx", args: ["server"] },
      },
    },
    bridge: ["user:docs", "user:local"],
  },
  {
    name: "enabled: false turns a server off",
    user: {
      mcpServers: { off: { command: "x", enabled: false }, on: { command: "y", enabled: true } },
    },
    bridge: ["user:on"],
  },
  {
    name: "disabled: true turns a server off for the bridge only",
    user: { mcpServers: { legacy: { command: "x", disabled: true } } },
    bridge: [],
    pi: {
      enabled: ["user:legacy"],
      why: "`disabled` is the Claude and Cursor spelling; Pi's own loader reads only `enabled`.",
    },
  },
  {
    name: "a project server replaces the user server, even a disabled one",
    user: { mcpServers: { db: { command: "user-db" }, api: { command: "user-api" } } },
    project: {
      mcpServers: {
        db: { command: "project-db", enabled: false },
        api: { command: "project-api" },
      },
    },
    bridge: ["project:api"],
  },
  {
    name: "project overrides switch user servers on and off",
    user: {
      mcpServers: {
        off: { command: "a" },
        on: { command: "b", enabled: false },
        exposed: { command: "c" },
      },
    },
    project: {
      mcpServers: {
        off: { enabled: false },
        on: { enabled: true, exposure: "direct" },
        exposed: { toolExposure: { "*": "hidden" } },
      },
    },
    bridge: ["user:exposed", "user:on"],
  },
  {
    name: "an override needs a user server and may set nothing else",
    user: { mcpServers: { kept: { command: "k" } } },
    project: { mcpServers: { orphan: { enabled: true }, kept: { enabled: false, args: ["x"] } } },
    bridge: ["user:kept"],
  },
  {
    name: "an override shape in the user file is invalid",
    user: { mcpServers: { bare: { enabled: false }, kept: { command: "k" } } },
    bridge: ["user:kept"],
  },
  {
    name: "names that differ only in '-' and '_' clash; the first one wins",
    user: {
      mcpServers: {
        "foo-bar": { command: "a" },
        foo_bar: { command: "b" },
        "x-y": { command: "c" },
      },
    },
    project: { mcpServers: { x_y: { command: "d" } } },
    bridge: ["user:foo-bar", "user:x-y"],
  },
  {
    name: "auth is refused in a project file and not started from the user file",
    user: {
      mcpServers: {
        gh: { url: "https://gh.example/mcp", auth: { provider: "github" } },
        shared: { command: "user-shared" },
        local: { command: "l", auth: { provider: "github" } },
      },
    },
    project: {
      mcpServers: { shared: { url: "https://p.example/mcp", auth: { provider: "github" } } },
    },
    bridge: ["user:local", "user:shared"],
    pi: {
      enabled: ["user:gh", "user:local", "user:shared"],
      why: "The bridge holds no Pi provider token, so it does not start a server that signs in with one.",
    },
  },
  {
    name: "an entry Pi rejects hides nothing",
    user: { mcpServers: { web: { url: "https://user.example/mcp" }, tool: { command: "t" } } },
    project: {
      mcpServers: {
        web: { url: "ftp://project.example/mcp" },
        tool: { command: "p", enabled: "no" },
      },
    },
    bridge: ["user:tool", "user:web"],
  },
  {
    name: "Pi's shape checks",
    user: {
      mcpServers: {
        both: { type: "stdio", url: "https://x.example/mcp", command: "local" },
        plainAuth: { url: "http://remote.example/mcp", auth: { provider: "github" } },
        badAuth: { url: "https://a.example/mcp", auth: { provider: "" } },
        badHeaders: { url: "https://h.example/mcp", headers: { A: 1 } },
        badArgs: { command: "x", args: [1] },
        badEnv: { command: "x", env: { A: 1 } },
        badCwd: { command: "x", cwd: 5 },
        emptyUrl: { url: "", command: "x" },
        noUrl: { type: "http", command: "x" },
        sseCommand: { type: "sse", command: "x" },
      },
    },
    bridge: ["user:both"],
  },
  {
    name: "Pi rejects a bad exposure, timeout or description, and skips a bad override",
    user: {
      mcpServers: {
        badExposure: { command: "x", exposure: "loud" },
        badToolExposure: { command: "x", toolExposure: { search: "loud" } },
        badTimeout: { command: "x", timeout: 0 },
        badDescription: { command: "x", description: 5 },
        alias: { command: "x", exposure: "codemode-deferred" },
        kept: { command: "k" },
      },
    },
    project: { mcpServers: { kept: { enabled: false, exposure: "loud" } } },
    bridge: ["user:alias", "user:kept"],
  },
  {
    name: "a bare map is read by the bridge only",
    user: { bare: { command: "x" } },
    bridge: ["user:bare"],
    pi: { enabled: [], why: "Pi's own loader needs the `mcpServers` wrapper." },
  },
  {
    name: "SSE is reached over Streamable HTTP by the bridge only",
    user: { mcpServers: { legacy: { type: "sse", url: "https://s.example/sse" } } },
    bridge: ["user:legacy"],
    pi: {
      enabled: [],
      why: "Pi rejects the legacy SSE transport; the bridge keeps working configurations running.",
    },
  },
  {
    name: "the bridge rewrites names Pi rejects and refuses a leading digit",
    user: { mcpServers: { "my server": { command: "x" }, "9lives": { command: "y" } } },
    bridge: ["user:my_server"],
    pi: {
      enabled: ["user:9lives"],
      why: "The bridge's names must start with a letter, and it rewrites other characters to `_`.",
    },
  },
  {
    name: "the bridge also reads a transport key",
    user: {
      mcpServers: {
        spelled: { transport: "http", url: "https://t.example/mcp" },
        unknown: { transport: "websocket", url: "https://u.example/mcp" },
      },
    },
    bridge: ["user:spelled"],
    pi: {
      enabled: ["user:spelled", "user:unknown"],
      why: "Pi ignores a `transport` key; the bridge reads it as the type.",
    },
  },
  {
    name: "values the bridge never resolves stop a server that still shadows",
    env: { TOKEN: "t" },
    user: {
      mcpServers: {
        ok: { url: "https://a.example/mcp", headers: { Authorization: "Bearer ${TOKEN}" } },
        shell: { url: "https://b.example/mcp", headers: { Authorization: "!gh auth token" } },
        secret: { command: "x", env: { K: "$PI_BRIDGE_TOKEN" } },
        blank: { command: "  " },
        web: { url: "https://user.example/mcp" },
      },
    },
    project: {
      mcpServers: { web: { url: "https://p.example/mcp", headers: { A: "!cat key" } } },
    },
    bridge: ["user:ok"],
    pi: {
      enabled: ["project:web", "user:blank", "user:ok", "user:secret", "user:shell"],
      why: "Pi resolves values when it connects and runs `!command` values; the bridge runs no commands, never passes its own secrets and cannot start a blank command.",
    },
  },
  {
    name: "the bridge reads 64 entries per file, disabled ones included",
    user: {
      mcpServers: {
        ...servers(64, () => ({ command: "x", enabled: false })),
        late: { command: "x" },
      },
    },
    bridge: [],
    pi: { enabled: ["user:late"], why: "Pi reads every entry; the bridge bounds each file." },
  },
  {
    // Pi strips one leading BOM (since 1.4.0); the file after it must parse.
    name: "one leading UTF-8 BOM is ignored and a second one fails the file",
    user: new RawMcpConfigText(
      `\uFEFF${JSON.stringify({ mcpServers: { bom: { command: "x" } } })}`,
    ),
    project: new RawMcpConfigText(
      `\uFEFF\uFEFF${JSON.stringify({ mcpServers: { twice: { command: "y" } } })}`,
    ),
    bridge: ["user:bom"],
  },
  {
    name: "64 servers fill a file",
    user: { mcpServers: servers(64, () => ({ command: "x" })) },
    bridge: Object.keys(servers(64, () => null)).map((name) => `user:${name}`),
  },
];

function configMap(count: number): Record<string, string> {
  return Object.fromEntries(Array.from({ length: count }, (_, index) => [`K${index}`, "value"]));
}
