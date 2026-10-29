import { useEffect, useRef, useState, type ChangeEvent } from "react";
import {
  ClipboardCopy,
  Download,
  FileUp,
  Loader2,
  ShieldCheck,
  ShieldQuestion,
} from "lucide-react";
import type { FieldError } from "@orkestrator/protocol/field-validation";
import type { GraphTemplateSummary } from "@orkestrator/protocol/graphs/library";
import {
  GRAPH_SHARING_BOUNDS,
  graphSharingFingerprint,
  type GraphShareRefusalCode,
  type GraphSharingKeys,
  type GraphTemplateShareExport,
  type GraphTemplateShareImportResult,
  type GraphTemplateSharePreview,
} from "@orkestrator/protocol/graphs/sharing";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  exportGraphTemplateBundle,
  getGraphSharingKeys,
  importGraphTemplateBundle,
  setGraphSharingKeyTrust,
} from "@/lib/backend/graph-template-sharing";
import { cn } from "@/lib/utils";
import { GraphCapabilitySummaryView, GraphCompileCounts } from "./GraphCapabilitySummary";

/**
 * Sharing templates (item 405): export a template as a share bundle
 * (`orkestrator.graph-bundle`, digest-checked, optionally signed with this
 * installation's key), and import one in two steps. The first step checks the
 * bundle and shows who signed it, its digest and what it would be allowed to
 * do; nothing is saved until the user imports it at that digest. A tampered
 * bundle is refused with the check that failed.
 */

/** Files above this are refused before reading; the backend has its own byte limit. */
const MAX_BUNDLE_FILE_BYTES = GRAPH_SHARING_BOUNDS.maxBundleBytes;

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const REFUSAL_TEXT: Record<GraphShareRefusalCode, string> = {
  "invalid-bundle": "This is not a valid share bundle.",
  "invalid-template": "The template in it is not valid.",
  "digest-mismatch": "The template was changed after it was exported; it was not imported.",
  "content-digest-mismatch":
    "The template's content was changed after it was exported; it was not imported.",
  "signature-invalid":
    "The signature does not match: the bundle was changed after it was signed; it was not imported.",
};

// ---------------------------------------------------------------- export

export function GraphShareExportDialog({
  open,
  onOpenChange,
  summary,
  onDownload,
  onCopy,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  summary: GraphTemplateSummary | null;
  onDownload: (fileName: string, text: string) => void;
  onCopy: (text: string) => Promise<void>;
}) {
  const [sign, setSign] = useState(true);
  const [author, setAuthor] = useState("");
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [exported, setExported] = useState<GraphTemplateShareExport | null>(null);
  const [keys, setKeys] = useState<GraphSharingKeys | null>(null);
  const canSign = summary !== null && summary.trust === "trusted";

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    void getGraphSharingKeys().then(
      (result) => {
        if (!cancelled) setKeys(result);
      },
      () => undefined,
    );
    return () => {
      cancelled = true;
    };
  }, [open, exported]);

  const run = async (deliver: (result: GraphTemplateShareExport) => Promise<void> | void) => {
    if (!summary || busy) return;
    setBusy(true);
    setFailure(null);
    try {
      const result = await exportGraphTemplateBundle(summary.ref, {
        ...(sign && canSign ? { sign: true } : {}),
        ...(author.trim() ? { author: author.trim() } : {}),
      });
      setExported(result);
      await deliver(result);
    } catch (error) {
      setFailure(errorText(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) {
          setExported(null);
          setFailure(null);
        }
        onOpenChange(next);
      }}
    >
      <DialogContent size="xl">
        <DialogHeader>
          <DialogTitle>Share {summary?.name ?? "template"}</DialogTitle>
          <DialogDescription>
            A share bundle carries the template, its custom types and its digest, so the person
            importing it can tell whether it was changed on the way.
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-3 text-sm">
          <div className="flex items-start gap-2">
            <Checkbox
              id="graph-share-sign"
              checked={sign && canSign}
              disabled={!canSign}
              onCheckedChange={(value) => setSign(value === true)}
            />
            <div className="flex flex-col gap-0.5">
              <Label htmlFor="graph-share-sign">Sign with this installation's key</Label>
              <p className="text-xs text-muted-foreground">
                {canSign
                  ? "People who trust your key see it as signed by you."
                  : "Approve this project template before signing it: a signature vouches for its content."}
              </p>
            </div>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="graph-share-author">Author (optional)</Label>
            <Input
              id="graph-share-author"
              value={author}
              maxLength={GRAPH_SHARING_BOUNDS.maxAuthorChars}
              onChange={(event) => setAuthor(event.target.value)}
              placeholder="Your name"
            />
          </div>
          {keys?.installation ? (
            <div data-graph-share-own-key="" className="flex flex-col gap-1 text-xs">
              <span className="text-muted-foreground">
                Your public key (give it to people who should trust your bundles):
              </span>
              <div className="flex items-center gap-2">
                <code className="min-w-0 flex-1 truncate rounded bg-muted/40 px-1.5 py-0.5">
                  {keys.installation.publicKey}
                </code>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => void onCopy(keys.installation!.publicKey)}
                  aria-label="Copy your public key"
                >
                  <ClipboardCopy className="size-3.5" />
                </Button>
              </div>
              <span className="text-muted-foreground">
                Fingerprint{" "}
                <span className="font-mono">
                  {graphSharingFingerprint(keys.installation.keyId)}
                </span>
              </span>
            </div>
          ) : null}
          {exported ? (
            <p data-graph-share-exported="" className="text-xs text-muted-foreground">
              Digest <span className="font-mono">{exported.digest.slice(0, 16)}</span>
              {exported.signed ? " · signed" : " · unsigned"}
            </p>
          ) : null}
          {failure ? (
            <p role="alert" className="text-xs text-failure">
              {failure}
            </p>
          ) : null}
        </div>
        <DialogFooter className="gap-2">
          <Button
            type="button"
            variant="outline"
            disabled={!summary || busy}
            onClick={() => void run((result) => onCopy(result.text))}
          >
            <ClipboardCopy className="size-4" />
            Copy bundle
          </Button>
          <Button
            type="button"
            disabled={!summary || busy}
            onClick={() => void run((result) => onDownload(result.fileName, result.text))}
          >
            {busy ? <Loader2 className="size-4 animate-spin" /> : <Download className="size-4" />}
            Download bundle
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------- import

