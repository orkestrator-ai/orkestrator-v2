/**
 * A self-contained scanner executed inside the selected environment.
 *
 * Local environments run it with the backend's Bun executable and containers
 * run it with Node. OpenCode supplies its own resolved skill catalogue on
 * stdin; Claude and Codex are scanned here because neither exposes an
 * equivalent read-only catalogue command.
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
const isolatedAgentTest = process.env.ORKESTRATOR_AGENT_TEST_ISOLATED === "1";
const maxEntriesPerRoot = 500;
const maxRoots = 256;
const maxSkills = 2000;
const maxDepth = 32;
const maxHeadBytes = 16 * 1024;
const maxFileBytes = 1024 * 1024;
const maxErrors = 100;

if (!["claude", "codex", "cursor", "grok", "opencode", "pi"].includes(provider)) {
  throw new Error("Unknown agent skill provider");
}

/**
 * Every other dimension of this response is explicitly bounded, and the error
 * list must be too: one project directory full of escaping symlinks would
 * otherwise answer with tens of thousands of entries, all of which the settings
 * pane renders un-virtualised. Past the cap the count is kept and reported as a
 * single trailing entry, so a truncated list never reads as a complete one.
 */
function createErrorSink() {
  const entries = [];
  let suppressed = 0;
  return {
    push(entry) {
      if (entries.length < maxErrors) entries.push(entry);
      else suppressed += 1;
    },
    drain() {
      if (suppressed > 0) {
        entries.push({
          path: "…",
          message: suppressed + " further path" + (suppressed === 1 ? "" : "s")
            + " could not be read or were refused",
        });
      }
      return entries;
    },
  };
}

function inside(parent, target) {
  const root = path.resolve(parent);
  const value = path.resolve(target);
  const relative = path.relative(root, value);
  return relative === "" || (!relative.startsWith(".." + path.sep) && relative !== ".." && !path.isAbsolute(relative));
}

function displayPath(target) {
  if (target === home) return "~";
  if (inside(home, target)) return "~" + path.sep + path.relative(home, target);
  if (inside(cwd, target)) return "." + path.sep + path.relative(cwd, target);
  return target;
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
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
  if (isolatedAgentTest) return [];
  const manifest = await jsonFile(path.join(home, ".claude", "plugins", "installed_plugins.json"));
  if (!manifest || typeof manifest !== "object" || !manifest.plugins || typeof manifest.plugins !== "object") return [];
  const result = [];
  for (const [id, value] of Object.entries(manifest.plugins).slice(0, maxRoots)) {
    for (const install of Array.isArray(value) ? value : []) {
      if (install && typeof install.installPath === "string" && path.isAbsolute(install.installPath)) {
        const marketplace = id.lastIndexOf("@");
        const plugin = marketplace > 0 ? id.slice(0, marketplace) : id;
        result.push({ path: path.join(install.installPath, "skills"), scope: "plugin", plugin, recursive: false });
        break;
      }
    }
  }
  return result;
}

function safeSegment(value) {
  return value && value !== "." && value !== ".." && !value.includes("/") && !value.includes("\\");
}

function rankVersion(name) {
  const version = /^v?(\d+(?:\.\d+)*)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(name);
  if (!version) return { kind: "fallback", numbers: [], prerelease: name };
  return {
    kind: version[2] ? "prerelease" : "release",
    numbers: version[1].split(".").map(Number),
    prerelease: version[2] || "",
  };
}

function compareVersions(a, b) {
  const left = rankVersion(a);
  const right = rankVersion(b);
  const kindRank = { release: 2, prerelease: 1, fallback: 0 };
  const kindDifference = kindRank[right.kind] - kindRank[left.kind];
  if (kindDifference !== 0) return kindDifference;
  const parts = Math.max(left.numbers.length, right.numbers.length);
  for (let index = 0; index < parts; index += 1) {
    const difference = (right.numbers[index] || 0) - (left.numbers[index] || 0);
    if (difference !== 0) return difference;
  }
  return right.prerelease.localeCompare(left.prerelease, undefined, { numeric: true });
}

