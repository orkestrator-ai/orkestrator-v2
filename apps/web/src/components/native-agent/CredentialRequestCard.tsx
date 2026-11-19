import { useMemo, useState } from "react";
import { KeyRound, ShieldAlert } from "lucide-react";
import {
  CREDENTIAL_DEFAULT_GRANT_LIFETIME_MS,
  CREDENTIAL_LIMITS,
  CREDENTIAL_TIMING,
  credentialValueProblem,
  normalizeCredentialHosts,
  type CredentialConnection,
  type CredentialRequestRecord,
  type CredentialTabSnapshot,
} from "@orkestrator/protocol/agent-credentials";
import { BlockingPromptCard } from "@/components/chat/BlockingPromptCard";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";
import { backendForScope } from "@/lib/backend/scope-backend";
import { isAppCommandScope } from "@/lib/node-scope-slots";
import { useNodeScope } from "@/lib/node-scope/providers";

/**
 * An agent's request to use a credential, pinned above the composer of the
 * tab that asked (docs/architecture/agent-credentials.md, "The in-task card").
 *
 * The person picks a saved connection or types a value. A typed value lives
 * only in this component's state: it is not a draft, it is cleared once sent,
 * and it is gone when the card unmounts. It goes to the backend in the
 * approval command and nowhere else; the agent gets a grant, never the value.
 *
 * The request's label and purpose are the agent's words and are shown as
 * such. What the grant actually allows is described from the request's
 * structured fields, which the backend enforces.
 */

const LIFETIME_LABELS = new Map<number, string>([
  [15 * 60_000, "15 minutes"],
  [60 * 60_000, "1 hour"],
  [4 * 60 * 60_000, "4 hours"],
  [8 * 60 * 60_000, "8 hours"],
]);

function lifetimeLabel(ms: number): string {
  return LIFETIME_LABELS.get(ms) ?? `${Math.round(ms / 60_000)} minutes`;
}

function errorMessage(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  // Codes lead the message ("SCOPE_MISMATCH: …"); the sentence is what a person reads.
  return text.replace(/^[A-Z_]+: /u, "") || "The request could not be answered.";
}

function hostsCovered(connection: CredentialConnection, hosts: readonly string[]): boolean {
  const allowed = normalizeCredentialHosts(connection.httpHosts);
  const requested = normalizeCredentialHosts(hosts);
  return Boolean(allowed && requested?.every((host) => allowed.includes(host)));
}

export interface CredentialRequestCardProps {
  request: CredentialRequestRecord;
  connections: CredentialConnection[];
  vault: CredentialTabSnapshot["vault"];
  /** Re-reads the tab's snapshot after an answer. */
  onAnswered?: () => void;
}

