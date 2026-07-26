import { useMemo, useState } from "react";
import { Check, Circle, ExternalLink, HelpCircle } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import {
  respondToInteraction,
  type CodexClient,
  type CodexInteraction,
} from "@/lib/codex-client";
import { useCodexStore } from "@/stores/codexStore";

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
  const remove = useCodexStore((state) => state.removePendingInteraction);
  // Selection is tracked by option *index*, never by label: labels are
  // untrusted MCP-supplied text and are not de-duplicated upstream, so two
  // options can share one. Keying/selecting by label would make them a single
  // control. The submitted answer is still the label — that is the wire format.
  const [answers, setAnswers] = useState<Record<string, number[]>>({});
  const [form, setForm] = useState<Record<string, unknown>>({});
  const [freeText, setFreeText] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const schema = object(interaction.schema);
  const properties = object(schema.properties);
  const externalUrl = safeExternalUrl(interaction.url);
  const required = new Set(
    Array.isArray(schema.required)
      ? schema.required.filter((value): value is string => typeof value === "string")
      : [],
  );

  // Selected indices become labels here — indices are a local rendering
  // concern, the bridge only understands labels.
  const resolvedAnswers = useMemo(() => {
    const entries: Record<string, string[]> = {};
    for (const question of interaction.questions ?? []) {
      const selected = (answers[question.id] ?? [])
        .map((index) => question.options?.[index]?.label)
        .filter((label): label is string => typeof label === "string");
      if (selected.length > 0) {
        entries[question.id] = selected;
        continue;
      }
      const typed = freeText[question.id]?.trim() ?? "";
      if (typed) entries[question.id] = [typed];
    }
    return entries;
  }, [answers, freeText, interaction.questions]);

  const canSubmit = useMemo(() => {
    if (interaction.kind === "question") {
      return (interaction.questions ?? []).every(
        (question) => (resolvedAnswers[question.id]?.length ?? 0) > 0,
      );
    }
    if (interaction.kind === "mcp-form") {
      return [...required].every((key) => {
        const value = form[key];
        return value !== undefined && value !== "";
      });
    }
    return Boolean(externalUrl);
  }, [externalUrl, form, interaction.kind, interaction.questions, required, resolvedAnswers]);

  const submit = async (action: "accept" | "decline" | "cancel") => {
    setSubmitting(true);
    setError(null);
    const result = await respondToInteraction(
      client,
      sessionId,
      interaction.interactionId,
      action === "accept"
        ? {
            action,
            ...(interaction.kind === "question" ? { answers: resolvedAnswers } : {}),
            ...(interaction.kind === "mcp-form" ? { content: form } : {}),
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
    const message =
      result === "forbidden"
        ? "Codex refused this response. The interaction may have been reassigned or the session locked."
        : "Could not send your response to Codex. Check the bridge connection and try again.";
    setError(message);
    toast.error(message);
    setSubmitting(false);
  };

  return (
    <div className="overflow-hidden rounded-lg border border-border bg-card shadow-sm">
      <div className="flex items-start gap-2 border-b border-border bg-muted/50 px-4 py-2.5">
        <HelpCircle className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
        <div className="min-w-0">
          <div className="text-sm font-medium text-foreground">
            {interaction.kind === "question" ? "Codex has a question" : "MCP input requested"}
          </div>
          {interaction.message ? (
            <div className="mt-0.5 text-xs text-muted-foreground">
              {interaction.message}
            </div>
          ) : null}
          {interaction.serverName ? (
            <div className="mt-0.5 font-mono text-[10px] text-muted-foreground/70">
              {interaction.serverName}
            </div>
          ) : null}
        </div>
      </div>

      <div className="max-h-72 space-y-4 overflow-y-auto p-4">
        {interaction.kind === "question"
          ? interaction.questions?.map((question) => (
              <div key={question.id} className="space-y-2">
                <div>
                  <div className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
                    {question.header}
                  </div>
                  <div className="mt-1 text-sm text-foreground">{question.question}</div>
                </div>
                {question.options?.map((option, index) => {
                  const selected = answers[question.id]?.includes(index) ?? false;
                  return (
                    <button
                      key={`${question.id}:${index}`}
                      type="button"
                      aria-pressed={selected}
                      onClick={() => {
                        setAnswers((current) => ({
                          ...current,
                          [question.id]: selected ? [] : [index],
                        }));
                        if (!selected) {
                          setFreeText((current) => ({ ...current, [question.id]: "" }));
                        }
                      }}
                      className={cn(
                        "flex w-full items-start gap-2 rounded-md px-3 py-2 text-left transition-colors hover:bg-muted",
                        selected && "bg-muted",
                      )}
                    >
                      {selected
                        ? <Check className="mt-0.5 h-4 w-4 shrink-0" />
                        : <Circle className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground/50" />}
                      <span>
                        <span className="block text-sm">{option.label}</span>
                        {option.description ? (
                          <span className="block text-xs text-muted-foreground">
                            {option.description}
                          </span>
                        ) : null}
                      </span>
                    </button>
                  );
                })}
                {question.isOther || !question.options?.length ? (
                  <Input
                    type={question.isSecret ? "password" : "text"}
                    aria-label={`Answer for ${question.question}`}
                    value={freeText[question.id] ?? ""}
                    onChange={(event) => {
                      const value = event.target.value;
                      setFreeText((current) => ({ ...current, [question.id]: value }));
                      if (value) {
                        setAnswers((current) => ({ ...current, [question.id]: [] }));
                      }
                    }}
                    placeholder="Type your answer"
                  />
                ) : null}
              </div>
            ))
          : null}

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
                      checked={form[key] === true}
                      onChange={(event) => setForm((current) => ({
                        ...current,
                        [key]: event.target.checked,
                      }))}
                    />
                  ) : options.length > 0 ? (
                    <select
                      value={String(form[key] ?? "")}
                      onChange={(event) => setForm((current) => ({
                        ...current,
                        [key]: event.target.value,
                      }))}
                      className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
                    >
                      <option value="">Select…</option>
                      {options.map((option) => <option key={option}>{option}</option>)}
                    </select>
                  ) : (
                    <Input
                      type={definition.type === "number" || definition.type === "integer"
                        ? "number"
                        : "text"}
                      value={String(form[key] ?? "")}
                      onChange={(event) => setForm((current) => ({
                        ...current,
                        [key]:
                          definition.type === "number" || definition.type === "integer"
                            ? event.target.value === ""
                              ? ""
                              : Number(event.target.value)
                            : event.target.value,
                      }))}
                    />
                  )}
                </label>
              );
            })
          : null}

        {interaction.kind === "mcp-url" && externalUrl ? (
          <Button
            variant="outline"
            className="w-full justify-between"
            onClick={() => window.open(externalUrl, "_blank", "noopener,noreferrer")}
          >
            Open secure form
            <ExternalLink className="h-4 w-4" />
          </Button>
        ) : null}
      </div>

      {error ? (
        <div
          role="alert"
          className="border-t border-destructive/30 bg-destructive/10 px-4 py-2.5 text-xs text-destructive-foreground"
        >
          {error}
        </div>
      ) : null}

      <div className="flex justify-end gap-2 border-t border-border bg-muted/30 px-4 py-3">
        <Button
          variant="ghost"
          size="sm"
          disabled={submitting}
          onClick={() => void submit("cancel")}
        >
          Cancel
        </Button>
        {interaction.kind !== "mcp-url" ? (
          <Button
            size="sm"
            disabled={submitting || !canSubmit}
            onClick={() => void submit("accept")}
          >
            Submit
          </Button>
        ) : (
          <Button
            size="sm"
            disabled={submitting || !canSubmit}
            onClick={() => void submit("accept")}
          >
            I’ve completed it
          </Button>
        )}
      </div>
    </div>
  );
}
