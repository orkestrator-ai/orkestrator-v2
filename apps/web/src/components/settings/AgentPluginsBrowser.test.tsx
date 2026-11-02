import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { AgentExtensionItem, AgentSkill } from "@/lib/backend";

/** Per-command payloads, as in SkillsSettings.test.tsx; afterAll restores the setup.ts shape. */
const invokeCalls: Array<{ command: string; args?: Record<string, unknown> }> = [];
let pluginResponse: (provider: string) => Promise<unknown> = async (agent) => ({
  agent,
  plugins: [],
});
let skills: AgentSkill[] = [];
let scanResponse: (() => Promise<unknown>) | undefined;

mock.module("@/lib/native/backend", () => ({
  invoke: mock((command: string, args?: Record<string, unknown>) => {
    invokeCalls.push({ command, args });
    if (command === "list_agent_plugins") return pluginResponse(String(args?.provider));
    if (command === "list_agent_skills") {
      return (
        scanResponse?.() ??
        Promise.resolve({ provider: args?.provider, roots: [], skills, errors: [] })
      );
    }
    if (command === "read_agent_skill") {
      return Promise.resolve({ path: args?.filePath, content: "# Body", truncated: false });
    }
    return Promise.resolve();
  }),
}));

afterAll(() => {
  mock.module("@/lib/native/backend", () => ({ invoke: mock(() => Promise.resolve()) }));
});

const { useAgentPlugins } = await import("./AgentPluginsBrowser");
const { SkillsSettings } = await import("./SkillsSettings");

const VERCEL: AgentExtensionItem = { name: "vercel", status: "configured", source: "user" };
const STRIPE: AgentExtensionItem = { name: "stripe", status: "disabled", source: "project" };

function pluginSkill(name: string): AgentSkill {
  return {
    id: name,
    name: `vercel:${name}`,
    description: `About ${name}`,
    filePath: `/plugins/vercel/skills/${name}/SKILL.md`,
    location: `~/.claude/plugins/vercel/skills/${name}`,
    scope: "plugin",
    plugin: "vercel",
    shadowed: false,
  };
}

/** Radix activates a tab from mousedown/focus, not from a bare click. */
function clickTab(name: string | RegExp) {
  const trigger = screen.getByRole("tab", { name });
  fireEvent.mouseDown(trigger);
  fireEvent.focus(trigger);
}

function pluginReads() {
  return invokeCalls.filter((call) => call.command === "list_agent_plugins");
}

function pluginListText() {
  return screen.queryByRole("list", { name: "Plugins" })?.textContent ?? "";
}

beforeEach(() => {
  invokeCalls.length = 0;
  skills = [];
  scanResponse = undefined;
  pluginResponse = async (agent) => ({ agent, plugins: [VERCEL, STRIPE] });
});

afterEach(cleanup);

