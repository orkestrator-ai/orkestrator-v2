import { useMemo, useState } from "react";
import { ExternalLink } from "lucide-react";
import { toast } from "sonner";
import { BlockingPromptCard } from "@/components/chat/BlockingPromptCard";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { openInBrowser } from "@/lib/backend";
import {
  fetchPendingInteractions,
  respondToInteraction,
  type CodexClient,
  type CodexInteraction,
} from "@/lib/codex-client";
import { useCodexStore } from "@/stores/codexStore";
import {
  codexInteractionDraftKey,
  usePromptDraftField,
} from "@/stores/promptDraftStore";
import { CodexQuestionCard } from "./CodexQuestionCard";

interface CodexInteractionCardProps {
  interaction: CodexInteraction;
  client: CodexClient;
  sessionId: string;
  sessionKey: string;
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

/**
 * Coerce one mcp-form field to the type its JSON schema declares.
 *
 * A numeric field is sent as a number, never as the typed string. Anything that
 * does not parse to a finite number degrades to `""` — the same state as an
 * emptied field, which the required-field check already blocks. `NaN` must
 * never reach the wire: `JSON.stringify` turns it into `null`, so the MCP
 * server would receive a silently wrong value instead of a refusal.
 */
export function coerceFormFieldValue(
  rawValue: string,
  schemaType: unknown,
): string | number {
  if (schemaType !== "number" && schemaType !== "integer") return rawValue;
  if (rawValue === "") return "";
  const parsed = Number(rawValue);
  return Number.isFinite(parsed) ? parsed : "";
}

function safeExternalUrl(value: string | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" ? url.href : null;
  } catch {
    return null;
  }
}

export function CodexInteractionCard({
  interaction,
  client,
  sessionId,
  sessionKey,
}: CodexInteractionCardProps) {
  if (interaction.kind === "question") {
    return (
      <CodexQuestionCard
        interaction={interaction}
        client={client}
        sessionId={sessionId}
        sessionKey={sessionKey}
      />
    );
  }
  return (
    <CodexMcpInteractionCard
      interaction={interaction}
      client={client}
      sessionId={sessionId}
      sessionKey={sessionKey}
    />
  );
}

