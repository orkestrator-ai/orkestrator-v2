/**
 * `download_linear_files`: how an agent gets the files of a Linear issue.
 *
 * Listed on an environment's general server and on a build stage turn's
 * workflow-result server, when the caller's build came from Linear or its
 * project has a linked Linear board. {@link LinearFileService} resolves that
 * scope from the environment and, for workflow tools, the authenticated attempt.
 */
import type { McpServer } from "@modelcontextprotocol/server";
import {
  LINEAR_FILE_TOOL_NAME,
  LINEAR_FILES_DIRECTORY,
  MAX_LINEAR_ISSUE_FILES,
} from "@orkestrator/protocol/linear-files";
import { Schema } from "effect";
import { describe, list, str, toolInput } from "../tool-schema.js";
import type { LinearFileScope, LinearFileService, LinearFileDownloadGrant } from "./service.js";

export type LinearFileToolHost = Pick<LinearFileService, "offered" | "download">;

export async function registerLinearFileTool(
  server: McpServer,
  host: LinearFileToolHost,
  scope: LinearFileScope,
  holdGrant?: () => (LinearFileDownloadGrant & { release(): void }) | null,
): Promise<boolean> {
  if (!(await host.offered(scope).catch(() => false))) return false;
  server.registerTool(
    LINEAR_FILE_TOOL_NAME,
    {
      title: "Download a Linear issue's files",
      description: `Download the files a Linear issue refers to (uploads.linear.app links in its description, comments and attachments) into this workspace, under ${LINEAR_FILES_DIRECTORY}/ (Git-excluded). Those links need Linear sign-in, which Orkestrator has: use this rather than fetching them yourself or asking for a credential. Returns each file's path, and why any could not be downloaded.`,
      inputSchema: toolInput(
        Schema.Struct({
          issueId: Schema.optionalKey(
            describe(
              str({ trim: true, min: 1, max: 200 }),
              "Id or identifier (ENG-123) of an issue on this project's Linear board. Omit for the issue the current build was started from.",
            ),
          ),
          urls: Schema.optionalKey(
            describe(
              list(str({ trim: true, min: 1, max: 2_000 }), { max: MAX_LINEAR_ISSUE_FILES }),
              "Only these of the issue's files. Omit for all of them.",
            ),
          ),
        }),
      ),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ issueId, urls }) => {
      const grant = holdGrant?.();
      if (holdGrant && !grant) throw new Error("Linear file download capability denied.");
      try {
        const value = {
          ...(await host.download(
            scope,
            {
              ...(issueId ? { issueId } : {}),
              ...(urls ? { urls: [...urls] } : {}),
            },
            undefined,
            grant ?? undefined,
          )),
        };
        return {
          content: [{ type: "text" as const, text: JSON.stringify(value) }],
          structuredContent: value as unknown as Record<string, unknown>,
        };
      } finally {
        grant?.release();
      }
    },
  );
  return true;
}
