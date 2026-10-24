/**
 * Signs one OpenCode provider in: an API key, or OpenCode's own OAuth flow.
 *
 * Deliberately thin, like the Claude and Codex account sign-in. The backend
 * drives OpenCode's auth routes and stores nothing itself; this view collects
 * what OpenCode asks for, shows the link and code of a browser sign-in and
 * reports the outcome. An API key is held only in this form until it is sent.
 */
import { useId, useMemo, useState } from "react";
import { Check, Copy, ExternalLink, KeyRound, Loader2, LogIn } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useOpenCodeProviderLogin } from "@/hooks/useOpenCodeProviderLogin";
import { isRemoteGatewayConnection } from "@/lib/gateway-url";
import { writeText } from "@/lib/native/clipboard";
import { openInBrowser, setOpenCodeProviderApiKey } from "@/lib/backend";
import { useAccountMachine } from "@/components/settings/account-machine";
import type {
  OpenCodeProviderAuthEntry,
  OpenCodeProviderAuthMethod,
  OpenCodeProviderAuthPrompt,
} from "@orkestrator/protocol/opencode-provider-auth";

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function promptApplies(prompt: OpenCodeProviderAuthPrompt, values: Record<string, string>) {
  if (!prompt.when) return true;
  const answer = values[prompt.when.key] ?? "";
  return prompt.when.op === "eq" ? answer === prompt.when.value : answer !== prompt.when.value;
}

function PromptField({
  prompt,
  value,
  onChange,
}: {
  prompt: OpenCodeProviderAuthPrompt;
  value: string;
  onChange: (value: string) => void;
}) {
  const id = useId();
  return (
    <div className="space-y-1">
      <label htmlFor={id} className="text-xs text-muted-foreground">
        {prompt.message}
      </label>
      {prompt.type === "select" ? (
        <select
          id={id}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          className="h-8 w-full rounded-md border border-input bg-background px-2 text-xs"
        >
          <option value="">Choose…</option>
          {prompt.options?.map((option) => (
            <option key={option.value} value={option.value}>
              {option.hint ? `${option.label} — ${option.hint}` : option.label}
            </option>
          ))}
        </select>
      ) : (
        <Input
          id={id}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          placeholder={prompt.placeholder}
          className="h-8 text-xs"
          autoComplete="off"
          spellCheck={false}
        />
      )}
    </div>
  );
}