async function newestDirectory(parent) {
  try {
    const entries = (await fsp.readdir(parent, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
      .map((entry) => entry.name)
      .sort(compareVersions);
    return entries[0] ? path.join(parent, entries[0]) : undefined;
  } catch { return undefined; }
}

async function codexEnabledPlugins(configPath) {
  let config;
  try { config = await fsp.readFile(configPath, "utf8"); } catch { return []; }
  const enabled = [];
  let current = null;
  let inPluginsTable = false;
  for (const raw of config.split(/\r?\n/)) {
    const line = raw.trim();
    const header = /^\[plugins\."([^"@]+)@([^"]+)"\][ \t]*(?:#.*)?$/.exec(line);
    if (header) {
      current = { plugin: header[1], marketplace: header[2] };
      inPluginsTable = false;
      continue;
    }
    if (line.startsWith("[")) {
      current = null;
      inPluginsTable = /^\[plugins\][ \t]*(?:#.*)?$/.test(line);
      continue;
    }
    const inline = inPluginsTable
      ? /^"([^"@]+)@([^"]+)"[ \t]*=[ \t]*\{([^}]*)\}[ \t]*(?:#.*)?$/.exec(line)
      : null;
    if (inline) {
      if (/(?:^|,)\s*enabled\s*=\s*true\s*(?:,|$)/.test(inline[3])) {
        enabled.push({ plugin: inline[1], marketplace: inline[2] });
      }
      continue;
    }
    if (current && /^enabled\s*=\s*true[ \t]*(?:#.*)?$/.test(line)) {
      enabled.push(current);
      current = null;
    }
  }
  return enabled.slice(0, maxRoots);
}

async function codexPluginRoots(codexHome) {
  const enabled = await codexEnabledPlugins(path.join(codexHome, "config.toml"));
  const cache = path.join(codexHome, "plugins", "cache");
  const result = [];
  for (const entry of enabled) {
    if (!safeSegment(entry.plugin) || !safeSegment(entry.marketplace)) continue;
    const pluginRoot = path.join(cache, entry.marketplace, entry.plugin);
    if (!inside(cache, pluginRoot)) continue;
    const version = await newestDirectory(pluginRoot);
    if (version) result.push({ path: path.join(version, "skills"), scope: "plugin", plugin: entry.plugin, recursive: true });
  }
  return result;
}

async function rootPlan() {
  const projects = await projectDirectories();
  if (provider === "claude") {
    const managed = process.platform === "darwin"
      ? "/Library/Application Support/ClaudeCode/skills"
      : process.platform === "win32"
        ? path.join(process.env.PROGRAMDATA || "C:\\ProgramData", "ClaudeCode", "skills")
        : "/etc/claude-code/skills";
    return {
      specs: [
        ...(isolatedAgentTest ? [] : [{ path: managed, scope: "admin", recursive: false }]),
        ...(isolatedAgentTest ? [] : [{ path: path.join(home, ".claude", "skills"), scope: "user", recursive: false }]),
        ...projects.map((dir) => ({ path: path.join(dir, ".claude", "skills"), scope: "project", projectBoundary: dir, recursive: false })),
        ...(await claudePluginRoots()),
      ].slice(0, maxRoots),
      targetOnly: isolatedAgentTest ? [] : [{ path: path.join(home, ".agents", "skills") }],
    };
  }

  if (provider === "codex") {
    const codexHome = process.env.CODEX_HOME && process.env.CODEX_HOME.trim()
      ? path.resolve(process.env.CODEX_HOME)
      : path.join(home, ".codex");
    return {
      specs: [
        ...projects.flatMap((dir) => [
          { path: path.join(dir, ".codex", "skills"), scope: "project", projectBoundary: dir, recursive: true },
          { path: path.join(dir, ".agents", "skills"), scope: "project", projectBoundary: dir, recursive: true },
        ]),
        ...(process.platform === "win32" || isolatedAgentTest ? [] : [{ path: "/etc/codex/skills", scope: "admin", recursive: true }]),
        { path: path.join(codexHome, "skills"), scope: "user", skip: [".system"], recursive: true },
        ...(isolatedAgentTest ? [] : [{ path: path.join(home, ".agents", "skills"), scope: "shared", recursive: true }]),
        { path: path.join(codexHome, "skills", ".system"), scope: "system", recursive: true },
        ...(await codexPluginRoots(codexHome)),
      ].slice(0, maxRoots),
      targetOnly: [],
    };
  }

  if (provider === "cursor") {
    const cursorHome = path.join(home, ".cursor");
    const cursorCodexHome = process.env.CODEX_HOME && process.env.CODEX_HOME.trim()
      ? path.resolve(process.env.CODEX_HOME)
      : path.join(home, ".codex");
    return {
      specs: [
        ...projects.flatMap((dir) => [
          { path: path.join(dir, ".cursor", "skills"), scope: "project", projectBoundary: dir, recursive: true },
          { path: path.join(dir, ".agents", "skills"), scope: "project", projectBoundary: dir, recursive: true },
          { path: path.join(dir, ".claude", "skills"), scope: "project", projectBoundary: dir, recursive: true },
          { path: path.join(dir, ".codex", "skills"), scope: "project", projectBoundary: dir, recursive: true },
        ]),
        { path: path.join(cursorHome, "skills"), scope: "user", recursive: true },
        { path: path.join(cursorHome, "skills-cursor"), scope: "system", recursive: true },
        ...(isolatedAgentTest ? [] : [
          { path: path.join(home, ".agents", "skills"), scope: "shared", recursive: true },
          { path: path.join(home, ".claude", "skills"), scope: "shared", recursive: true },
          { path: path.join(cursorCodexHome, "skills"), scope: "shared", skip: [".system"], recursive: true },
        ]),
      ].slice(0, maxRoots),
      targetOnly: [],
    };
  }

  if (provider === "pi") {
    return {
      specs: [
        ...projects.flatMap((dir) => [
          { path: path.join(dir, ".pi", "skills"), scope: "project", projectBoundary: dir, recursive: true },
          { path: path.join(dir, ".agents", "skills"), scope: "project", projectBoundary: dir, recursive: true },
          { path: path.join(dir, ".claude", "skills"), scope: "project", projectBoundary: dir, recursive: true },
        ]),
        { path: path.join(home, ".pi", "agent", "skills"), scope: "user", recursive: true },
        ...(isolatedAgentTest ? [] : [
          { path: path.join(home, ".agents", "skills"), scope: "shared", recursive: true },
          { path: path.join(home, ".claude", "skills"), scope: "shared", recursive: true },
        ]),
      ].slice(0, maxRoots),
      targetOnly: [],
    };
  }

  if (provider === "grok") {
    return {
      specs: [
        ...projects.flatMap((dir) => [
          { path: path.join(dir, ".grok", "skills"), scope: "project", projectBoundary: dir, recursive: true },
          { path: path.join(dir, ".agents", "skills"), scope: "project", projectBoundary: dir, recursive: true },
          { path: path.join(dir, ".claude", "skills"), scope: "project", projectBoundary: dir, recursive: true },
        ]),
        { path: path.join(home, ".grok", "skills"), scope: "user", recursive: true },
        ...(isolatedAgentTest ? [] : [
          { path: path.join(home, ".agents", "skills"), scope: "shared", recursive: true },
          { path: path.join(home, ".claude", "skills"), scope: "shared", recursive: true },
        ]),
      ].slice(0, maxRoots),
      targetOnly: [],
    };
  }

  const configHome = process.env.XDG_CONFIG_HOME && process.env.XDG_CONFIG_HOME.trim()
    ? path.join(path.resolve(process.env.XDG_CONFIG_HOME), "opencode")
    : path.join(home, ".config", "opencode");
  return {
    specs: [
      ...projects.flatMap((dir) => [
        { path: path.join(dir, ".claude", "skills"), scope: "project", projectBoundary: dir, recursive: true },
        { path: path.join(dir, ".agents", "skills"), scope: "project", projectBoundary: dir, recursive: true },
        { path: path.join(dir, ".opencode", "skills"), scope: "project", projectBoundary: dir, recursive: true },
        { path: path.join(dir, ".opencode", "skill"), scope: "project", projectBoundary: dir, recursive: true },
      ]),
      { path: path.join(configHome, "skills"), scope: "user", recursive: true },
      ...(isolatedAgentTest ? [] : [
        { path: path.join(home, ".claude", "skills"), scope: "shared", recursive: true },
        { path: path.join(home, ".agents", "skills"), scope: "shared", recursive: true },
      ]),
    ].slice(0, maxRoots),
    targetOnly: [],
  };
}

async function realpathIfPresent(target) {
  try { return await fsp.realpath(target); } catch { return undefined; }
}

async function preparePlan(plan, errors) {
  const prepared = plan.specs.map((spec) => ({ spec, realPath: undefined, blocked: false }));
  const trustedRoots = [];
  for (const entry of prepared) {
    if (entry.spec.projectBoundary) continue;
    entry.realPath = await realpathIfPresent(entry.spec.path);
    if (entry.realPath) trustedRoots.push(entry.realPath);
  }
  for (const target of plan.targetOnly) {
    const real = await realpathIfPresent(target.path);
    if (real) trustedRoots.push(real);
  }
  for (const entry of prepared) {
    if (!entry.spec.projectBoundary) continue;
    const [rootReal, boundaryReal] = await Promise.all([
      realpathIfPresent(entry.spec.path),
      realpathIfPresent(entry.spec.projectBoundary),
    ]);
    if (!rootReal) continue;
    const withinProject = boundaryReal ? inside(boundaryReal, rootReal) : false;
    const withinTrustedRoot = trustedRoots.some((root) => inside(root, rootReal));
    if (!withinProject && !withinTrustedRoot) {
      entry.blocked = true;
      errors.push({ path: displayPath(entry.spec.path), message: "Refusing a project skill root that resolves outside the project and trusted agent roots" });
      continue;
    }
    entry.realPath = rootReal;
  }
  const allowedRoots = [...new Set([...trustedRoots, ...prepared.flatMap((entry) => entry.realPath ? [entry.realPath] : [])])];
  return { prepared, allowedRoots };
}

async function authorizedRealPath(target, allowedRoots) {
  const real = await realpathIfPresent(target);
  if (!real) return undefined;
  return allowedRoots.some((root) => inside(root, real)) ? real : undefined;
}

/**
 * Whether a refused directory would have been listed as a skill.
 *
 * A skills root also holds ordinary subdirectories — a skill's own
 * "references", a symlinked scratch directory — and reporting every one of
 * those that points elsewhere would bury the refusals that actually cost the
 * user a skill. Only a directory carrying a SKILL.md is worth naming.
 */
async function holdsSkillFile(directory) {
  try {
    return (await fsp.stat(path.join(directory, "SKILL.md"))).isFile();
  } catch { return false; }
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

async function readSkillDirectory(spec, skillDir, allowedRoots, errors) {
  const filePath = path.join(skillDir, "SKILL.md");
  const realFile = await authorizedRealPath(filePath, allowedRoots);
  if (!realFile) {
    try {
      await fsp.lstat(filePath);
      errors.push({ path: displayPath(filePath), message: "Refusing a skill file that resolves outside trusted agent roots" });
    } catch {}
    return undefined;
  }
  let handle;
  try {
    handle = await fsp.open(filePath, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK);
    if (!(await handle.stat()).isFile()) return undefined;
    const buffer = Buffer.alloc(maxHeadBytes);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const meta = frontmatter(buffer.subarray(0, bytesRead).toString("utf8"));
    const baseName = (meta.name || path.basename(skillDir)).trim();
    const name = provider === "claude" && spec.plugin ? spec.plugin + ":" + baseName : baseName;
    return {
      id: filePath,
      name,
      description: meta.description || "",
      filePath,
      location: displayPath(skillDir),
      scope: spec.scope,
      ...(spec.plugin ? { plugin: spec.plugin } : {}),
      realPath: realFile,
    };
  } catch (error) {
    if (!error || error.code !== "ENOENT") errors.push({ path: displayPath(filePath), message: errorMessage(error) });
    return undefined;
  } finally {
    if (handle) try { await handle.close(); } catch {}
  }
}

async function scanRoot(entry, allowedRoots, errors) {
  const spec = entry.spec;
  const root = { path: spec.path, label: displayPath(spec.path), scope: spec.scope, ...(spec.plugin ? { plugin: spec.plugin } : {}), exists: false, skillCount: 0, truncated: false };
  if (entry.blocked) return { root, skills: [] };
  // Probe with stat, not opendir: local environments run this under Bun, where
  // opendir resolves for a missing directory and only fails once it is
  // iterated, so probing with opendir reported every absent root as present —
  // and disagreed with the container, which runs the same scan under Node.
  let rootStat;
  try {
    rootStat = await fsp.stat(spec.path);
  } catch (error) {
    if (!error || !["ENOENT", "ENOTDIR"].includes(error.code)) errors.push({ path: root.label, message: errorMessage(error) });
    return { root, skills: [] };
  }
  if (!rootStat.isDirectory()) return { root, skills: [] };
  root.exists = true;
  const skills = [];
  const stack = [{ directory: spec.path, depth: 0 }];
  const visited = new Set();
  let entriesRead = 0;

  while (stack.length > 0 && !root.truncated) {
    const current = stack.pop();
    const realDirectory = await authorizedRealPath(current.directory, allowedRoots);
    if (!realDirectory || visited.has(realDirectory)) continue;
    visited.add(realDirectory);
    let directory;
    try {
      directory = await fsp.opendir(current.directory);
      for await (const child of directory) {
        entriesRead += 1;
        if (entriesRead > maxEntriesPerRoot) { root.truncated = true; break; }
        if (current.depth === 0 && (spec.skip || []).includes(child.name)) continue;
        if (child.name.startsWith(".")) continue;
        if (!child.isDirectory() && !child.isSymbolicLink()) continue;
        const childPath = path.join(current.directory, child.name);
        const childReal = await realpathIfPresent(childPath);
        if (!childReal) continue;
        // A directory that leaves the trusted roots is refused, but silently
        // dropping it would leave the pane claiming a confident count while
        // omitting a skill the agent does load — the symlinked skill directory
        // is a routine layout, so the user has to be told which one went.
        if (!allowedRoots.some((trusted) => inside(trusted, childReal))) {
          if (await holdsSkillFile(childPath)) {
            errors.push({
              path: displayPath(path.join(childPath, "SKILL.md")),
              message: "Refusing a skill directory that resolves outside trusted agent roots",
            });
          }
          continue;
        }
        let childStat;
        try { childStat = await fsp.stat(childPath); } catch { continue; }
        if (!childStat.isDirectory()) continue;
        const skill = await readSkillDirectory(spec, childPath, allowedRoots, errors);
        if (skill) skills.push(skill);
        if (spec.recursive && current.depth + 1 < maxDepth && !visited.has(childReal)) {
          stack.push({ directory: childPath, depth: current.depth + 1 });
        }
      }
    } catch (error) {
      if (!error || !["ENOENT", "ENOTDIR"].includes(error.code)) errors.push({ path: displayPath(current.directory), message: errorMessage(error) });
    } finally {
      if (directory) try { await directory.close(); } catch {}
    }
  }
  return { root, skills };
}

function parseOpenCodeInput() {
  if (provider !== "opencode") return [];
  try {
    const raw = fs.readFileSync(0, "utf8");
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.slice(0, maxSkills) : [];
  } catch { return []; }
}

function matchingSpec(filePath, specs) {
  return specs
    .filter((entry) => inside(entry.spec.path, filePath))
    .sort((a, b) => b.spec.path.length - a.spec.path.length)[0];
}

async function listOpenCode(plan, preparedPlan, errors) {
  const catalog = parseOpenCodeInput();
  const rootMap = new Map();
  for (const entry of preparedPlan.prepared) {
    rootMap.set(entry.spec.path, {
      path: entry.spec.path,
      label: displayPath(entry.spec.path),
      scope: entry.spec.scope,
      exists: !!entry.realPath && !entry.blocked,
      skillCount: 0,
      truncated: false,
    });
  }
  const skills = [];
  const seenFiles = new Set();
  const cwdReal = await realpathIfPresent(cwd);
  for (const item of catalog) {
    if (!item || typeof item !== "object" || typeof item.location !== "string" || typeof item.name !== "string") continue;
    const normalized = path.normalize(item.location);
    if (!path.isAbsolute(normalized) || path.basename(normalized) !== "SKILL.md") continue;
    const realFile = await realpathIfPresent(normalized);
    if (!realFile || seenFiles.has(realFile)) continue;
    const known = matchingSpec(normalized, preparedPlan.prepared);
    if (known) {
      if (!preparedPlan.allowedRoots.some((root) => inside(root, realFile))) {
        errors.push({ path: displayPath(normalized), message: "Refusing a project skill file that resolves outside trusted agent roots" });
        continue;
      }
    } else if (inside(cwd, normalized) && (!cwdReal || !inside(cwdReal, realFile))) {
      errors.push({ path: displayPath(normalized), message: "Refusing a project-configured skill file that resolves outside the project" });
      continue;
    }
    seenFiles.add(realFile);
    const scope = known ? known.spec.scope : inside(cwd, normalized) ? "project" : "user";
    const rootPath = known ? known.spec.path : path.dirname(normalized);
    if (!rootMap.has(rootPath)) {
      rootMap.set(rootPath, { path: rootPath, label: displayPath(rootPath), scope, exists: true, skillCount: 0, truncated: false });
    }
    rootMap.get(rootPath).skillCount += 1;
    skills.push({
      id: normalized,
      name: item.name.trim(),
      description: typeof item.description === "string" ? Array.from(item.description).slice(0, 512).join("") : "",
      filePath: normalized,
      location: displayPath(path.dirname(normalized)),
      scope,
      shadowed: false,
    });
  }
  skills.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }) || a.location.localeCompare(b.location));
  return { provider, roots: [...rootMap.values()], skills, errors: errors.drain() };
}

async function list() {
  const plan = await rootPlan();
  const errors = createErrorSink();
  const preparedPlan = await preparePlan(plan, errors);
  if (provider === "opencode") return listOpenCode(plan, preparedPlan, errors);
  const results = [];
  for (const entry of preparedPlan.prepared) results.push(await scanRoot(entry, preparedPlan.allowedRoots, errors));
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
  const scopeOrder = ["admin", "user", "project", "shared", "system", "plugin"];
  skills.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }) || Number(a.shadowed) - Number(b.shadowed) || scopeOrder.indexOf(a.scope) - scopeOrder.indexOf(b.scope) || a.location.localeCompare(b.location));
  return { provider, roots: results.map((result) => result.root), skills, errors: errors.drain() };
}