describe("the plugins view", () => {
  test("starts no agent CLI until it is opened, then keeps the result", async () => {
    render(<SkillsSettings />);
    await waitFor(() => expect(screen.getByRole("tab", { name: /^Skills/ })).toBeTruthy());
    expect(pluginReads()).toHaveLength(0);

    clickTab(/^Plugins/);
    await waitFor(() => expect(pluginListText()).toContain("vercel"));
    expect(pluginListText()).toContain("stripe");
    expect(pluginReads()).toEqual([
      { command: "list_agent_plugins", args: { provider: "claude" } },
    ]);
    expect(screen.getByRole("tab", { name: /^Plugins/ }).textContent).toBe("Plugins2");

    clickTab(/^Skills/);
    clickTab(/^Plugins/);
    await waitFor(() => expect(pluginListText()).toContain("vercel"));
    expect(pluginReads()).toHaveLength(1);

    fireEvent.click(screen.getByRole("button", { name: "Reload plugins" }));
    await waitFor(() => expect(pluginReads()).toHaveLength(2));
  });

  test("reads each agent's plugins under that agent's tab", async () => {
    pluginResponse = async (agent) => ({
      agent,
      plugins: [{ name: `${agent}-plugin`, status: "configured" }],
    });
    render(<SkillsSettings />);

    clickTab(/^Plugins/);
    await waitFor(() => expect(pluginListText()).toContain("claude-plugin"));

    clickTab("Codex");
    await waitFor(() => expect(pluginListText()).toContain("codex-plugin"));
    expect(pluginListText()).not.toContain("claude-plugin");
  });

  test("an environment's pane has no plugins view, because its dialog lists them", async () => {
    render(<SkillsSettings embedded />);
    await waitFor(() => expect(screen.getByRole("tab", { name: "Claude" })).toBeTruthy());

    expect(screen.queryByRole("tab", { name: /^Plugins/ }) === null).toBe(true);
    expect(pluginReads()).toHaveLength(0);
  });

  test("an agent with no list says so instead of claiming it has no plugins", async () => {
    pluginResponse = async (agent) => ({
      agent,
      plugins: [],
      pluginError: "Cursor's SDK bridge does not expose a plugin list.",
    });
    render(<SkillsSettings />);

    clickTab(/^Plugins/);
    await waitFor(() =>
      expect(screen.getByText("Cursor's SDK bridge does not expose a plugin list.")).toBeTruthy(),
    );
    expect(screen.queryByText("This agent reports no plugins on this machine.") === null).toBe(
      true,
    );
    expect(screen.getByText("Not available")).toBeTruthy();
    // An unknown count is not zero, and there is nothing to select.
    expect(screen.getByRole("tab", { name: /^Plugins/ }).textContent).toBe("Plugins");
    expect(screen.queryByText("Select a plugin to see its details.") === null).toBe(true);
  });

  test("a successful empty list is reported as empty", async () => {
    pluginResponse = async (agent) => ({ agent, plugins: [] });
    render(<SkillsSettings />);

    clickTab(/^Plugins/);
    await waitFor(() =>
      expect(screen.getByText("This agent reports no plugins on this machine.")).toBeTruthy(),
    );
    expect(screen.getByText("0 plugins")).toBeTruthy();
  });

  for (const [label, response, message] of [
    [
      "a resolved failure",
      () => Promise.resolve({ plugins: [], pluginError: "CLI failed" }),
      "CLI failed",
    ],
    ["a failed read", () => Promise.reject(new Error("Unknown command")), "Unknown command"],
    [
      "an unreadable response",
      () => Promise.resolve(undefined),
      "The backend returned an unreadable plugin list",
    ],
  ] as const) {
    test(`${label} shows its reason and is retried on the next visit`, async () => {
      pluginResponse = response;
      render(<SkillsSettings />);

      clickTab(/^Plugins/);
      await waitFor(() => expect(screen.getByRole("alert").textContent).toBe(message));
      expect(screen.queryByText("This agent reports no plugins on this machine.") === null).toBe(
        true,
      );

      pluginResponse = async (agent) => ({ agent, plugins: [VERCEL] });
      clickTab(/^Skills/);
      clickTab(/^Plugins/);
      await waitFor(() => expect(pluginListText()).toContain("vercel"));
      expect(pluginReads()).toHaveLength(2);
    });
  }

  test("a failed reload keeps the plugins already shown", async () => {
    render(<SkillsSettings />);
    clickTab(/^Plugins/);
    await waitFor(() => expect(pluginListText()).toContain("vercel"));

    pluginResponse = async () => ({ plugins: [], pluginError: "timed out" });
    fireEvent.click(screen.getByRole("button", { name: "Reload plugins" }));

    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("timed out"));
    expect(pluginListText()).toContain("vercel");
  });

  test("filters by name and source, and counts what remains", async () => {
    render(<SkillsSettings />);
    clickTab(/^Plugins/);
    await waitFor(() => expect(pluginListText()).toContain("vercel"));

    fireEvent.change(screen.getByRole("textbox", { name: "Filter plugins" }), {
      target: { value: "project" },
    });

    expect(pluginListText()).toContain("stripe");
    expect(pluginListText()).not.toContain("vercel");
    expect(screen.getByText("1 of 2 plugins")).toBeTruthy();
  });

  test("opens one of a plugin's skills in the skills view", async () => {
    skills = [pluginSkill("ai-sdk"), pluginSkill("auth")];
    render(<SkillsSettings />);
    await waitFor(() => expect(screen.getByRole("tab", { name: /^Skills\s*2$/ })).toBeTruthy());

    clickTab(/^Plugins/);
    const bundled = await screen.findByRole("list", { name: "Skills from vercel" });
    fireEvent.click(within(bundled).getByRole("button", { name: /vercel:auth/ }));

    const current = await waitFor(() =>
      within(screen.getByRole("list", { name: "Skills" })).getByRole("button", {
        name: /vercel:auth/,
      }),
    );
    expect(current.getAttribute("aria-current")).toBe("true");
    expect(screen.getByRole("heading", { level: 4, name: "vercel:auth" })).toBeTruthy();
  });

  test("describes a disabled plugin, and one with no listed skills, without guessing", async () => {
    pluginResponse = async (agent) => ({ agent, plugins: [STRIPE, VERCEL] });
    render(<SkillsSettings />);
    clickTab(/^Plugins/);
    await waitFor(() =>
      expect(
        screen.getByText("This plugin is disabled, so its skills are not loaded."),
      ).toBeTruthy(),
    );

    fireEvent.click(
      within(screen.getByRole("list", { name: "Plugins" })).getByRole("button", {
        name: /vercel/,
      }),
    );
    expect(screen.getByText("No skills from this plugin are listed for this agent.")).toBeTruthy();
  });
});

