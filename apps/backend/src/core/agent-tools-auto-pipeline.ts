/**
 * `convert_to_pipeline`: how an interactive agent tab hands its own work to
 * Auto-pipeline (`auto-pipeline.ts`).
 *
 * It is listed on the general `orkestrator` server, to a tab-scoped credential
 * only, and only while the tab is an open interactive agent tab of a prompt
 * environment that belongs to no pipeline. The toolbar's "To pipeline" button
 * merely sends the tab a message asking it to call this, so asking for a
 * pipeline in plain chat takes exactly the same path.
 *
 * The tool records a draft for the user to review. It never creates a ticket or
 * starts a pipeline: confirming is the user's click in the Auto-pipeline tab.
 */
import { fromJsonSchema, type JsonSchemaType, type McpServer } from "@modelcontextprotocol/server";
import {
  AUTO_PIPELINE_TOOL_NAME,
  autoPipelineResultSchema,
} from "@orkestrator/protocol/build-pipeline";
import { ACCEPTANCE_CRITERIA_RULE } from "@orkestrator/protocol/ticket-sections";

/** What the agent tool server needs from Auto-pipeline. */
export interface AutoPipelineToolHost {
  /** Whether the tab may be offered the tool; read-only, asked on every MCP request. */
  offered(scope: AutoPipelineToolScope): Promise<boolean>;
  submit(scope: AutoPipelineToolScope, result: unknown): Promise<{ draftId: string }>;
}
export interface AutoPipelineToolScope {
  environmentId: string;
  tabId: string;
}

// Process-wide on purpose: compiled once from a constant schema, because the
// server is rebuilt for every request.
let inputSchema: ReturnType<typeof fromJsonSchema> | undefined;
function resultInput() {
  inputSchema ??= fromJsonSchema(autoPipelineResultSchema as unknown as JsonSchemaType);
  return inputSchema;
}

const MAX_MESSAGE_CHARS = 500;
function failure(error: unknown) {
  const message =
    (error instanceof Error ? error.message : String(error)).trim().slice(0, MAX_MESSAGE_CHARS) ||
    "The draft could not be saved";
  const value = { ok: false, message };
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value) }],
    structuredContent: value,
  };
}

export function registerAutoPipelineTool(
  server: McpServer,
  host: AutoPipelineToolHost,
  scope: AutoPipelineToolScope,
): void {
  server.registerTool(
    AUTO_PIPELINE_TOOL_NAME,
    {
      title: "Convert this conversation into a pipeline",
      description:
        "Use only when the user asks you to turn this conversation, or the work in this environment, into a pipeline: a ticket plus the finished Build handoff, continuing from Review through verification and delivery. " +
        `Work from your own record of this session and from the repository (git status, git diff, git log). Description needs Summary, Problem and Context sections; every acceptance criterion is one independently checkable line (${ACCEPTANCE_CRITERIA_RULE}); notes record only what you observed. ` +
        "This saves a draft for the user to review and edit. Nothing is created or started until they confirm it in the Auto-pipeline tab, so tell them it is ready and stop. Calling it again replaces the unconfirmed draft.",
      inputSchema: resultInput(),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async (result: unknown) => {
      try {
        const { draftId } = await host.submit(scope, result);
        const value = {
          ok: true,
          draftId,
          message:
            "Draft saved. Tell the user it is ready to review in the Auto-pipeline tab; nothing starts until they confirm.",
        };
        return {
          content: [{ type: "text" as const, text: JSON.stringify(value) }],
          structuredContent: value,
        };
      } catch (error) {
        return failure(error);
      }
    },
  );
}