async function readBounded(filePath) {
  const handle = await fsp.open(filePath, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK);
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
    return { path: filePath, content: buffer.subarray(0, Math.min(bytesRead, maxFileBytes)).toString("utf8"), truncated: bytesRead > maxFileBytes };
  } finally { await handle.close(); }
}

async function read() {
  if (!path.isAbsolute(requestedPath) || path.basename(path.normalize(requestedPath)) !== "SKILL.md") throw new Error("Expected an absolute SKILL.md path");
  const normalized = path.normalize(requestedPath);
  const plan = await rootPlan();
  // A read reports its refusal by throwing; the sink only exists because
  // preparePlan records blocked project roots on the way through.
  const errors = createErrorSink();
  const preparedPlan = await preparePlan(plan, errors);
  if (provider === "opencode") {
    const catalog = parseOpenCodeInput();
    const listed = catalog.some((item) => item && typeof item.location === "string" && path.normalize(item.location) === normalized);
    if (!listed) throw new Error("Refusing to read a file outside OpenCode's resolved skill catalogue");
    const realFile = await realpathIfPresent(normalized);
    if (!realFile) throw new Error("Skill file no longer exists");
    const known = matchingSpec(normalized, preparedPlan.prepared);
    if (known && !preparedPlan.allowedRoots.some((root) => inside(root, realFile))) {
      throw new Error("Refusing to read a skill file that resolves outside trusted agent roots");
    }
    const cwdReal = await realpathIfPresent(cwd);
    if (!known && inside(cwd, normalized) && (!cwdReal || !inside(cwdReal, realFile))) {
      throw new Error("Refusing to read a project-configured skill file that resolves outside the project");
    }
    return readBounded(normalized);
  }
  const lexical = matchingSpec(normalized, preparedPlan.prepared);
  if (!lexical || lexical.blocked) throw new Error("Refusing to read a file outside the environment's agent skill directories");
  const realFile = await authorizedRealPath(normalized, preparedPlan.allowedRoots);
  if (!realFile) throw new Error("Refusing to read a skill file that resolves outside trusted agent roots");
  return readBounded(normalized);
}

Promise.resolve(operation === "list" ? list() : operation === "read" ? read() : Promise.reject(new Error("Unknown skill operation")))
  .then((result) => process.stdout.write(JSON.stringify(result)))
  .catch((error) => { process.stderr.write(errorMessage(error)); process.exitCode = 1; });
`;