export function OpenCodeProviderSignIn({
  provider,
  onSignedIn,
  onCancel,
}: {
  provider: OpenCodeProviderAuthEntry;
  /** A login was stored. */
  onSignedIn: () => void;
  onCancel?: () => void;
}) {
  const remote = isRemoteGatewayConnection();
  const [methodIndex, setMethodIndex] = useState(
    () =>
      (remote
        ? provider.methods.find(
            (method) => method.type === "oauth" && /headless|device|code/i.test(method.label),
          )
        : undefined
      )?.index ??
      provider.methods[0]?.index ??
      0,
  );
  const [values, setValues] = useState<Record<string, string>>({});
  const [apiKey, setApiKey] = useState("");
  const [saving, setSaving] = useState(false);
  const [code, setCode] = useState("");
  const [submittingCode, setSubmittingCode] = useState(false);
  const [copied, setCopied] = useState<"code" | "link" | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const login = useOpenCodeProviderLogin(provider.id, onSignedIn);
  const { machine } = useAccountMachine();
  const keyId = useId();

  const method: OpenCodeProviderAuthMethod | undefined = provider.methods.find(
    (candidate) => candidate.index === methodIndex,
  );
  const prompts = useMemo(
    () => (method?.prompts ?? []).filter((prompt) => promptApplies(prompt, values)),
    [method, values],
  );
  const answers = useMemo(
    () =>
      Object.fromEntries(
        prompts.flatMap((prompt) => {
          const answer = values[prompt.key]?.trim();
          return answer ? [[prompt.key, answer]] : [];
        }),
      ),
    [prompts, values],
  );
  const promptsAnswered = prompts.every((prompt) => Boolean(values[prompt.key]?.trim()));
  const progress = login.progress;
  const signingIn = progress.state === "pending";
  const error = formError ?? login.error;

  const copy = async (value: string, what: "code" | "link") => {
    try {
      await writeText(value);
      setCopied(what);
    } catch (cause) {
      setFormError(messageOf(cause));
    }
  };

  const saveKey = async () => {
    setSaving(true);
    setFormError(null);
    try {
      await setOpenCodeProviderApiKey(provider.id, apiKey, answers, machine);
      setApiKey("");
      onSignedIn();
    } catch (cause) {
      setFormError(messageOf(cause));
    } finally {
      setSaving(false);
    }
  };

  const submitCode = async () => {
    setSubmittingCode(true);
    try {
      await login.submitCode(code);
      setCode("");
    } catch (cause) {
      login.reportError(messageOf(cause));
    } finally {
      setSubmittingCode(false);
    }
  };

  if (login.otherPending) {
    return (
      <div className="space-y-2 text-xs text-muted-foreground">
        <p>
          Sign-in to {login.otherPending.providerLabel ?? login.otherPending.providerId} is in
          progress.
        </p>
        <Button type="button" size="sm" variant="ghost" onClick={() => void login.cancel()}>
          Cancel sign-in
        </Button>
        {error ? <p className="text-destructive">{error}</p> : null}
      </div>
    );
  }

  if (!method) {
    return (
      <p className="text-xs text-muted-foreground">OpenCode offers no sign-in for this provider.</p>
    );
  }

  if (signingIn) {
    const url = progress.url;
    return (
      <div
        aria-label={`${provider.label} sign-in`}
        className="space-y-3 rounded-md border border-border/60 bg-muted/30 p-3"
      >
        {!url ? (
          <p className="flex items-center gap-2 text-xs text-muted-foreground">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            Starting sign-in…
          </p>
        ) : (
          <>
            <p className="text-xs text-muted-foreground">
              {progress.needsCode
                ? "Sign in in your browser, then paste the code the page shows."
                : (progress.instructions ?? "Open the page and sign in.")}
            </p>
            {progress.userCode ? (
              <div className="flex items-center gap-2">
                <code className="rounded bg-zinc-900 px-2 py-1 font-mono text-sm tracking-widest text-foreground">
                  {progress.userCode}
                </code>
                <Button
                  type="button"
                  size="icon"
                  variant="ghost"
                  className="h-7 w-7"
                  aria-label="Copy code"
                  onClick={() => void copy(progress.userCode!, "code")}
                >
                  {copied === "code" ? (
                    <Check className="h-3.5 w-3.5" />
                  ) : (
                    <Copy className="h-3.5 w-3.5" />
                  )}
                </Button>
              </div>
            ) : null}
            <div className="flex flex-wrap gap-2">
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => void openInBrowser(url)}
              >
                <ExternalLink className="mr-1.5 h-3.5 w-3.5" />
                Open sign-in page
              </Button>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                onClick={() => void copy(url, "link")}
              >
                <Copy className="mr-1.5 h-3.5 w-3.5" />
                {copied === "link" ? "Link copied" : "Copy link"}
              </Button>
            </div>
            {progress.needsCode ? (
              <form
                className="flex items-center gap-2"
                onSubmit={(event) => {
                  event.preventDefault();
                  void submitCode();
                }}
              >
                <Input
                  aria-label="Sign-in code"
                  placeholder="Paste code"
                  value={code}
                  onChange={(event) => setCode(event.target.value)}
                  className="h-8 text-xs"
                  autoComplete="off"
                  spellCheck={false}
                />
                <Button
                  type="submit"
                  size="sm"
                  disabled={submittingCode || !code.trim() || progress.codeSubmitted}
                >
                  {submittingCode || progress.codeSubmitted ? (
                    <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                  ) : null}
                  Continue
                </Button>
              </form>
            ) : (
              <p className="flex items-center gap-2 text-xs text-muted-foreground">
                <Loader2 className="h-3 w-3 animate-spin" />
                Waiting for you to approve the sign-in…
              </p>
            )}
          </>
        )}
        {error ? <p className="text-xs text-destructive">{error}</p> : null}
        <Button type="button" size="sm" variant="ghost" onClick={() => void login.cancel()}>
          Cancel sign-in
        </Button>
      </div>
    );
  }

  return (
    <div
      aria-label={`${provider.label} sign-in`}
      className="space-y-3 rounded-md border border-border/60 bg-muted/30 p-3"
    >
      {provider.methods.length > 1 ? (
        <div role="radiogroup" aria-label="Sign-in method" className="flex flex-wrap gap-2">
          {provider.methods.map((candidate) => (
            <Button
              key={candidate.index}
              type="button"
              size="sm"
              role="radio"
              aria-checked={candidate.index === methodIndex}
              variant={candidate.index === methodIndex ? "secondary" : "ghost"}
              onClick={() => {
                setMethodIndex(candidate.index);
                setFormError(null);
              }}
            >
              {candidate.label}
            </Button>
          ))}
        </div>
      ) : null}

      {remote && method.type === "oauth" ? (
        <p className="text-xs text-muted-foreground">
          Browser loopback sign-in must be completed on the backend machine. For a remote
          connection, use a headless or device-code method when available.
        </p>
      ) : null}

      {prompts.map((prompt) => (
        <PromptField
          key={prompt.key}
          prompt={prompt}
          value={values[prompt.key] ?? ""}
          onChange={(value) => setValues((current) => ({ ...current, [prompt.key]: value }))}
        />
      ))}

      {method.type === "api" ? (
        <form
          className="space-y-2"
          onSubmit={(event) => {
            event.preventDefault();
            void saveKey();
          }}
        >
          <label htmlFor={keyId} className="text-xs text-muted-foreground">
            {provider.label} API key
          </label>
          <div className="flex items-center gap-2">
            <Input
              id={keyId}
              type="password"
              value={apiKey}
              onChange={(event) => setApiKey(event.target.value)}
              placeholder="Paste API key"
              className="h-8 font-mono text-xs"
              autoComplete="off"
              spellCheck={false}
            />
            <Button
              type="submit"
              size="sm"
              className="gap-1.5"
              disabled={saving || !apiKey.trim() || !promptsAnswered}
            >
              {saving ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <KeyRound className="h-3.5 w-3.5" />
              )}
              Save key
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            Saved in OpenCode&apos;s own login store, replacing any key it holds for this provider.
          </p>
        </form>
      ) : (
        <Button
          type="button"
          size="sm"
          className="gap-1.5"
          disabled={login.starting || !promptsAnswered}
          onClick={() =>
            void login.start({
              providerLabel: provider.label,
              method: method.index,
              ...(Object.keys(answers).length > 0 ? { inputs: answers } : {}),
            })
          }
        >
          {login.starting ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <LogIn className="h-3.5 w-3.5" />
          )}
          Continue in browser
        </Button>
      )}

      {error ? <p className="text-xs text-destructive">{error}</p> : null}
      {onCancel ? (
        <Button type="button" size="sm" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      ) : null}
    </div>
  );
}