function IntegrityNote({ preview }: { preview: GraphTemplateSharePreview }) {
  const signed = preview.integrity === "trusted-signer";
  const Icon = signed ? ShieldCheck : ShieldQuestion;
  const text =
    preview.integrity === "trusted-signer"
      ? `Signed by ${preview.signer?.label ?? "a trusted key"}; the digests match.`
      : preview.integrity === "untrusted-signer"
        ? "Signed by a key you do not trust yet; the digests match. Check the fingerprint with the sender."
        : preview.integrity === "unsigned"
          ? "Not signed; the digests match, so it was not changed after export, but anyone could have made it."
          : "Plain template JSON: there is no digest or signature to check.";
  return (
    <p
      data-graph-share-integrity={preview.integrity}
      className={cn(
        "flex items-start gap-1.5 text-xs",
        signed ? "text-emerald-300" : "text-amber-300",
      )}
    >
      <Icon aria-hidden className="mt-0.5 size-3.5 shrink-0" />
      <span>{text}</span>
    </p>
  );
}

export function GraphShareImportDialog({
  open,
  onOpenChange,
  projectId,
  onImported,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projectId: string | null;
  onImported: (result: Extract<GraphTemplateShareImportResult, { status: "imported" }>) => void;
}) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState<GraphTemplateSharePreview | null>(null);
  const [refusal, setRefusal] = useState<{
    refused: GraphShareRefusalCode;
    errors: FieldError[];
    omitted: number;
  } | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [signerLabel, setSignerLabel] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);

  const reset = () => {
    setPreview(null);
    setRefusal(null);
    setFailure(null);
  };

  const readFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    reset();
    if (file.size > MAX_BUNDLE_FILE_BYTES) {
      setFailure(`${file.name} is larger than ${MAX_BUNDLE_FILE_BYTES / 1024 / 1024} MiB.`);
      return;
    }
    setText(await file.text());
  };

  const call = async (confirmDigest?: string) => {
    if (!text.trim() || busy) return;
    setBusy(true);
    setFailure(null);
    try {
      const result = await importGraphTemplateBundle(text, {
        ...(projectId ? { projectId } : {}),
        ...(confirmDigest ? { confirmDigest } : {}),
      });
      if (result.status === "refused") {
        setPreview(null);
        setRefusal({
          refused: result.refused,
          errors: result.errors,
          omitted: result.omittedErrors,
        });
      } else if (result.status === "preview") {
        setRefusal(null);
        setPreview(result.preview);
      } else {
        setText("");
        reset();
        onImported(result);
        onOpenChange(false);
      }
    } catch (error) {
      setFailure(errorText(error));
    } finally {
      setBusy(false);
    }
  };

  const trustSigner = async () => {
    const signer = preview?.signer;
    if (!signer || !signerLabel.trim()) return;
    setBusy(true);
    try {
      await setGraphSharingKeyTrust({
        action: "add",
        publicKey: signer.publicKey,
        label: signerLabel.trim(),
      });
      setSignerLabel("");
    } catch (error) {
      setFailure(errorText(error));
    } finally {
      setBusy(false);
    }
    await call();
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="3xl">
        <DialogHeader>
          <DialogTitle>Import a shared template</DialogTitle>
          <DialogDescription>
            Paste a share bundle (or template JSON), or choose a{" "}
            <span className="font-mono">.graph-bundle.json</span> file. Check it first: nothing is
            saved until you import it.
          </DialogDescription>
        </DialogHeader>
        <div className="flex max-h-[65vh] flex-col gap-3 overflow-y-auto">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="graph-share-import-text">Bundle</Label>
            <Textarea
              id="graph-share-import-text"
              value={text}
              onChange={(event) => {
                setText(event.target.value);
                if (preview || refusal || failure) reset();
              }}
              spellCheck={false}
              placeholder='{ "format": "orkestrator.graph-bundle", "formatVersion": 1, … }'
              className="h-40 font-mono text-xs"
            />
          </div>
          {refusal ? (
            <div
              role="alert"
              data-graph-share-refused={refusal.refused}
              className="flex flex-col gap-1"
            >
              <p className="text-xs font-medium text-failure">{REFUSAL_TEXT[refusal.refused]}</p>
              <ul className="max-h-32 overflow-y-auto text-xs">
                {refusal.errors.map((error, index) => (
                  <li key={`${error.path}:${index}`}>
                    <span className="font-mono text-muted-foreground">{error.path}</span>{" "}
                    {error.message}
                  </li>
                ))}
                {refusal.omitted > 0 ? (
                  <li className="text-muted-foreground">{refusal.omitted} more.</li>
                ) : null}
              </ul>
            </div>
          ) : null}
          {preview ? (
            <section
              data-graph-share-preview=""
              aria-label="Import preview"
              className="flex flex-col gap-2 rounded-md border border-border p-3"
            >
              <div className="flex flex-col gap-0.5">
                <h3 className="text-sm font-medium text-foreground">{preview.name}</h3>
                <p className="text-[11px] text-muted-foreground">
                  <span className="font-mono">{preview.templateId}</span>
                  {preview.renameTo ? (
                    <>
                      {" "}
                      (imports as <span className="font-mono">{preview.renameTo}</span>)
                    </>
                  ) : null}
                  {preview.author ? ` · by ${preview.author}` : ""}
                  {preview.customTypes > 0 ? ` · ${preview.customTypes} custom types` : ""}
                </p>
                <p className="text-[11px] text-muted-foreground">
                  Digest <span className="font-mono">{preview.digest}</span>
                </p>
              </div>
              <IntegrityNote preview={preview} />
              {preview.signer ? (
                <p className="text-[11px] text-muted-foreground">
                  Key fingerprint{" "}
                  <span className="font-mono">{graphSharingFingerprint(preview.signer.keyId)}</span>
                </p>
              ) : null}
              {preview.integrity === "untrusted-signer" ? (
                <div className="flex items-end gap-2">
                  <div className="flex flex-1 flex-col gap-1">
                    <Label htmlFor="graph-share-signer-label">Trust this key as</Label>
                    <Input
                      id="graph-share-signer-label"
                      value={signerLabel}
                      maxLength={GRAPH_SHARING_BOUNDS.maxKeyLabelChars}
                      onChange={(event) => setSignerLabel(event.target.value)}
                      placeholder="Whose key is it?"
                    />
                  </div>
                  <Button
                    type="button"
                    variant="outline"
                    disabled={!signerLabel.trim() || busy}
                    onClick={() => void trustSigner()}
                  >
                    Trust key
                  </Button>
                </div>
              ) : null}
              {preview.engineDropped ? (
                <p className="text-xs text-muted-foreground">
                  A built-in's export: your copy runs on the graph runtime.
                </p>
              ) : null}
              <GraphCompileCounts compile={preview.compile} />
              <GraphCapabilitySummaryView summary={preview.capabilities} />
            </section>
          ) : null}
          {failure ? (
            <p role="alert" className="text-xs text-failure">
              {failure}
            </p>
          ) : null}
        </div>
        <DialogFooter className="items-center gap-2">
          <input
            ref={fileRef}
            type="file"
            accept=".json,application/json"
            className="hidden"
            aria-label="Bundle file"
            onChange={(event) => void readFile(event)}
          />
          <Button
            type="button"
            variant="outline"
            className="sm:mr-auto"
            onClick={() => fileRef.current?.click()}
          >
            <FileUp className="size-4" />
            Choose file…
          </Button>
          <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          {preview ? (
            <Button type="button" disabled={busy} onClick={() => void call(preview.digest)}>
              {busy ? <Loader2 className="size-4 animate-spin" /> : null}
              Import at this digest
            </Button>
          ) : (
            <Button type="button" disabled={!text.trim() || busy} onClick={() => void call()}>
              {busy ? <Loader2 className="size-4 animate-spin" /> : null}
              Check
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
