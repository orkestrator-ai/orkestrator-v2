import type { McpServer } from "@modelcontextprotocol/server";
import {
  CREDENTIAL_HTTP_METHODS,
  CREDENTIAL_LIMITS,
  CREDENTIAL_TIMING,
  describeCredentialUse,
  type CredentialGrantRecord,
  type CredentialRequestRecord,
} from "@orkestrator/protocol/agent-credentials";
import { Schema } from "effect";
import { int, record, str, toolInput } from "../tool-schema.js";
import type { CredentialCaller } from "./access.js";
import type { CredentialOperationView } from "./operations.js";
import type { CredentialService } from "./service.js";

/**
 * The agent's credential tools (docs/architecture/agent-credentials.md,
 * "Agent tools"). Registered only on a tab-scoped connection: the tab is the
 * identity a grant binds to, so an environment-wide connection (OpenCode's
 * shared server) gets none of them.
 *
 * No tool returns a value. A grant is used through `run_with_credential` or
 * `http_request_with_credential`, which resolve it inside the backend.
 */

export type CredentialToolHost = Pick<
  CredentialService,
  | "requestAccess"
  | "getRequest"
  | "listCallerGrants"
  | "runCommand"
  | "httpRequest"
  | "getOperation"
  | "cancelOperation"
>;

export const CREDENTIAL_TOOL_INSTRUCTIONS =
  " When a task needs a secret (an API key, token or password), never ask the user to paste it into chat: call request_credential, wait for the person's decision, then use the grant with run_with_credential or http_request_with_credential. You never see the value.";

function result(value: Record<string, unknown>) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value) }],
    structuredContent: value,
  };
}

function grantView(grant: CredentialGrantRecord) {
  return {
    grantId: grant.id,
    label: grant.label,
    use: grant.use,
    allows: describeCredentialUse(grant),
    ...(grant.binding ? { binding: grant.binding } : {}),
    ...(grant.command !== undefined ? { command: grant.command } : {}),
    ...(grant.http ? { http: grant.http } : {}),
    expiresAt: new Date(grant.expiresAt).toISOString(),
    usesLeft: grant.maxUses === null ? null : Math.max(0, grant.maxUses - grant.uses),
    source:
      grant.source.kind === "connection" ? `saved: ${grant.source.connectionName}` : "temporary",
  };
}

function requestView(request: CredentialRequestRecord, grant: CredentialGrantRecord | null) {
  const next =
    request.state === "pending"
      ? "Waiting for a person to decide. Call get_credential_request with this requestId and waitSeconds to wait; do not ask again."
      : request.state === "granted" && grant
        ? grant.use === "http"
          ? "Granted. Call http_request_with_credential with this grantId."
          : `Granted. Call run_with_credential with this grantId; the command reads the value from $${grant.binding?.name ?? "the bound variable"}${grant.binding?.kind === "file" ? " (a file path)" : ""}.`
        : request.state === "declined"
          ? "The person declined. Do not ask again for the same thing unless they tell you to."
          : `The request is ${request.state}${request.reason ? `: ${request.reason}` : ""}.`;
  return {
    requestId: request.id,
    state: request.state,
    label: request.label,
    use: request.use,
    expiresAt: new Date(request.expiresAt).toISOString(),
    ...(grant ? { grant: grantView(grant) } : {}),
    next,
  };
}

function operationView(view: CredentialOperationView) {
  return {
    operationId: view.id,
    grantId: view.grantId,
    state: view.state,
    summary: view.summary,
    ...(view.exitCode !== undefined ? { exitCode: view.exitCode } : {}),
    ...(view.timedOut ? { timedOut: true } : {}),
    ...(view.httpStatus !== undefined ? { httpStatus: view.httpStatus } : {}),
    ...(view.stdout ? { stdout: view.stdout.text, stdoutTruncated: view.stdout.truncated } : {}),
    ...(view.stderr ? { stderr: view.stderr.text, stderrTruncated: view.stderr.truncated } : {}),
    ...(view.http ? { response: view.http } : {}),
    cleanup: view.cleanup,
    ...(view.error ? { error: view.error } : {}),
    ...(view.note ? { note: view.note } : {}),
  };
}

