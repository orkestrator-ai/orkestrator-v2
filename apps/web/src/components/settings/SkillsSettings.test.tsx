import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

/**
 * `@/lib/native/backend` is mocked globally in tests/setup.ts with an invoke
 * that resolves undefined. This suite needs per-command payloads, so it installs
 * its own dispatching invoke and restores the setup.ts shape in afterAll —
 * `--parallel` isolates module registries per file, but the restore keeps a
 * sequential run honest too.
 */
const invokeCalls: Array<{ command: string; args?: Record<string, unknown> }> = [];
let skillScans: Record<string, unknown> = {};
let skillFiles: Record<string, unknown> = {};
let failReadWith: string | null = null;

mock.module("@/lib/native/backend", () => ({
  invoke: mock((command: string, args?: Record<string, unknown>) => {
    invokeCalls.push({ command, args });
    if (command === "list_agent_skills") {
      return Promise.resolve(skillScans[String(args?.provider)] ?? emptyScan(String(args?.provider)));
    }
    if (command === "read_agent_skill") {
      if (failReadWith) return Promise.reject(new Error(failReadWith));
      return Promise.resolve(
        skillFiles[String(args?.filePath)] ?? { path: args?.filePath, content: "", truncated: false },
      );
    }
    return Promise.resolve();
  }),
}));

afterAll(() => {
  mock.module("@/lib/native/backend", () => ({ invoke: mock(() => Promise.resolve()) }));
});

const { SkillsSettings, stripFrontmatter } = await import("./SkillsSettings");

describe("stripFrontmatter", () => {
  test("removes a YAML block that remark would otherwise render as a heading", () => {
    expect(stripFrontmatter("---\nname: a\ndescription: b\n---\n\n# Body"))
      .toBe("\n# Body");
  });

  test("leaves a document without frontmatter untouched", () => {
    expect(stripFrontmatter("# Body\n\n---\n\nA rule.")).toBe("# Body\n\n---\n\nA rule.");
  });

  test("does not eat a horizontal rule further down the document", () => {
    expect(stripFrontmatter("---\nname: a\n---\n\nOne\n\n---\n\nTwo"))
      .toBe("\nOne\n\n---\n\nTwo");
  });
});

function emptyScan(provider: string) {
  return { provider, roots: [], skills: [], errors: [] };
}

function skill(overrides: Record<string, unknown>) {
  return {
    id: String(overrides.filePath),
    name: "skill",
    description: "",
    filePath: "/home/me/.claude/skills/skill/SKILL.md",
    location: "~/.claude/skills/skill",
    scope: "user",
    shadowed: false,
    ...overrides,
  };
}

beforeEach(() => {
  invokeCalls.length = 0;
  failReadWith = null;
  skillScans = {};
  skillFiles = {};
});

afterEach(cleanup);

/** Radix activates a tab from mousedown/focus, not from a bare click. */
function clickTab(name: string | RegExp) {
  const trigger = screen.getByRole("tab", { name });
  fireEvent.mouseDown(trigger);
  fireEvent.focus(trigger);
}

/** The skill name also appears in the detail header, so list assertions scope here. */
function list() {
  return within(screen.getByRole("list", { name: "Skills" }));
}

