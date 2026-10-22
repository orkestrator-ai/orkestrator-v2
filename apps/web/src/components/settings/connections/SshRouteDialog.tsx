import { useState, type FormEvent } from "react";
import { Fingerprint, Loader2 } from "lucide-react";
import type { ConnectionSummary } from "@orkestrator/protocol/connections";
import { Button } from "@/components/ui/button";
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
import { Z_FULLSCREEN_DIALOG } from "@/constants/z-index";
import { publishConnections } from "@/lib/connections";
import { cn } from "@/lib/utils";

type HostKeyReview = {
  probeId: string;
  destination: string;
  fingerprints: Array<{ type: string; fingerprint: string }>;
};

/** A typed failure from the native layer keeps its code as a `[code]` prefix. */
export function errorCode(error: unknown): string | null {
  const text = error instanceof Error ? error.message : String(error);
  return /\[([a-z][a-z-]{1,40})\]/.exec(text)?.[1] ?? null;
}

function errorText(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return text
    .replace(/^.*?\[[a-z][a-z-]{1,40}\]\s*/, "")
    .replace(/^Error invoking remote method '[^']+': (Error: )?/, "");
}

export const DEFAULT_REMOTE_CLIENT_GATEWAY_PORT = "34125";

/**
 * Add a managed SSH route: system OpenSSH forwards a loopback port to the
 * remote backend's loopback client gateway, and the ordinary gateway token
 * is still required on top of SSH. Uses the user's own SSH configuration
 * (aliases, keys, jump hosts) without forcing a user or port. A first-use
 * host key is shown for explicit approval; a changed key is never accepted
 * here.
 */
