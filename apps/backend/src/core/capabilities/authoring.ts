/**
 * User-authored packages (docs/architecture/agent-capabilities-management.md,
 * "Custom authoring"): a skill, a command or prompt, a subagent, a hook
 * manifest or an MCP definition written in the editor, or a folder the
 * browser uploaded. The result is an ordinary file tree that goes through
 * the same inspection, secret scan and approval as any other source.
 *
 * A hook's preview always names its trigger and the exact command it runs;
 * an MCP definition keeps environment *keys* only.
 */
import { CAPABILITY_LIMITS } from "@orkestrator/protocol/capability-resources";

import { CapabilityError, validatePackageFiles, type PackageFile } from "./security.js";

export const AUTHORED_KINDS = [
  "skill",
  "command",
  "prompt",
  "subagent",
  "hook",
  "mcp-server",
  "upload",
] as const;
export type AuthoredKind = (typeof AUTHORED_KINDS)[number];

export interface AuthoredInput {
  kind: AuthoredKind;
  name: string;
  description?: string;
  content?: string;
  files?: Array<{
    path: string;
    content: string;
    encoding?: "utf8" | "base64";
    executable?: boolean;
  }>;
  hook?: { trigger: string; matcher?: string; command: string };
  mcp?: {
    transport: "stdio" | "http" | "sse";
    command?: string;
    args?: string[];
    url?: string;
    envKeys?: string[];
  };
}

const NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;
const HOOK_TRIGGERS = new Set([
  "PreToolUse",
  "PostToolUse",
  "UserPromptSubmit",
  "Notification",
  "Stop",
  "SubagentStop",
  "SessionStart",
  "SessionEnd",
  "PreCompact",
]);

function yamlScalar(value: string): string {
  return JSON.stringify(
    value.replace(/\r?\n/g, " ").slice(0, CAPABILITY_LIMITS.maxDescriptionChars),
  );
}

function frontmatter(name: string, description: string | undefined): string {
  return `---\nname: ${name}\ndescription: ${yamlScalar(description || name)}\n---\n\n`;
}

export function parseAuthoredInput(value: Record<string, unknown>): AuthoredInput {
  const kind = value.kind;
  if (!(AUTHORED_KINDS as readonly unknown[]).includes(kind)) {
    throw new CapabilityError("invalid-request", "Choose what to create.");
  }
  const name = typeof value.name === "string" ? value.name.trim().toLowerCase() : "";
  if (!NAME.test(name)) {
    throw new CapabilityError(
      "invalid-request",
      "Names are lower-case letters, digits and dashes.",
    );
  }
  const description =
    typeof value.description === "string"
      ? value.description.slice(0, CAPABILITY_LIMITS.maxDescriptionChars)
      : undefined;
  const content = typeof value.content === "string" ? value.content : undefined;
  if (content !== undefined && content.length > CAPABILITY_LIMITS.maxFileBytes) {
    throw new CapabilityError("too-large", "The content is too large.");
  }
  const files = Array.isArray(value.files)
    ? value.files.slice(0, CAPABILITY_LIMITS.maxPackageFiles + 1).map((entry: unknown) => {
        const file = entry as Record<string, unknown>;
        if (typeof file?.path !== "string" || typeof file.content !== "string") {
          throw new CapabilityError(
            "invalid-request",
            "Every uploaded file needs a path and content.",
          );
        }
        return {
          path: file.path,
          content: file.content,
          ...(file.encoding === "base64" ? { encoding: "base64" as const } : {}),
          ...(file.executable === true ? { executable: true } : {}),
        };
      })
    : undefined;
  const hookValue = value.hook as Record<string, unknown> | undefined;
  const hook =
    hookValue && typeof hookValue.trigger === "string" && typeof hookValue.command === "string"
      ? {
          trigger: hookValue.trigger,
          command: hookValue.command.slice(0, 1_000),
          ...(typeof hookValue.matcher === "string"
            ? { matcher: hookValue.matcher.slice(0, 200) }
            : {}),
        }
      : undefined;
  const mcpValue = value.mcp as Record<string, unknown> | undefined;
  const mcp =
    mcpValue &&
    (mcpValue.transport === "stdio" ||
      mcpValue.transport === "http" ||
      mcpValue.transport === "sse")
      ? {
          transport: mcpValue.transport as "stdio" | "http" | "sse",
          ...(typeof mcpValue.command === "string"
            ? { command: mcpValue.command.slice(0, 500) }
            : {}),
          ...(Array.isArray(mcpValue.args)
            ? {
                args: mcpValue.args
                  .filter((arg): arg is string => typeof arg === "string")
                  .slice(0, 64),
              }
            : {}),
          ...(typeof mcpValue.url === "string" ? { url: mcpValue.url.slice(0, 2_000) } : {}),
          ...(Array.isArray(mcpValue.envKeys)
            ? {
                envKeys: mcpValue.envKeys
                  .filter(
                    (key): key is string =>
                      typeof key === "string" && /^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(key),
                  )
                  .slice(0, 32),
              }
            : {}),
        }
      : undefined;
  return {
    kind: kind as AuthoredKind,
    name,
    ...(description ? { description } : {}),
    ...(content !== undefined ? { content } : {}),
    ...(files ? { files } : {}),
    ...(hook ? { hook } : {}),
    ...(mcp ? { mcp } : {}),
  };
}

