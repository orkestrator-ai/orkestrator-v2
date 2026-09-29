import path from "node:path";
import { defaultDataDir } from "../../../../../apps/backend/src/data-dir.js";
import { CliError } from "../errors.js";
import { keyValues, table } from "../format.js";
import type { CommandContext, CommandSpec, ParsedCommand } from "../spec.js";
import { stringOption } from "./common.js";

function dataDirectory(context: CommandContext, parsed: ParsedCommand): string {
  return path.resolve(
    stringOption(parsed.options, "data-dir") ??
      context.io.env.ORKESTRATOR_DATA_DIR ??
      defaultDataDir(process.platform, context.io.env),
  );
}

function requestedTools(parsed: ParsedCommand): string[] | undefined {
  const raw = parsed.options.tool;
  if (!Array.isArray(raw) || raw.length === 0) return undefined;
  // `--tool claude,codex` and `--tool claude --tool codex` are the same request.
  return raw.flatMap((value) => String(value).split(",")).filter((value) => value.length > 0);
}

export const toolchainCommands: CommandSpec[] = [
  {
    path: ["toolchain", "install"],
    summary: "Download and verify the pinned agent binaries for this host.",
    description: [
      "Installs the exact Claude, Codex, OpenCode, Grok and Pi versions this release pins,",
      "verifying every download against its pinned size and SHA-256 before it is used, into",
      "<data-dir>/toolchains. It is the step the desktop app performs at startup, for a",
      "backend that runs without it. Safe to repeat: verified installs are reused.",
      "",
      "Which tools are installed follows the data directory's enabled agent platforms",
      "(config.json `enabledAgentPlatforms`); a directory nobody has configured gets all of",
      "them. Name tools with --tool to override.",
      "",
      "On success `toolchains/bin/current` points at the installed set, and `orkestrator",
      "serve` uses it by default for the same data directory. Restart a running service to",
      "pick up a new set.",
    ].join("\n"),
    positionals: [],
    options: [
      {
        name: "tool",
        kind: "list",
        valueName: "NAME",
        description:
          "Install exactly these tools (claude, codex, opencode, grok, pi); repeatable or comma-separated. The installed set becomes this list, so tools left out stop being found after a restart.",
      },
      {
        name: "data-dir",
        kind: "string",
        valueName: "DIR",
        description:
          "Backend data directory. Defaults to ORKESTRATOR_DATA_DIR, then the platform default the service uses.",
      },
      {
        name: "dry-run",
        kind: "boolean",
        description: "Show what would be installed without downloading anything.",
      },
    ],
    local: true,
    idOutput: "toolchain bin directory",
    examples: [
      "orkestrator toolchain install",
      "orkestrator toolchain install --tool claude --tool codex",
      "orkestrator toolchain install --dry-run --json",
      'ORKESTRATOR_TOOLCHAIN_BIN="$(orkestrator toolchain install --output id)" orkestrator serve',
    ],
    async run(context, parsed) {
      const dataDir = dataDirectory(context, parsed);
      const tools = requestedTools(parsed);
      const installer = await import("@orkestrator/toolchain/install");
      const unknown = (tools ?? []).filter((tool) => !installer.isToolchainName(tool));
      if (unknown.length > 0) {
        throw new CliError("invalid-input", `Unknown tool: ${unknown.join(", ")}`, {
          details: { tools: unknown },
        });
      }

      if (parsed.options["dry-run"] === true) {
        const plan = await installer.planToolchainInstall({ dataDir, ...(tools ? { tools } : {}) });
        const rows = plan.artifacts.map((artifact) => ({
          tool: artifact.name,
          version: artifact.version,
        }));
        return {
          action: "toolchain.install",
          result: { dryRun: true, dataDir, source: plan.source, tools: rows },
          human: [
            ...keyValues([
              ["data directory", dataDir],
              ["selection", plan.source],
            ]),
            "",
            ...table(
              ["TOOL", "VERSION"],
              rows.map((row) => [row.tool, row.version]),
            ),
            "",
            "Dry run: nothing was downloaded.",
          ],
        };
      }

      let installed: Awaited<ReturnType<typeof installer.installPinnedToolchains>>;
      try {
        installed = await installer.installPinnedToolchains({
          dataDir,
          ...(tools ? { tools } : {}),
          // Diagnostics belong on stderr so `--output id` and `--json` stay clean.
          onProgress: installer.createProgressLogger((line) => context.io.stderr(`${line}\n`)),
        });
      } catch (error) {
        throw new CliError(
          "operation-failed",
          error instanceof Error ? error.message : "Toolchain install failed",
          { retryable: true },
        );
      }

      const rows = installed.tools.map((tool) => ({
        tool,
        version: installed.versions[tool] ?? "",
        // Through `current`, the path a backend resolves, rather than the
        // digest-named set directory behind it.
        executable: path.join(installed.currentBinDir, path.basename(installed.executables[tool])),
      }));
      return {
        action: "toolchain.install",
        result: {
          dryRun: false,
          dataDir: installed.dataDir,
          source: installed.source,
          binDir: installed.binDir,
          currentBinDir: installed.currentBinDir,
          tools: rows,
        },
        ids: [installed.currentBinDir],
        ...(installed.dropped.length > 0
          ? {
              warnings: [
                `This set no longer includes: ${installed.dropped.join(", ")}. A backend restarted now will not find them; run \`orkestrator toolchain install\` without --tool to restore them.`,
              ],
            }
          : {}),
        human: [
          ...table(
            ["TOOL", "VERSION", "EXECUTABLE"],
            rows.map((row) => [row.tool, row.version, row.executable]),
          ),
          "",
          `Installed into ${installed.currentBinDir}`,
          "`orkestrator serve` uses this directory for this data directory by default;",
          "restart a running service to pick up a new set, or set ORKESTRATOR_TOOLCHAIN_BIN.",
        ],
      };
    },
  },
];