export function SshRouteDialog({
  open,
  onOpenChange,
  machine,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Add the route to this machine instead of onboarding a new one. */
  machine?: ConnectionSummary | null;
}) {
  const api = window.orkestrator?.connections;
  const [destination, setDestination] = useState("");
  const [sshPort, setSshPort] = useState("");
  const [identityFile, setIdentityFile] = useState("");
  const [gatewayPort, setGatewayPort] = useState(DEFAULT_REMOTE_CLIENT_GATEWAY_PORT);
  const [token, setToken] = useState("");
  const [nickname, setNickname] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [review, setReview] = useState<HostKeyReview | null>(null);

  const connect = async () => {
    if (!api?.connectSsh) return;
    setBusy(true);
    setError(null);
    try {
      const list = await api.connectSsh({
        destination,
        remoteGatewayPort: Number(gatewayPort),
        token,
        ...(sshPort.trim() ? { sshPort: Number(sshPort) } : {}),
        ...(identityFile.trim() ? { identityFile: identityFile.trim() } : {}),
        ...(nickname.trim() ? { nickname: nickname.trim() } : {}),
        ...(machine ? { connectionId: machine.id } : {}),
      });
      publishConnections(list);
      onOpenChange(false);
      setToken("");
    } catch (failure) {
      if (errorCode(failure) === "host-key-unknown" && api.probeSshHostKey) {
        try {
          const probe = await api.probeSshHostKey({
            destination,
            ...(sshPort.trim() ? { sshPort: Number(sshPort) } : {}),
          });
          setReview(probe);
        } catch (probeFailure) {
          setError(errorText(probeFailure));
        }
      } else {
        setError(errorText(failure));
      }
    } finally {
      setBusy(false);
    }
  };

  const trust = async () => {
    if (!review || !api?.trustSshHostKey) return;
    setBusy(true);
    try {
      await api.trustSshHostKey(review.probeId);
      setReview(null);
      await connect();
    } catch (failure) {
      setError(errorText(failure));
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(next) => !busy && onOpenChange(next)}>
      <DialogContent
        className={cn("sm:max-w-lg", Z_FULLSCREEN_DIALOG)}
        overlayClassName={Z_FULLSCREEN_DIALOG}
      >
        {review ? (
          <div className="space-y-4">
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                <Fingerprint className="h-4 w-4" /> Verify the SSH host key
              </DialogTitle>
              <DialogDescription>
                This is the first connection to{" "}
                <span className="font-mono">{review.destination}</span>. Compare the fingerprint
                with the machine (for example with{" "}
                <span className="font-mono">ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub</span>)
                before trusting it. Orkestrator stores approved keys in its own known_hosts file and
                never accepts a changed key automatically.
              </DialogDescription>
            </DialogHeader>
            <ul className="space-y-1 rounded-md border border-zinc-800 bg-zinc-950/60 p-3 font-mono text-xs">
              {review.fingerprints.map((entry) => (
                <li key={entry.fingerprint}>
                  {entry.type} {entry.fingerprint}
                </li>
              ))}
            </ul>
            {error ? <p className="text-sm text-red-300">{error}</p> : null}
            <DialogFooter>
              <Button type="button" variant="ghost" onClick={() => setReview(null)} disabled={busy}>
                Don’t trust
              </Button>
              <Button type="button" onClick={() => void trust()} disabled={busy}>
                {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                Trust and connect
              </Button>
            </DialogFooter>
          </div>
        ) : (
          <form
            onSubmit={(event: FormEvent) => {
              event.preventDefault();
              void connect();
            }}
          >
            <DialogHeader>
              <DialogTitle>
                {machine ? `Add SSH route to ${machine.name}` : "Add a machine over SSH"}
              </DialogTitle>
              <DialogDescription>
                Connects to a backend that is already running on the remote machine. Start it with{" "}
                <span className="font-mono">--loopback-client-port</span> so SSH can reach its
                client gateway; the gateway token is still required.
              </DialogDescription>
            </DialogHeader>
            <div className="grid gap-3 py-4">
              <div className="grid gap-1.5">
                <Label htmlFor="ssh-destination">SSH destination or alias</Label>
                <Input
                  id="ssh-destination"
                  placeholder="build-machine or user@host"
                  value={destination}
                  onChange={(event) => setDestination(event.target.value)}
                  autoComplete="off"
                  spellCheck={false}
                  disabled={busy}
                  required
                />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div className="grid gap-1.5">
                  <Label htmlFor="ssh-port">SSH port (optional)</Label>
                  <Input
                    id="ssh-port"
                    inputMode="numeric"
                    placeholder="From your SSH config"
                    value={sshPort}
                    onChange={(event) => setSshPort(event.target.value)}
                    disabled={busy}
                  />
                </div>
                <div className="grid gap-1.5">
                  <Label htmlFor="ssh-gateway-port">Remote client gateway port</Label>
                  <Input
                    id="ssh-gateway-port"
                    inputMode="numeric"
                    value={gatewayPort}
                    onChange={(event) => setGatewayPort(event.target.value)}
                    disabled={busy}
                    required
                  />
                </div>
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="ssh-identity">Identity file (optional)</Label>
                <Input
                  id="ssh-identity"
                  placeholder="~/.ssh/id_ed25519 — from your SSH config if blank"
                  value={identityFile}
                  onChange={(event) => setIdentityFile(event.target.value)}
                  autoComplete="off"
                  spellCheck={false}
                  disabled={busy}
                />
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="ssh-token">Gateway token</Label>
                <Input
                  id="ssh-token"
                  type="password"
                  value={token}
                  onChange={(event) => setToken(event.target.value)}
                  autoComplete="off"
                  disabled={busy}
                  required
                />
              </div>
              {!machine ? (
                <div className="grid gap-1.5">
                  <Label htmlFor="ssh-nickname">Nickname on this device (optional)</Label>
                  <Input
                    id="ssh-nickname"
                    value={nickname}
                    onChange={(event) => setNickname(event.target.value)}
                    maxLength={64}
                    disabled={busy}
                  />
                </div>
              ) : null}
              <p className="text-[11px] leading-relaxed text-zinc-500">
                Your SSH configuration is trusted local configuration: it can run programs (for
                example ProxyCommand). Use an alias without LocalForward, RemoteForward or
                DynamicForward; Orkestrator refuses aliases that open extra forwards.
              </p>
              {error ? (
                <p className="text-sm text-red-300" role="alert">
                  {error}
                </p>
              ) : null}
            </div>
            <DialogFooter>
              <Button
                type="button"
                variant="ghost"
                onClick={() => onOpenChange(false)}
                disabled={busy}
              >
                Cancel
              </Button>
              <Button type="submit" disabled={busy}>
                {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                {busy ? "Connecting…" : "Connect"}
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
