import { useState } from "react";
import { ShieldAlert, ShieldCheck, ShieldQuestion } from "lucide-react";

import type { CapabilityManifestSignatureCheck } from "@orkestrator/protocol/capability-resources-api";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { setGraphSharingKeyTrust } from "@/lib/backend/graph-template-sharing";

import { describeError } from "./capability-format";

/**
 * The import preview's signature line: who signed the lockfile and whether
 * this installation trusts them. An untrusted signer can be trusted here (the
 * same trusted-key list graph bundles use), after checking the fingerprint
 * with the sender; the caller then previews again.
 */
export function ManifestSignatureNote({
  signature,
  required,
  onTrusted,
}: {
  signature: CapabilityManifestSignatureCheck;
  required: boolean;
  onTrusted: () => void;
}) {
  const [label, setLabel] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const key = signature.fingerprint ? ` (key ${signature.fingerprint})` : "";
  const line =
    signature.status === "trusted"
      ? `Signed by ${signature.label ?? "a trusted key"}${key}.`
      : signature.status === "untrusted"
        ? `Signed by a key this installation does not trust${key}.${required ? " Your policy requires a trusted signature." : ""}`
        : signature.status === "invalid"
          ? `The signature is invalid: ${signature.reason ?? "it does not verify"}`
          : `Not signed.${required ? " Your policy requires a trusted signature." : ""}`;
  const Icon =
    signature.status === "trusted"
      ? ShieldCheck
      : signature.status === "invalid"
        ? ShieldAlert
        : ShieldQuestion;
  const tone =
    signature.status === "trusted"
      ? "text-emerald-300"
      : signature.status === "invalid" || required
        ? "text-rose-300"
        : "text-muted-foreground";

  return (
    <div className="space-y-2" data-testid="manifest-signature">
      <p className={`flex items-center gap-1.5 ${tone}`}>
        <Icon className="h-3.5 w-3.5 shrink-0" aria-hidden />
        {line}
      </p>
      {signature.status === "untrusted" && signature.publicKey ? (
        <div className="flex flex-wrap items-end gap-2">
          <div className="space-y-1">
            <Label htmlFor="manifest-signer-label" className="text-xs">
              Trust this key as
            </Label>
            <Input
              id="manifest-signer-label"
              value={label}
              maxLength={80}
              placeholder="Whose key is it?"
              onChange={(event) => setLabel(event.target.value)}
            />
          </div>
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={busy || !label.trim()}
            onClick={() => {
              setBusy(true);
              setError(null);
              void setGraphSharingKeyTrust({
                action: "add",
                publicKey: signature.publicKey!,
                label: label.trim(),
              })
                .then(() => onTrusted())
                .catch((trustError: unknown) => setError(describeError(trustError)))
                .finally(() => setBusy(false));
            }}
          >
            Trust key
          </Button>
        </div>
      ) : null}
      {error ? (
        <p className="text-xs text-rose-300" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}
