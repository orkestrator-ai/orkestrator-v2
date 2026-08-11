/**
 * A self-contained scanner executed inside the selected environment.
 *
 * Local environments run it with the backend's Bun executable and containers
 * run it with Node. Keeping the scan on the environment side means HOME,
 * CODEX_HOME, XDG_CONFIG_HOME, plugin manifests, and project-relative roots all
 * describe the agent's real filesystem rather than the desktop host.
 */
export const ENVIRONMENT_AGENT_SKILLS_SCRIPT = String.raw`
const fs = require("node:fs");
const fsp = fs.promises;
const os = require("node:os");
const path = require("node:path");

const provider = process.argv[1];
const operation = process.argv[2];
const requestedPath = process.argv[3] || "";
const home = os.homedir();
const cwd = process.cwd();
const maxEntriesPerRoot = 500;
const maxSkills = 2000;
const maxHeadBytes = 16 * 1024;
const maxFileBytes = 1024 * 1024;

if (!["claude", "codex", "opencode"].includes(provider)) {
  throw new Error("Unknown agent skill provider");
}

function inside(parent, target) {
  const root = path.normalize(parent);
  const value = path.normalize(target);
  return value === root || value.startsWith(root.endsWith(path.sep) ? root : root + path.sep);
}

function displayPath(target) {
  if (target === home) return "~";
  if (inside(home, target)) return "~" + path.sep + path.relative(home, target);
  if (inside(cwd, target)) return "." + path.sep + path.relative(cwd, target);
  return target;
}

async function jsonFile(file) {
  try { return JSON.parse(await fsp.readFile(file, "utf8")); } catch { return undefined; }
}

async function projectDirectories() {
  const result = [];
  let current = cwd;
  while (true) {
    result.push(current);
    try {
      await fsp.stat(path.join(current, ".git"));
      break;
    } catch {}
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return result;
}

async function claudePluginRoots() {
  const manifest = await jsonFile(path.join(home, ".claude", "plugins", "installed_plugins.json"));
  if (!manifest || typeof manifest !== "object" || !manifest.plugins || typeof manifest.plugins !== "object") return [];
  const result = [];
  for (const [id, value] of Object.entries(manifest.plugins)) {
    for (const install of Array.isArray(value) ? value : []) {
      if (install && typeof install.installPath === "string" && path.isAbsolute(install.installPath)) {
        result.push({ path: path.join(install.installPath, "skills"), scope: "plugin", plugin: id.split("@")[0] || id });
        break;
      }
    }
  }
  return result;
}

function safeSegment(value) {
  return value && value !== "." && value !== ".." && !value.includes("/") && !value.includes("\\");
}

async function newestDirectory(parent) {
  try {
    const entries = (await fsp.readdir(parent, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
      .map((entry) => entry.name)
      .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
    return entries[0] ? path.join(parent, entries[0]) : undefined;
  } catch { return undefined; }
}

async function codexPluginRoots(codexHome) {
  let config;
  try { config = await fsp.readFile(path.join(codexHome, "config.toml"), "utf8"); } catch { return []; }
  const enabled = [];
  let current = null;
  for (const raw of config.split(/\r?\n/)) {
    const line = raw.trim();
    const header = /^\[plugins\."([^"@]+)@([^"]+)"\]/.exec(line);
    if (header) { current = { plugin: header[1], marketplace: header[2] }; continue; }
    if (line.startsWith("[")) { current = null; continue; }
    if (current && /^enabled\s*=\s*true(?:\s*#.*)?$/.test(line)) {
      enabled.push(current);
      current = null;
    }
  }
  const cache = path.join(codexHome, "plugins", "cache");
  const result = [];
  for (const entry of enabled) {
    if (!safeSegment(entry.plugin) || !safeSegment(entry.marketplace)) continue;
    const pluginRoot = path.join(cache, entry.marketplace, entry.plugin);
    if (!inside(cache, pluginRoot)) continue;
    const version = await newestDirectory(pluginRoot);
    if (version) result.push({ path: path.join(version, "skills"), scope: "plugin", plugin: entry.plugin });
  }
  return result;
}

async function rootsFor() {
  const projects = await projectDirectories();
  if (provider === "claude") {
    const managed = process.platform === "darwin"
      ? "/Library/Application Support/ClaudeCode/skills"
      : process.platform === "win32"
        ? path.join(process.env.PROGRAMDATA || "C:\\ProgramData", "ClaudeCode", "skills")
        : "/etc/claude-code/skills";
    return [
      ...projects.map((dir) => ({ path: path.join(dir, ".claude", "skills"), scope: "project" })),
      { path: managed, scope: "admin" },
      { path: path.join(home, ".claude", "skills"), scope: "user" },
      ...(await claudePluginRoots()),
    ];
  }

  if (provider === "codex") {
    const codexHome = process.env.CODEX_HOME && process.env.CODEX_HOME.trim()
      ? path.resolve(process.env.CODEX_HOME)
      : path.join(home, ".codex");
    return [
      ...projects.flatMap((dir) => [
        { path: path.join(dir, ".codex", "skills"), scope: "project" },
        { path: path.join(dir, ".agents", "skills"), scope: "project" },
      ]),
      ...(process.platform === "win32" ? [] : [{ path: "/etc/codex/skills", scope: "admin" }]),
      { path: path.join(codexHome, "skills"), scope: "user", skip: [".system"] },
      { path: path.join(home, ".agents", "skills"), scope: "shared" },
      { path: path.join(codexHome, "skills", ".system"), scope: "system" },
      ...(await codexPluginRoots(codexHome)),
    ];
  }

  const configHome = process.env.XDG_CONFIG_HOME && process.env.XDG_CONFIG_HOME.trim()
    ? path.join(path.resolve(process.env.XDG_CONFIG_HOME), "opencode")
    : path.join(home, ".config", "opencode");
  return [
    ...projects.flatMap((dir) => [
      { path: path.join(dir, ".opencode", "skills"), scope: "project" },
      { path: path.join(dir, ".opencode", "skill"), scope: "project" },
      { path: path.join(dir, ".claude", "skills"), scope: "project" },
      { path: path.join(dir, ".agents", "skills"), scope: "project" },
    ]),
    { path: path.join(configHome, "skills"), scope: "user" },
    { path: path.join(home, ".claude", "skills"), scope: "shared" },
    { path: path.join(home, ".agents", "skills"), scope: "shared" },
  ];
}

function frontmatter(head) {
  const normalized = head.replace(/^\uFEFF/, "");
  if (!/^---[ \t]*\r?\n/.test(normalized)) return {};
  const lines = normalized.split(/\r?\n/).slice(1);
  const result = {};
  let closed = false;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (["---", "..."].includes(line.trimEnd())) { closed = true; break; }
    const match = /^([A-Za-z0-9_-]+):[ \t]*(.*)$/.exec(line);
    if (!match || !["name", "description"].includes(match[1])) continue;
    let value = match[2].trim();
    if (/^[|>][+-]?\d*$/.test(value)) {
      const body = [];
      let cursor = index + 1;
      for (; cursor < lines.length; cursor += 1) {
        const next = lines[cursor];
        if (["---", "..."].includes(next.trimEnd())) break;
        if (next.trim() && !/^\s/.test(next)) break;
        body.push(next.trim());
      }
      index = cursor - 1;
      value = body.join(" ").replace(/\s+/g, " ").trim();
    } else if (value.length > 1 && ((value[0] === '"' && value.at(-1) === '"') || (value[0] === "'" && value.at(-1) === "'"))) {
      value = value.slice(1, -1);
    }
    if (value) result[match[1]] = Array.from(value).slice(0, 512).join("");
  }
  return closed ? result : {};
}

async function scanRoot(spec, errors) {
  const root = { path: spec.path, label: displayPath(spec.path), scope: spec.scope, ...(spec.plugin ? { plugin: spec.plugin } : {}), exists: false, skillCount: 0, truncated: false };
  let directory;
  try {
    directory = await fsp.opendir(spec.path);
  } catch (error) {
    if (!error || !["ENOENT", "ENOTDIR"].includes(error.code)) errors.push({ path: root.label, message: error instanceof Error ? error.message : String(error) });
    return { root, skills: [] };
  }
  root.exists = true;
  const candidates = [];
  try {
    for await (const entry of directory) {
      if ((!entry.isDirectory() && !entry.isSymbolicLink()) || (spec.skip || []).includes(entry.name)) continue;
      if (candidates.length >= maxEntriesPerRoot) { root.truncated = true; break; }
      candidates.push(entry);
    }
  } catch (error) {
    root.exists = false;
    if (!error || !["ENOENT", "ENOTDIR"].includes(error.code)) errors.push({ path: root.label, message: error instanceof Error ? error.message : String(error) });
    return { root, skills: [] };
  } finally {
    try { await directory.close(); } catch {}
  }
  const skills = [];
  for (const entry of candidates) {
    const skillDir = path.join(spec.path, entry.name);
    const filePath = path.join(skillDir, "SKILL.md");
    try {
      const handle = await fsp.open(filePath, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK);
      try {
        if (!(await handle.stat()).isFile()) continue;
        const buffer = Buffer.alloc(maxHeadBytes);
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
        const meta = frontmatter(buffer.subarray(0, bytesRead).toString("utf8"));
        skills.push({
          id: filePath,
          name: (meta.name || entry.name).trim(),
          description: meta.description || "",
          filePath,
          location: displayPath(skillDir),
          scope: spec.scope,
          ...(spec.plugin ? { plugin: spec.plugin } : {}),
          realPath: await fsp.realpath(filePath).catch(() => filePath),
        });
      } finally { await handle.close(); }
    } catch (error) {
      if (!error || error.code !== "ENOENT") errors.push({ path: displayPath(filePath), message: error instanceof Error ? error.message : String(error) });
    }
  }
  return { root, skills };
}

async function list() {
  const specs = await rootsFor();
  const errors = [];
  const results = [];
  for (const spec of specs) results.push(await scanRoot(spec, errors));
  const seenNames = new Set();
  const seenFiles = new Set();
  const skills = [];
  for (const result of results) {
    let listed = 0;
    for (const skill of result.skills) {
      if (skills.length >= maxSkills) { result.root.truncated = true; break; }
      if (seenFiles.has(skill.realPath)) continue;
      seenFiles.add(skill.realPath);
      const key = skill.name.toLowerCase();
      const { realPath, ...item } = skill;
      skills.push({ ...item, shadowed: seenNames.has(key) });
      seenNames.add(key);
      listed += 1;
    }
    result.root.skillCount = listed;
  }
  const scopeOrder = ["project", "admin", "user", "shared", "system", "plugin"];
  skills.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }) || Number(a.shadowed) - Number(b.shadowed) || scopeOrder.indexOf(a.scope) - scopeOrder.indexOf(b.scope) || a.location.localeCompare(b.location));
  return { provider, roots: results.map((result) => result.root), skills, errors };
}

async function read() {
  if (!path.isAbsolute(requestedPath) || path.basename(path.normalize(requestedPath)) !== "SKILL.md") throw new Error("Expected an absolute SKILL.md path");
  const specs = await rootsFor();
  const normalized = path.normalize(requestedPath);
  if (!specs.some((spec) => inside(spec.path, normalized))) throw new Error("Refusing to read a file outside the environment's agent skill directories");
  const handle = await fsp.open(normalized, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK);
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new Error("Not a regular file");
    const capacity = Math.min(stat.size + 1, maxFileBytes + 1);
    const buffer = Buffer.alloc(capacity);
    let bytesRead = 0;
    while (bytesRead < buffer.length) {
      const result = await handle.read(buffer, bytesRead, buffer.length - bytesRead, bytesRead);
      if (!result.bytesRead) break;
      bytesRead += result.bytesRead;
    }
    return { path: normalized, content: buffer.subarray(0, Math.min(bytesRead, maxFileBytes)).toString("utf8"), truncated: bytesRead > maxFileBytes };
  } finally { await handle.close(); }
}

Promise.resolve(operation === "list" ? list() : operation === "read" ? read() : Promise.reject(new Error("Unknown skill operation")))
  .then((result) => process.stdout.write(JSON.stringify(result)))
  .catch((error) => { process.stderr.write(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
`;
