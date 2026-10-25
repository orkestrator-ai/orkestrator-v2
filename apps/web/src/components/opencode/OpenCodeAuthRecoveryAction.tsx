import { useState } from "react";
import { Check, Loader2, LogIn } from "lucide-react";
import { Button } from "@/components/ui/button";
import { OpenCodeProviderSignIn } from "@/components/opencode/OpenCodeProviderSignIn";
import { listOpenCodeProviderAuth } from "@/lib/backend";
import type { OpenCodeProviderAuthEntry } from "@orkestrator/protocol/opencode-provider-auth";

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/**
 * Turns an OpenCode model request refused for its credential into a sign-in,
 * shown inside the failed request's error row.
 *
 * OpenCode cannot tell an expired key from a valid one ahead of a turn, so the
 * failure is the first sign. This signs the failed message's provider in again
 * through the same flow as Settings. The provider list is read only when the
 * user asks, because reading it starts a private OpenCode server.
 */
export function OpenCodeAuthRecoveryAction({
  providerId,
  containerId,
}: {
  providerId: string;
  containerId?: string;
}) {
  const [provider, setProvider] = useState<OpenCodeProviderAuthEntry | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [signedIn, setSignedIn] = useState(false);
  const label = provider?.label ?? providerId;

  const open = async () => {
    setLoading(true);
    setError(null);
    try {
      const snapshot = await listOpenCodeProviderAuth();
      setProvider(
        snapshot.providers.find((candidate) => candidate.id === providerId) ?? {
          id: providerId,
          label: providerId,
          connected: false,
          storedLogin: false,
          allowed: false,
          methods: [{ index: 0, type: "api", label: "API key", prompts: [] }],
        },
      );
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setLoading(false);
    }
  };

  if (signedIn) {
    return (
      <p role="status" className="flex items-center gap-2 text-xs text-emerald-400">
        <Check aria-hidden="true" className="size-3.5" />
        {containerId
          ? `Signed in to ${label}. This environment's container copies the login in when it starts, so restart it before resending.`
          : `Signed in to ${label}. Resend your message to continue.`}
      </p>
    );
  }

  return (
    <div className="space-y-2">
      {provider ? (
        <OpenCodeProviderSignIn
          provider={provider}
          onSignedIn={() => setSignedIn(true)}
          onCancel={() => setProvider(null)}
        />
      ) : (
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="gap-2"
          disabled={loading}
          onClick={() => void open()}
        >
          {loading ? (
            <Loader2 aria-hidden="true" className="size-4 animate-spin" />
          ) : (
            <LogIn aria-hidden="true" className="size-4" />
          )}
          Sign in to {label} again
        </Button>
      )}
      {error ? <p className="text-xs text-destructive">{error}</p> : null}
    </div>
  );
}