/** The package file tree for an authored input. */
export function authoredFiles(input: AuthoredInput): PackageFile[] {
  const body = input.content ?? "";
  switch (input.kind) {
    case "skill": {
      const text = body.startsWith("---")
        ? body
        : `${frontmatter(input.name, input.description)}${body}`;
      return validatePackageFiles([
        { path: "SKILL.md", content: Buffer.from(text) },
        ...(input.files ?? []).map(uploaded),
      ]);
    }
    case "command":
    case "prompt":
    case "subagent": {
      const directory =
        input.kind === "command" ? "commands" : input.kind === "prompt" ? "prompts" : "agents";
      const text = body.startsWith("---")
        ? body
        : `${frontmatter(input.name, input.description)}${body}`;
      return validatePackageFiles([
        { path: `${directory}/${input.name}.md`, content: Buffer.from(text) },
      ]);
    }
    case "hook": {
      if (
        !input.hook ||
        !HOOK_TRIGGERS.has(input.hook.trigger) ||
        input.hook.command.trim().length === 0
      ) {
        throw new CapabilityError(
          "invalid-request",
          "A hook needs a known trigger and the command it runs.",
        );
      }
      const manifest = {
        description: input.description ?? input.name,
        hooks: {
          [input.hook.trigger]: [
            {
              ...(input.hook.matcher ? { matcher: input.hook.matcher } : {}),
              hooks: [{ type: "command", command: input.hook.command }],
            },
          ],
        },
      };
      return validatePackageFiles([
        {
          path: "hooks/hooks.json",
          content: Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`),
        },
      ]);
    }
    case "mcp-server": {
      const mcp = input.mcp;
      if (!mcp || (mcp.transport === "stdio" ? !mcp.command : !mcp.url)) {
        throw new CapabilityError(
          "invalid-request",
          "An MCP server needs a command (stdio) or an address (HTTP).",
        );
      }
      const definition: Record<string, unknown> = {
        ...(mcp.transport === "stdio"
          ? { command: mcp.command, args: mcp.args ?? [] }
          : { type: mcp.transport, url: mcp.url }),
        ...(mcp.envKeys?.length
          ? { env: Object.fromEntries(mcp.envKeys.map((key) => [key, `\${${key}}`])) }
          : {}),
      };
      return validatePackageFiles([
        {
          path: ".mcp.json",
          content: Buffer.from(
            `${JSON.stringify({ mcpServers: { [input.name]: definition } }, null, 2)}\n`,
          ),
        },
      ]);
    }
    case "upload": {
      if (!input.files || input.files.length === 0) {
        throw new CapabilityError("invalid-request", "Choose a folder or file to upload.");
      }
      // A folder upload arrives with its folder name first; strip a single shared top level.
      const tops = new Set(input.files.map((file) => file.path.split("/")[0]));
      const strip = tops.size === 1 && input.files.every((file) => file.path.includes("/"));
      return validatePackageFiles(
        input.files.map((file) =>
          uploaded(strip ? { ...file, path: file.path.split("/").slice(1).join("/") } : file),
        ),
      );
    }
  }
}

function uploaded(file: {
  path: string;
  content: string;
  encoding?: "utf8" | "base64";
  executable?: boolean;
}) {
  return {
    path: file.path,
    content:
      file.encoding === "base64" ? Buffer.from(file.content, "base64") : Buffer.from(file.content),
    executable: file.executable === true,
  };
}