describe("SkillsSettings", () => {
  test("lists the agent's skills with name and location, and renders the first one", async () => {
    skillScans.claude = {
      provider: "claude",
      roots: [{ path: "/home/me/.claude/skills", label: "~/.claude/skills", scope: "user", exists: true, skillCount: 2 }],
      skills: [
        skill({ name: "alpha", location: "~/.claude/skills/alpha", filePath: "/a/SKILL.md" }),
        skill({ name: "zeta", location: "~/.agents/skills/zeta", filePath: "/z/SKILL.md", scope: "shared" }),
      ],
      errors: [],
    };
    skillFiles["/a/SKILL.md"] = { path: "/a/SKILL.md", content: "Alpha body paragraph", truncated: false };

    render(<SkillsSettings />);

    await waitFor(() => expect(list().getByText("alpha")).toBeTruthy());
    expect(list().getByText("~/.claude/skills/alpha")).toBeTruthy();
    expect(list().getByText("zeta")).toBeTruthy();
    expect(list().getByText("~/.agents/skills/zeta")).toBeTruthy();

    // The first skill is auto-selected so the detail pane is never blank.
    await waitFor(() => expect(screen.getByText("Alpha body paragraph")).toBeTruthy());
    expect(invokeCalls.some((call) =>
      call.command === "read_agent_skill" && call.args?.filePath === "/a/SKILL.md")).toBe(true);
  });

  test("selecting a skill loads that skill's markdown", async () => {
    skillScans.claude = {
      provider: "claude",
      roots: [],
      skills: [
        skill({ name: "alpha", filePath: "/a/SKILL.md" }),
        skill({ name: "beta", filePath: "/b/SKILL.md" }),
      ],
      errors: [],
    };
    skillFiles["/a/SKILL.md"] = { path: "/a/SKILL.md", content: "Alpha body paragraph", truncated: false };
    skillFiles["/b/SKILL.md"] = { path: "/b/SKILL.md", content: "Beta body paragraph", truncated: false };

    render(<SkillsSettings />);

    await waitFor(() => expect(screen.getByText("Alpha body paragraph")).toBeTruthy());
    fireEvent.click(list().getByText("beta"));
    await waitFor(() => expect(screen.getByText("Beta body paragraph")).toBeTruthy());
  });

  test("switching tabs scans that agent's skills", async () => {
    skillScans.claude = { ...emptyScan("claude"), skills: [skill({ name: "claude-only", filePath: "/c/SKILL.md" })] };
    skillScans.codex = { ...emptyScan("codex"), skills: [skill({ name: "codex-only", filePath: "/x/SKILL.md" })] };

    render(<SkillsSettings />);
    await waitFor(() => expect(list().getByText("claude-only")).toBeTruthy());

    clickTab(/Codex/);

    await waitFor(() => expect(list().getByText("codex-only")).toBeTruthy());
    expect(list().queryByText("claude-only")).toBeNull();
    expect(invokeCalls.filter((call) => call.command === "list_agent_skills").map((call) => call.args?.provider))
      .toEqual(["claude", "codex"]);
  });

  test("the raw toggle shows the file source instead of rendered markdown", async () => {
    skillScans.claude = { ...emptyScan("claude"), skills: [skill({ name: "alpha", filePath: "/a/SKILL.md" })] };
    skillFiles["/a/SKILL.md"] = {
      path: "/a/SKILL.md",
      content: "# Alpha heading",
      truncated: false,
    };

    render(<SkillsSettings />);

    // Rendered: the "#" is consumed by the heading, so only the text survives.
    await waitFor(() => expect(screen.getByRole("heading", { name: "Alpha heading" })).toBeTruthy());
    expect(screen.queryByText("# Alpha heading")).toBeNull();

    clickTab("Raw");

    // Raw: the markdown source is shown verbatim, "#" and all.
    await waitFor(() => expect(screen.getByText("# Alpha heading")).toBeTruthy());
    expect(screen.queryByRole("heading", { name: "Alpha heading" })).toBeNull();
  });

  test("filters the list by name and location", async () => {
    skillScans.claude = {
      ...emptyScan("claude"),
      skills: [
        skill({ name: "alpha", location: "~/.claude/skills/alpha", filePath: "/a/SKILL.md" }),
        skill({ name: "beta", location: "~/.agents/skills/beta", filePath: "/b/SKILL.md" }),
      ],
    };

    render(<SkillsSettings />);
    await waitFor(() => expect(list().getByText("beta")).toBeTruthy());

    fireEvent.change(screen.getByLabelText("Filter skills"), { target: { value: "agents" } });

    expect(list().queryByText("alpha")).toBeNull();
    expect(list().getByText("beta")).toBeTruthy();
  });

  test("marks a shadowed skill so the user knows it is not the one that loads", async () => {
    skillScans.claude = {
      ...emptyScan("claude"),
      skills: [skill({ name: "dup", filePath: "/d/SKILL.md", shadowed: true })],
    };

    render(<SkillsSettings />);

    await waitFor(() => expect(list().getByText("Shadowed")).toBeTruthy());
  });

  test("surfaces a scan failure rather than showing an empty list", async () => {
    skillScans.claude = {
      ...emptyScan("claude"),
      errors: [{ path: "~/.claude/skills", message: "EACCES: permission denied" }],
    };

    render(<SkillsSettings />);

    await waitFor(() => expect(screen.getByText(/EACCES: permission denied/)).toBeTruthy());
  });

  test("surfaces a read failure in the detail pane", async () => {
    skillScans.claude = { ...emptyScan("claude"), skills: [skill({ name: "alpha", filePath: "/a/SKILL.md" })] };
    failReadWith = "Refusing to read a file outside the agent skill directories";

    render(<SkillsSettings />);

    await waitFor(() => expect(screen.getByText(/Refusing to read a file/)).toBeTruthy());
  });

  test("shows an empty state when the agent has no skills anywhere", async () => {
    render(<SkillsSettings />);

    await waitFor(() =>
      expect(screen.getByText(/No skills found in any of this agent's skill directories/)).toBeTruthy());
  });
});
