import { describe, expect, test } from "bun:test";

import {
  TomlEditError,
  addTomlEntry,
  removeTomlEntry,
  renameTomlEntry,
  scanTomlLayout,
  tomlEntryLayout,
  tomlRootLayout,
  updateTomlEntry,
} from "./toml-edit.js";

const ROOT = ["mcp_servers"];

const CONFIG = `# Codex configuration
model = "o3"
notes = """
[mcp_servers.fake]
not a table
"""

# Docs server, kept with its table
[mcp_servers.docs]
command = "npx" # launcher
args = [
  "-y", # first
  "docs-mcp",
]
startup_timeout_sec = 10.0

[mcp_servers.docs.env]
TOKEN = "SENTINEL-TOKEN"

# unrelated section comment

[profiles.fast]
model = "o4-mini"

[mcp_servers."dotted.name"]
url = "https://example.com/mcp"
`;

const parse = (text: string) => Bun.TOML.parse(text) as Record<string, any>;

describe("toml-edit", () => {
  test("lexes headers without matching text inside multi-line strings", () => {
    const layout = scanTomlLayout(CONFIG);
    expect(layout.headers.map((header) => header.path.join("."))).toEqual([
      "mcp_servers.docs",
      "mcp_servers.docs.env",
      "profiles.fast",
      "mcp_servers.dotted.name",
    ]);
    expect(tomlEntryLayout(layout, ROOT, "dotted.name").kind).toBe("tables");
    expect(tomlEntryLayout(layout, ROOT, "fake").kind).toBe("absent");
  });

  test("updates only changed keys and keeps float style, comments and other tables", () => {
    const before = parse(CONFIG).mcp_servers.docs;
    const next = updateTomlEntry(CONFIG, ROOT, "docs", before, {
      ...before,
      command: "bunx",
      enabled: false,
    });
    expect(next).toContain('command = "bunx" # launcher');
    expect(next).toContain("startup_timeout_sec = 10.0");
    expect(next).toContain('  "-y", # first');
    expect(next).toContain("# unrelated section comment");
    expect(next).toContain("enabled = false");
    const parsed = parse(next);
    expect(parsed.mcp_servers.docs).toEqual({ ...before, command: "bunx", enabled: false });
    expect(parsed.profiles).toEqual({ fast: { model: "o4-mini" } });
    expect(parsed.notes).toContain("[mcp_servers.fake]");
  });

  test("rewrites a changed sub-table as an inline table and removes the old block", () => {
    const before = parse(CONFIG).mcp_servers.docs;
    const next = updateTomlEntry(CONFIG, ROOT, "docs", before, {
      ...before,
      env: { API_TOKEN: "SENTINEL-TOKEN" },
    });
    expect(next).not.toContain("[mcp_servers.docs.env]");
    expect(parse(next).mcp_servers.docs.env).toEqual({ API_TOKEN: "SENTINEL-TOKEN" });
    expect(parse(next).profiles.fast.model).toBe("o4-mini");
  });

  test("renames every table of an entry and quotes names that need it", () => {
    const next = renameTomlEntry(CONFIG, ROOT, "docs", "docs v2");
    expect(next).toContain('[mcp_servers."docs v2"]');
    expect(next).toContain('[mcp_servers."docs v2".env]');
    expect(parse(next).mcp_servers["docs v2"].env.TOKEN).toBe("SENTINEL-TOKEN");
    expect(() => renameTomlEntry(CONFIG, ROOT, "docs", "dotted.name")).toThrow(TomlEditError);
  });

  test("removes an entry with its sub-tables and attached comment, keeping neighbours", () => {
    const next = removeTomlEntry(CONFIG, ROOT, "docs");
    expect(next).not.toContain("Docs server");
    expect(next).toContain("# unrelated section comment");
    const parsed = parse(next);
    expect(Object.keys(parsed.mcp_servers)).toEqual(["dotted.name"]);
    const last = removeTomlEntry(next, ROOT, "dotted.name");
    expect(last.endsWith('model = "o4-mini"\n')).toBe(true);
    expect(parse(last).mcp_servers).toBeUndefined();
  });

  test("adds to an empty file and after existing content", () => {
    expect(
      parse(addTomlEntry("", ROOT, "new", { url: "https://a.example", http_headers: { A: "b" } })),
    ).toEqual({
      mcp_servers: { new: { url: "https://a.example", http_headers: { A: "b" } } },
    });
    const next = addTomlEntry(CONFIG, ROOT, "x.y", { command: "c" });
    expect(parse(next).mcp_servers["x.y"]).toEqual({ command: "c" });
  });

  test("reports inline and dotted layouts as unsupported instead of guessing", () => {
    const inline = `[mcp_servers]\ndocs = { command = "x" }\n`;
    const layout = scanTomlLayout(inline);
    expect(tomlEntryLayout(layout, ROOT, "docs").kind).toBe("unsupported");
    expect(tomlRootLayout(layout, ROOT)).toBe("unsupported");
    expect(() => addTomlEntry(inline, ROOT, "b", { command: "c" })).toThrow(TomlEditError);
    const dotted = `mcp_servers.docs.command = "x"\n`;
    expect(tomlEntryLayout(scanTomlLayout(dotted), ROOT, "docs").kind).toBe("unsupported");
    expect(() => removeTomlEntry(dotted, ROOT, "docs")).toThrow(TomlEditError);
  });

  test("keeps CRLF line endings", () => {
    const text = '[mcp_servers.a]\r\ncommand = "x"\r\n';
    const next = addTomlEntry(text, ROOT, "b", { command: "y" });
    expect(next).toBe(
      '[mcp_servers.a]\r\ncommand = "x"\r\n\r\n[mcp_servers.b]\r\ncommand = "y"\r\n',
    );
  });
});
