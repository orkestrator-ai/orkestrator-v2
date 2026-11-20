import { useState } from "react";
import { Loader2, Plus, Trash2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { capabilitiesApi } from "@/lib/backend/capabilities";

import { describeError, Pill } from "./capability-format";
import { useCapabilityResource } from "./useCapabilityResource";

/**
 * Trusted package registries and the signed-manifest policy
 * (docs/architecture/agent-capabilities-management.md, "Updates and rollback",
 * "Package registries").
 * A registry is an HTTPS index; packages from it are added from the Add
 * dialog's Registry source. Administrators forbid one with the
 * `registry:<id>/` source prefix.
 */
export function RegistriesSection() {
  const registries = useCapabilityResource(() => capabilitiesApi.listCapabilityRegistries(), []);
  const [draft, setDraft] = useState({ id: "", label: "", indexUrl: "", signingKey: "" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async (action: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await action();
      registries.reload();
    } catch (actionError) {
      setError(describeError(actionError));
    } finally {
      setBusy(false);
    }
  };
  const data = registries.state.data;
  const canSave =
    /^[a-z0-9][a-z0-9-]{0,63}$/.test(draft.id) && draft.indexUrl.startsWith("https://");

  return (
    <section className="space-y-3" data-testid="capability-registries">
      <div>
        <h4 className="text-sm font-medium text-foreground">Registries</h4>
        <p className="text-xs text-muted-foreground">
          A registry is an HTTPS index of packages, each version pinned to a commit or a checksummed
          tarball. Pin the publisher's signing key to refuse an index it did not sign.
        </p>
      </div>
      {registries.state.status === "error" ? (
        <p className="text-xs text-rose-300" role="alert">
          {registries.state.message}
        </p>
      ) : null}
      {data === null ? (
        <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
      ) : data.registries.length === 0 ? (
        <p className="text-xs text-muted-foreground">No registries yet.</p>
      ) : (
        <ul className="space-y-2">
          {data.registries.map((registry) => (
            <li
              key={registry.id}
              className="flex flex-wrap items-center gap-2 rounded-lg border border-zinc-800 p-3 text-xs"
            >
              <span className="font-medium text-foreground">{registry.label}</span>
              <Pill>{registry.id}</Pill>
              {registry.signingKeyId ? <Pill>Signed index required</Pill> : null}
              <span className="min-w-0 truncate text-muted-foreground">{registry.indexUrl}</span>
              <span className="ml-auto text-muted-foreground">
                {registry.lastError ? (
                  <span className="text-amber-300">{registry.lastError}</span>
                ) : registry.packageCount !== undefined ? (
                  `${registry.packageCount} package(s)`
                ) : (
                  "Not checked yet"
                )}
              </span>
              <Button
                variant="ghost"
                size="sm"
                disabled={busy}
                aria-label={`Remove ${registry.label}`}
                onClick={() =>
                  void run(() => capabilitiesApi.removeCapabilityRegistry(registry.id))
                }
              >
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
            </li>
          ))}
        </ul>
      )}
      <div className="grid gap-2 sm:grid-cols-4">
        <div className="space-y-1">
          <Label htmlFor="registry-id" className="text-xs">
            Id
          </Label>
          <Input
            id="registry-id"
            placeholder="team"
            value={draft.id}
            onChange={(event) => setDraft({ ...draft, id: event.target.value.trim() })}
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor="registry-label" className="text-xs">
            Name
          </Label>
          <Input
            id="registry-label"
            placeholder="Team registry"
            value={draft.label}
            onChange={(event) => setDraft({ ...draft, label: event.target.value })}
          />
        </div>
        <div className="space-y-1 sm:col-span-2">
          <Label htmlFor="registry-url" className="text-xs">
            Index address
          </Label>
          <Input
            id="registry-url"
            placeholder="https://registry.example.com/index.json"
            value={draft.indexUrl}
            onChange={(event) => setDraft({ ...draft, indexUrl: event.target.value.trim() })}
          />
        </div>
        <div className="space-y-1 sm:col-span-3">
          <Label htmlFor="registry-key" className="text-xs">
            Signing key (optional)
          </Label>
          <Input
            id="registry-key"
            placeholder="Ed25519 public key, base64url"
            value={draft.signingKey}
            onChange={(event) => setDraft({ ...draft, signingKey: event.target.value.trim() })}
          />
        </div>
        <div className="flex items-end">
          <Button
            size="sm"
            disabled={busy || !canSave}
            onClick={() =>
              void run(async () => {
                await capabilitiesApi.saveCapabilityRegistry({
                  id: draft.id,
                  indexUrl: draft.indexUrl,
                  ...(draft.label.trim() ? { label: draft.label.trim() } : {}),
                  ...(draft.signingKey ? { signingKey: draft.signingKey } : {}),
                });
                setDraft({ id: "", label: "", indexUrl: "", signingKey: "" });
              })
            }
          >
            <Plus className="h-3.5 w-3.5" /> Add registry
          </Button>
        </div>
      </div>
      <div className="flex items-start gap-3 rounded-lg border border-zinc-800 p-3">
        <Switch
          id="require-signed-manifests"
          checked={data?.requireSignedManifests ?? false}
          disabled={busy || data === null}
          onCheckedChange={(checked) =>
            void run(() => capabilitiesApi.setCapabilityManifestPolicy(checked))
          }
        />
        <div className="space-y-0.5">
          <Label htmlFor="require-signed-manifests" className="text-xs text-foreground">
            Require signed project manifests
          </Label>
          <p className="text-[11px] text-muted-foreground">
            Imports refuse a lockfile that is unsigned or signed by a key this installation does not
            trust. A signature that does not verify is always refused.
            {data?.signingKey
              ? ` This installation signs with key ${data.signingKey.fingerprint}.`
              : ""}
          </p>
        </div>
      </div>
      {error ? (
        <p className="text-xs text-rose-300" role="alert">
          {error}
        </p>
      ) : null}
    </section>
  );
}