test("reload rescans skills and displays newly installed skills", async () => {
  render(<SkillsSettings />);
  clickTab(/^Plugins/);
  await screen.findByText("No skills from this plugin are listed for this agent.");
  const before = invokeCalls.filter((c) => c.command === "list_agent_skills").length;
  skills = [pluginSkill("new-skill")];
  fireEvent.click(screen.getByRole("button", { name: "Reload plugins" }));
  await screen.findByRole("list", { name: "Skills from vercel" });
  expect(screen.getByText("vercel:new-skill")).toBeTruthy();
  expect(invokeCalls.filter((c) => c.command === "list_agent_skills")).toHaveLength(before + 1);
});

test("plugin details explain pending and failed skill scans", async () => {
  let rejectScan!: (error: Error) => void;
  scanResponse = () =>
    new Promise((_, reject) => {
      rejectScan = reject;
    });
  render(<SkillsSettings />);
  clickTab(/^Plugins/);
  await screen.findByText("Scanning plugin skills…");
  rejectScan(new Error("scan unavailable"));
  await screen.findByText("Skill scan failed: scan unavailable");
  expect(screen.queryByText("No skills from this plugin are listed for this agent.")).toBeNull();
});

test("same-name marketplace installations never claim each other's skills", async () => {
  pluginResponse = async (agent) => ({
    agent,
    plugins: [
      { ...VERCEL, source: "market-a" },
      { ...VERCEL, source: "market-b" },
    ],
  });
  skills = [
    pluginSkill("one"),
    { ...pluginSkill("two"), filePath: "/market-b/skills/two/SKILL.md" },
  ];
  render(<SkillsSettings />);
  clickTab(/^Plugins/);
  const list = await screen.findByRole("list", { name: "Plugins" });
  for (const row of within(list).getAllByRole("button")) {
    fireEvent.click(row);
    expect(screen.getByText(/Multiple marketplaces provide/)).toBeTruthy();
    expect(screen.queryByRole("list", { name: "Skills from vercel" })).toBeNull();
  }
});

test("plugin caches and in-flight results stay with their selected machine", async () => {
  // A hook harness isolates machine routing from the settings parent's remount boundary.
  const { portalStore } = await import("@/lib/portal/portal-store");
  const { spyOn } = await import("bun:test");
  let resolveOld!: (value: unknown) => void;
  const route = spyOn(portalStore, "invokeOnNode").mockImplementation((async (node: string) =>
    node === "first"
      ? new Promise<unknown>((resolve) => {
          resolveOld = resolve;
        })
      : {
          agent: "claude",
          plugins: [{ ...VERCEL, name: "second-plugin" }],
        }) as typeof portalStore.invokeOnNode);
  function Harness({ machine }: { machine: string }) {
    const { state } = useAgentPlugins("claude", machine, true);
    return <div>{state.catalog?.plugins.map((p) => p.name).join(",") ?? "pending"}</div>;
  }
  try {
    const view = render(<Harness machine="first" />);
    await waitFor(() => expect(route).toHaveBeenCalledTimes(1));
    view.rerender(<Harness machine="second" />);
    await screen.findByText("second-plugin");
    await act(async () => {
      resolveOld({ agent: "claude", plugins: [VERCEL] });
    });
    await waitFor(() => expect(screen.queryByText("vercel")).toBeNull());
    expect(route.mock.calls.map((c) => c.slice(0, 3))).toEqual([
      ["first", "list_agent_plugins", { provider: "claude" }],
      ["second", "list_agent_plugins", { provider: "claude" }],
    ]);
  } finally {
    route.mockRestore();
  }
});

test("unsupported Cursor catalog remains a stable unavailable result", async () => {
  pluginResponse = async (agent) => ({
    agent,
    plugins: [],
    pluginError: "Cursor's SDK bridge does not expose a plugin list.",
  });
  render(<SkillsSettings provider="cursor" />);
  clickTab(/^Plugins/);
  await screen.findByText("Cursor's SDK bridge does not expose a plugin list.");
  clickTab(/^Skills/);
  clickTab(/^Plugins/);
  expect(pluginReads()).toHaveLength(1);
  expect(screen.queryByRole("alert")).toBeNull();
});