function CodexMcpInteractionCard({
  interaction,
  client,
  sessionId,
  sessionKey,
}: CodexInteractionCardProps) {
  const remove = useCodexStore((state) => state.removePendingInteraction);
  // In-progress input lives in the prompt-draft store so it survives the tab
  // unmounting; `codexStore` clears it when the interaction resolves or is
  // withdrawn (removePendingInteraction / setPendingInteractions / sweeps).
  const draftKey = codexInteractionDraftKey(sessionKey, interaction.interactionId);
  const [form, setForm] = usePromptDraftField<Record<string, unknown>>(
    draftKey,
    "form",
    () => ({}),
  );
  const [secretForm, setSecretForm] = useState<Record<string, unknown>>({});
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [retryBlocked, setRetryBlocked] = useState(false);
  const schema = object(interaction.schema);
  const properties = object(schema.properties);
  const externalUrl = safeExternalUrl(interaction.url);
  const required = new Set(
    Array.isArray(schema.required)
      ? schema.required.filter((value): value is string => typeof value === "string")
      : [],
  );

  const isSensitiveField = (key: string, definition: Record<string, unknown>) =>
    definition.writeOnly === true
    || (typeof definition.format === "string"
      && /password|secret|token/i.test(definition.format))
    || /password|secret|token/i.test(key);
  const resolvedForm = useMemo(() => ({ ...form, ...secretForm }), [form, secretForm]);

  const canSubmit = useMemo(() => {
    if (interaction.kind === "mcp-form") {
      return [...required].every((key) => {
        const value = resolvedForm[key];
        return value !== undefined && value !== "";
      });
    }
    return Boolean(externalUrl);
  }, [externalUrl, interaction.kind, required, resolvedForm]);

  const openExternalForm = async () => {
    if (!externalUrl) return;
    setError(null);
    try {
      await openInBrowser(externalUrl);
    } catch {
      const message =
        "Could not open the MCP form in your browser. Check the desktop connection and try again.";
      setError(message);
      toast.error(message);
    }
  };

  const submit = async (action: "accept" | "decline" | "cancel") => {
    setSubmitting(true);
    setError(null);
    setRetryBlocked(false);
    const result = await respondToInteraction(
      client,
      sessionId,
      interaction.interactionId,
      action === "accept"
        ? {
            action,
            ...(interaction.kind === "mcp-form" ? { content: resolvedForm } : {}),
          }
        : { action },
    );
    // `respondToInteraction` never throws; it reports the outcome. Only
    // `applied`/`stale` mean the bridge is done with this interaction. On
    // `forbidden`/`error` the turn is still blocked on it, so the card has to
    // stay mounted, say so, and let the user retry.
    if (result === "applied" || result === "stale") {
      remove(sessionKey, interaction.interactionId);
      setSubmitting(false);
      return;
    }
    if (result === "unknown") {
      try {
        const pending = await fetchPendingInteractions(client, sessionId);
        if (!pending.some((candidate) => candidate.interactionId === interaction.interactionId)) {
          remove(sessionKey, interaction.interactionId);
          setSubmitting(false);
          return;
        }
        const message = "The connection dropped, but Codex is still waiting. It is safe to retry.";
        setError(message);
        toast.error(message);
        setSubmitting(false);
        return;
      } catch {
        const message = "The response outcome is unknown. Reconnect or refresh Codex before trying again.";
        setRetryBlocked(true);
        setError(message);
        toast.error(message);
        setSubmitting(false);
        return;
      }
    }
    const message =
      result === "forbidden"
        ? "Codex refused this response. The interaction may have been reassigned or the session locked."
        : "Could not send your response to Codex. Check the bridge connection and try again.";
    setError(message);
    toast.error(message);
    setSubmitting(false);
  };

  return (
    <BlockingPromptCard
      title="MCP input requested"
      description={interaction.message}
      meta={interaction.serverName}
      expiresAt={interaction.expiresAt}
      state={submitting ? "submitting" : error ? "retryable-error" : "pending"}
      error={error}
      role="group"
      aria-label="MCP input requested by Codex"
      arrivalAnnouncement="Codex is waiting for MCP input."
      actions={
        <>
          <Button
            variant="ghost"
            size="sm"
            disabled={submitting || retryBlocked}
            onClick={() => void submit("cancel")}
          >
            Cancel
          </Button>
          <Button
            size="sm"
            disabled={submitting || retryBlocked || !canSubmit}
            onClick={() => void submit("accept")}
          >
            {interaction.kind === "mcp-url" ? "I’ve completed it" : "Submit"}
          </Button>
        </>
      }
    >
      <div className="max-h-72 space-y-4 overflow-y-auto p-4">
        {interaction.kind === "mcp-form"
          ? Object.entries(properties).map(([key, rawDefinition]) => {
              const definition = object(rawDefinition);
              const label =
                typeof definition.title === "string" ? definition.title : key;
              const description =
                typeof definition.description === "string"
                  ? definition.description
                  : undefined;
              const options = Array.isArray(definition.enum)
                ? definition.enum.filter((value): value is string => typeof value === "string")
                : [];
              const sensitive = isSensitiveField(key, definition);
              const fieldValue = sensitive ? secretForm[key] : form[key];
              const setFieldValue = (value: unknown) => {
                const setter = sensitive ? setSecretForm : setForm;
                setter((current) => ({ ...current, [key]: value }));
              };
              return (
                <label key={key} className="block space-y-1.5">
                  <span className="text-xs font-medium text-foreground">
                    {label}{required.has(key) ? " *" : ""}
                  </span>
                  {description ? (
                    <span className="block text-xs text-muted-foreground">{description}</span>
                  ) : null}
                  {definition.type === "boolean" ? (
                    <input
                      type="checkbox"
                      checked={fieldValue === true}
                      onChange={(event) => setFieldValue(event.target.checked)}
                    />
                  ) : options.length > 0 ? (
                    <select
                      value={String(fieldValue ?? "")}
                      onChange={(event) => setFieldValue(event.target.value)}
                      className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
                    >
                      <option value="">Select…</option>
                      {options.map((option) => <option key={option}>{option}</option>)}
                    </select>
                  ) : (
                    <Input
                      type={sensitive
                        ? "password"
                        : definition.type === "number" || definition.type === "integer"
                          ? "number"
                          : "text"}
                      value={String(fieldValue ?? "")}
                      onChange={(event) => setFieldValue(
                        coerceFormFieldValue(
                          event.target.value,
                          definition.type,
                        ),
                      )}
                    />
                  )}
                  {sensitive ? (
                    <span className="block text-[11px] text-muted-foreground">
                      Secret input stays only in this card and is lost if you leave it.
                    </span>
                  ) : null}
                </label>
              );
            })
          : null}

        {interaction.kind === "mcp-url" && externalUrl ? (
          <Button
            variant="outline"
            className="w-full justify-between"
            onClick={() => void openExternalForm()}
          >
            Open secure form
            <ExternalLink className="h-4 w-4" />
          </Button>
        ) : null}
      </div>
    </BlockingPromptCard>
  );
}