export function CredentialRequestCard({
  request,
  connections,
  vault,
  onAnswered,
}: CredentialRequestCardProps) {
  const scope = useNodeScope();
  // Approving is an `admin` command: on another node it goes through the command node.
  const machine = isAppCommandScope(scope) ? undefined : scope.nodeId;
  const usable = useMemo(
    () =>
      connections.filter(
        (connection) =>
          connection.status === "ready" &&
          (request.use !== "http" || hostsCovered(connection, request.http?.hosts ?? [])),
      ),
    [connections, request.use, request.http?.hosts],
  );
  const suggested = usable.find(
    (connection) =>
      request.suggestedConnection &&
      connection.name.toLowerCase() === request.suggestedConnection.toLowerCase(),
  );
  const [chosenMode, setMode] = useState<"connection" | "value">(
    usable.length > 0 ? "connection" : "value",
  );
  const [chosenConnectionId, setConnectionId] = useState<string>(
    suggested?.id ?? usable[0]?.id ?? "",
  );
  const connectionId = usable.some((each) => each.id === chosenConnectionId)
    ? chosenConnectionId
    : "";
  if (chosenConnectionId && !connectionId) setConnectionId("");
  const mode = chosenMode;
  const showSavedChoice = usable.length > 0 || mode === "connection";
  const [value, setValue] = useState("");
  const [save, setSave] = useState(false);
  const [saveName, setSaveName] = useState(request.suggestedConnection ?? request.label);
  const [lifetimeMs, setLifetimeMs] = useState<number>(CREDENTIAL_DEFAULT_GRANT_LIFETIME_MS);
  const [once, setOnce] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const valueProblem = mode === "value" && value ? credentialValueProblem(value) : null;
  const canApprove =
    !busy &&
    (mode === "connection"
      ? Boolean(connectionId)
      : value.length > 0 && valueProblem === null && (!save || saveName.trim().length > 0));

  const run = async (work: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await work();
      setValue("");
      onAnswered?.();
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setBusy(false);
    }
  };

  const approve = () =>
    run(() =>
      backendForScope(scope).approveCredentialRequest(
        {
          requestId: request.id,
          revision: request.revision,
          source:
            mode === "connection"
              ? { kind: "connection", connectionId }
              : {
                  kind: "value",
                  value,
                  ...(save && vault.canSave ? { saveAs: { name: saveName.trim() } } : {}),
                },
          lifetimeMs,
          ...(once ? { maxUses: 1 } : {}),
        },
        machine,
      ),
    );

  const decline = () =>
    run(() =>
      backendForScope(scope).declineCredentialRequest(
        { requestId: request.id, revision: request.revision },
        machine,
      ),
    );

  const httpHosts = request.http?.hosts ?? [];
  const missingHostConnections = request.use === "http" && connections.length > usable.length;

  return (
    <BlockingPromptCard
      data-testid="credential-request-card"
      state={busy ? "submitting" : error ? "retryable-error" : "pending"}
      error={error}
      icon={<KeyRound className="size-4" />}
      title={request.label}
      meta="Credential request"
      description={<span className="whitespace-pre-wrap break-words">{request.purpose}</span>}
      expiresAt={request.expiresAt}
      arrivalAnnouncement={`The agent asks to use a credential: ${request.label}.`}
      aria-label={`Credential request: ${request.label}`}
      actions={
        <>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={busy}
            onClick={() => void decline()}
          >
            Decline
          </Button>
          <Button type="button" size="sm" disabled={!canApprove} onClick={() => void approve()}>
            Allow
          </Button>
        </>
      }
    >
      <div className="space-y-3 px-4 py-3 text-xs">
        {request.use === "command" ? (
          <div className="space-y-1.5">
            <p className="flex items-start gap-1.5 text-amber-200">
              <ShieldAlert className="mt-px size-3.5 shrink-0" aria-hidden />
              <span>
                Code running in this task will be able to read this credential. Orkestrator filters
                it from the output the agent sees, but the code itself can copy it.
              </span>
            </p>
            <p className="text-muted-foreground">
              Delivered{" "}
              {request.binding?.kind === "file" ? (
                <>
                  in a private file whose path is{" "}
                  <code className="font-mono text-foreground">${request.binding.name}</code>
                </>
              ) : (
                <>
                  as <code className="font-mono text-foreground">${request.binding?.name}</code>
                </>
              )}
              {request.command === undefined
                ? " to commands the agent runs in this task."
                : " to this command only:"}
            </p>
            {request.command !== undefined ? (
              <pre className="max-h-32 overflow-auto whitespace-pre-wrap break-all rounded border border-border/40 bg-black/20 p-2 font-mono text-[11px] text-foreground">
                {request.command}
              </pre>
            ) : null}
          </div>
        ) : (
          <div className="space-y-1">
            <p className="text-muted-foreground">
              Orkestrator sends HTTPS requests for the agent with this credential attached (
              {request.http?.auth.scheme === "header"
                ? `as the ${request.http.auth.header} header`
                : request.http?.auth.scheme === "basic"
                  ? `as basic auth for ${request.http.auth.username}`
                  : "as a bearer token"}
              ) to:
            </p>
            <p className="break-all font-mono text-foreground">{httpHosts.join(", ")}</p>
            {request.http?.methods ? (
              <p className="text-muted-foreground">Methods: {request.http.methods.join(", ")}</p>
            ) : null}
            <p className="text-muted-foreground">The agent never receives the value.</p>
          </div>
        )}

        <fieldset className="space-y-2" disabled={busy}>
          <legend className="sr-only">Credential to use</legend>
          {showSavedChoice ? (
            <div className="flex items-center gap-2">
              <label className="flex shrink-0 items-center gap-2">
                <input
                  type="radio"
                  name={`credential-source-${request.id}`}
                  checked={mode === "connection"}
                  onChange={() => setMode("connection")}
                />
                <span>Saved credential</span>
              </label>
              <NativeSelect
                size="sm"
                aria-label="Saved credential to use"
                wrapperClassName="min-w-0 flex-1"
                value={connectionId}
                disabled={mode !== "connection" || usable.length === 0}
                onChange={(event) => setConnectionId(event.target.value)}
              >
                {!connectionId ? (
                  <option value="" disabled>
                    Choose a saved credential
                  </option>
                ) : null}
                {usable.map((connection) => (
                  <option key={connection.id} value={connection.id}>
                    {connection.name}
                  </option>
                ))}
              </NativeSelect>
            </div>
          ) : null}
          {missingHostConnections ? (
            <p className="text-muted-foreground">
              Saved credentials whose allowed hosts do not include {httpHosts.join(", ")} are not
              offered. Add the hosts in Settings → Credentials to use one.
            </p>
          ) : null}
          <label className="flex items-center gap-2">
            {showSavedChoice ? (
              <input
                type="radio"
                name={`credential-source-${request.id}`}
                checked={mode === "value"}
                onChange={() => setMode("value")}
              />
            ) : null}
            <span className="shrink-0">Enter a value</span>
            <Input
              type="password"
              autoComplete="off"
              spellCheck={false}
              aria-label="Credential value"
              className="h-8 min-w-0 flex-1 text-xs"
              maxLength={CREDENTIAL_LIMITS.valueMaxBytes}
              value={value}
              onFocus={() => setMode("value")}
              onChange={(event) => setValue(event.target.value)}
            />
          </label>
          {mode === "value" ? (
            <div className="space-y-1.5 pl-1">
              {valueProblem ? <p className="text-destructive">{valueProblem}</p> : null}
              <p className="text-[11px] text-muted-foreground">
                The value is sent exactly as typed and is not kept in this window.
              </p>
              {vault.canSave ? (
                <label className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={save}
                    onChange={(event) => setSave(event.target.checked)}
                  />
                  <span className="shrink-0">Also save it as</span>
                  <Input
                    aria-label="Saved credential name"
                    className="h-7 min-w-0 flex-1 text-xs"
                    disabled={!save}
                    maxLength={CREDENTIAL_LIMITS.nameMaxChars}
                    value={saveName}
                    onChange={(event) => setSaveName(event.target.value)}
                  />
                </label>
              ) : (
                <p className="text-[11px] text-muted-foreground">{vault.detail}</p>
              )}
              {save && vault.canSave && vault.durable === "file" ? (
                <p className="text-[11px] text-muted-foreground">{vault.detail}</p>
              ) : null}
            </div>
          ) : null}
        </fieldset>

        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <label className="flex items-center gap-2">
            <span>For</span>
            <NativeSelect
              size="sm"
              aria-label="Access lifetime"
              value={String(lifetimeMs)}
              disabled={busy}
              onChange={(event) => setLifetimeMs(Number(event.target.value))}
            >
              {CREDENTIAL_TIMING.grantLifetimeChoicesMs.map((choice) => (
                <option key={choice} value={choice}>
                  {lifetimeLabel(choice)}
                </option>
              ))}
            </NativeSelect>
          </label>
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={once}
              disabled={busy}
              onChange={(event) => setOnce(event.target.checked)}
            />
            <span>Allow one use only</span>
          </label>
        </div>
      </div>
    </BlockingPromptCard>
  );
}

/** The pending requests of a snapshot, oldest first. */
export function pendingCredentialRequests(
  snapshot: CredentialTabSnapshot | null,
  now = Date.now(),
): CredentialRequestRecord[] {
  return (snapshot?.requests ?? []).filter(
    (request) => request.state === "pending" && request.expiresAt > now,
  );
}