const seconds = (max: number) => Schema.optionalKey(int({ min: 0, max }));
const waitSeconds = seconds(Math.floor(CREDENTIAL_TIMING.waitMaxMs / 1000));
const waitMs = (value: number | undefined) =>
  value === undefined ? CREDENTIAL_TIMING.waitDefaultMs : value * 1000;

const NO_HINTS = { destructiveHint: false, openWorldHint: false } as const;

export function registerCredentialTools(
  server: McpServer,
  host: CredentialToolHost,
  caller: CredentialCaller,
): void {
  server.registerTool(
    "request_credential",
    {
      title: "Ask a person for a credential",
      description:
        "Ask the person to grant this task the use of a secret (API key, token, password). They choose a saved credential or enter one privately; you never see the value. use=command runs your commands with it in an environment variable (envVar) or a private file (delivery=file, envVar holds the path); give command to ask for one exact command only. use=http lets Orkestrator send HTTPS requests to the listed hosts with it attached (auth=bearer, header or basic). Waits up to waitSeconds for the decision.",
      inputSchema: toolInput(
        Schema.Struct({
          label: str({ trim: true, min: 1, max: CREDENTIAL_LIMITS.labelMaxChars }),
          purpose: str({ trim: true, min: 1, max: CREDENTIAL_LIMITS.purposeMaxChars }),
          use: Schema.Literals(["command", "http"]),
          envVar: Schema.optionalKey(str({ max: CREDENTIAL_LIMITS.bindingNameMaxChars })),
          delivery: Schema.optionalKey(Schema.Literals(["env", "file"])),
          command: Schema.optionalKey(str({ min: 1, max: CREDENTIAL_LIMITS.commandMaxChars })),
          hosts: Schema.optionalKey(Schema.Array(str({ max: CREDENTIAL_LIMITS.hostMaxChars + 6 }))),
          auth: Schema.optionalKey(Schema.Literals(["bearer", "header", "basic"])),
          header: Schema.optionalKey(str({ max: CREDENTIAL_LIMITS.headerNameMaxChars })),
          username: Schema.optionalKey(str({ max: CREDENTIAL_LIMITS.usernameMaxChars })),
          methods: Schema.optionalKey(Schema.Array(Schema.Literals(CREDENTIAL_HTTP_METHODS))),
          suggestedConnection: Schema.optionalKey(str({ max: CREDENTIAL_LIMITS.nameMaxChars })),
          waitSeconds,
        }),
      ),
      annotations: { readOnlyHint: false, idempotentHint: false, ...NO_HINTS },
    },
    async (input) => {
      const request = await host.requestAccess(caller, {
        label: input.label,
        purpose: input.purpose,
        use: input.use,
        bindingName: input.envVar,
        bindingKind: input.delivery,
        command: input.command,
        hosts: input.hosts,
        authScheme: input.auth,
        authHeader: input.header,
        authUsername: input.username,
        methods: input.methods,
        suggestedConnection: input.suggestedConnection,
      });
      const answer = await host.getRequest(caller, request.id, waitMs(input.waitSeconds));
      return result(requestView(answer.request, answer.grant));
    },
  );

  server.registerTool(
    "get_credential_request",
    {
      title: "Check a credential request",
      description:
        "The state of a credential request this tab made, waiting up to waitSeconds while a person decides. When granted, it returns the grantId to use.",
      inputSchema: toolInput(Schema.Struct({ requestId: str({ min: 1, max: 100 }), waitSeconds })),
      annotations: { readOnlyHint: true, idempotentHint: true, ...NO_HINTS },
    },
    async ({ requestId, waitSeconds: wait }) => {
      const answer = await host.getRequest(caller, requestId, waitMs(wait));
      return result(requestView(answer.request, answer.grant));
    },
  );

  server.registerTool(
    "list_credential_grants",
    {
      title: "List this tab's credential grants",
      description:
        "Credential grants this tab may still use, with what each allows and when it ends.",
      inputSchema: toolInput(Schema.Struct({})),
      annotations: { readOnlyHint: true, idempotentHint: true, ...NO_HINTS },
    },
    async () => result({ grants: host.listCallerGrants(caller).map(grantView) }),
  );

  server.registerTool(
    "run_with_credential",
    {
      title: "Run a command with a granted credential",
      description:
        'Run a shell command in this task\'s workspace with the granted credential in its environment variable (or private file). Never put the value in the command; refer to the variable, for example `npm publish` with NPM_TOKEN or `curl -H "Authorization: Bearer $API_TOKEN" ...`. Output is filtered for the value. Returns within waitSeconds; a longer run answers `running` with an operationId for get_credential_operation. Use an idempotencyKey so a retry after a lost answer does not run it twice.',
      inputSchema: toolInput(
        Schema.Struct({
          grantId: str({ min: 1, max: 100 }),
          command: str({ min: 1, max: CREDENTIAL_LIMITS.commandMaxChars }),
          timeoutSeconds: seconds(Math.floor(CREDENTIAL_TIMING.runMaxTimeoutMs / 1000)),
          idempotencyKey: Schema.optionalKey(
            str({ min: 1, max: CREDENTIAL_LIMITS.idempotencyKeyMaxChars }),
          ),
          waitSeconds,
        }),
      ),
      annotations: {
        readOnlyHint: false,
        idempotentHint: false,
        destructiveHint: true,
        openWorldHint: true,
      },
    },
    async (input) =>
      result(
        operationView(
          await host.runCommand(caller, {
            grantId: input.grantId,
            command: input.command,
            ...(input.timeoutSeconds !== undefined
              ? { timeoutMs: input.timeoutSeconds * 1000 }
              : {}),
            ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}),
            waitMs: waitMs(input.waitSeconds),
          }),
        ),
      ),
  );

  server.registerTool(
    "http_request_with_credential",
    {
      title: "Send an HTTPS request with a granted credential",
      description:
        "Orkestrator sends one HTTPS request to a host the grant allows, attaching the credential as the grant says (do not set Authorization yourself). Redirects are returned, not followed. The answer (status, a few headers, up to 128 KiB of body) is filtered for the value.",
      inputSchema: toolInput(
        Schema.Struct({
          grantId: str({ min: 1, max: 100 }),
          method: Schema.Literals(CREDENTIAL_HTTP_METHODS),
          url: str({ min: 1, max: 8_000 }),
          headers: Schema.optionalKey(record(Schema.String, str({ max: 4_096 }))),
          body: Schema.optionalKey(str({ max: CREDENTIAL_LIMITS.httpRequestBodyMaxBytes })),
          idempotencyKey: Schema.optionalKey(
            str({ min: 1, max: CREDENTIAL_LIMITS.idempotencyKeyMaxChars }),
          ),
        }),
      ),
      annotations: {
        readOnlyHint: false,
        idempotentHint: false,
        destructiveHint: true,
        openWorldHint: true,
      },
    },
    async (input) =>
      result(
        operationView(
          await host.httpRequest(caller, {
            grantId: input.grantId,
            method: input.method,
            url: input.url,
            ...(input.headers ? { headers: { ...input.headers } } : {}),
            ...(input.body !== undefined ? { body: input.body } : {}),
            ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}),
          }),
        ),
      ),
  );

  server.registerTool(
    "get_credential_operation",
    {
      title: "Check a credential operation",
      description:
        "The state and filtered output of a run_with_credential or http_request_with_credential call, waiting up to waitSeconds for it to finish. Use this after a `running` answer or a lost response instead of starting the work again.",
      inputSchema: toolInput(
        Schema.Struct({ operationId: str({ min: 1, max: 100 }), waitSeconds }),
      ),
      annotations: { readOnlyHint: true, idempotentHint: true, ...NO_HINTS },
    },
    async ({ operationId, waitSeconds: wait }) =>
      result(operationView(await host.getOperation(caller, operationId, waitMs(wait)))),
  );

  server.registerTool(
    "cancel_credential_operation",
    {
      title: "Stop a credential operation",
      description:
        "Cancels a reserved operation before dispatch, or requests cancellation of a running command or HTTPS request.",
      inputSchema: toolInput(Schema.Struct({ operationId: str({ min: 1, max: 100 }) })),
      annotations: { readOnlyHint: false, idempotentHint: true, ...NO_HINTS },
    },
    async ({ operationId }) =>
      result(operationView(await host.cancelOperation(caller, operationId))),
  );
}
