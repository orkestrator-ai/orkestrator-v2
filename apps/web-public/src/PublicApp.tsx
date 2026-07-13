import { type FormEvent, lazy, Suspense, useEffect, useRef, useState } from "react";
import { ArrowRight, Eye, EyeOff, Loader2, LockKeyhole, Network, RadioTower } from "lucide-react";
import { installBrowserGatewayApi } from "@/lib/native/web-gateway";
import orkLogo from "../../../logos/ork-logo.png";
import {
  checkBackendConnection,
  forgetConnection,
  insecureBackendWarning,
  loadSavedConnection,
  normalizeBackendAddress,
  saveConnection,
  SKIP_AUTO_CONNECT_KEY,
  updateSavedToken,
  type SavedConnection,
} from "./connection";

interface ActiveConnection extends SavedConnection {
  address: string;
}

const OrkestratorApp = lazy(() => import("@/App"));

export function PublicApp() {
  const initialConnection = useRef(loadSavedConnection());
  const autoConnectStarted = useRef(false);
  const [address, setAddress] = useState(initialConnection.current.address);
  const [token, setToken] = useState(initialConnection.current.token);
  const [rememberToken, setRememberToken] = useState(initialConnection.current.rememberToken);
  const [showToken, setShowToken] = useState(false);
  const [hasSavedConnection, setHasSavedConnection] = useState(
    Boolean(initialConnection.current.address || initialConnection.current.token),
  );
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [activeConnection, setActiveConnection] = useState<ActiveConnection | null>(null);

  const connect = async (connection: SavedConnection) => {
    setConnecting(true);
    setError(null);
    try {
      const normalizedAddress = await checkBackendConnection(connection.address, connection.token);
      const normalizedConnection = {
        ...connection,
        address: normalizedAddress,
        token: connection.token.trim(),
      };
      saveConnection(normalizedConnection);
      setHasSavedConnection(true);
      installBrowserGatewayApi(window, {
        baseUrl: normalizedAddress,
        token: normalizedConnection.token,
        replaceExisting: true,
        onTokenChanged: (nextToken) => updateSavedToken(nextToken, connection.rememberToken),
      });
      setAddress(normalizedAddress);
      setToken(normalizedConnection.token);
      setActiveConnection(normalizedConnection);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setConnecting(false);
    }
  };

  useEffect(() => {
    if (autoConnectStarted.current) return;
    autoConnectStarted.current = true;
    if (sessionStorage.getItem(SKIP_AUTO_CONNECT_KEY)) {
      sessionStorage.removeItem(SKIP_AUTO_CONNECT_KEY);
      return;
    }
    if (initialConnection.current.address && initialConnection.current.token) {
      void connect(initialConnection.current);
    }
  }, []);

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    void connect({ address, token, rememberToken });
  };

  const handleForget = () => {
    forgetConnection();
    setAddress("");
    setToken("");
    setRememberToken(false);
    setHasSavedConnection(false);
    setError(null);
  };

  const handleChangeBackend = () => {
    sessionStorage.setItem(SKIP_AUTO_CONNECT_KEY, "1");
    window.location.reload();
  };

  if (activeConnection) {
    return (
      <>
        <Suspense fallback={<div className="public-app-loading"><Loader2 className="spin" /> Loading Orkestrator…</div>}>
          <OrkestratorApp />
        </Suspense>
        <button
          type="button"
          className="public-connection-chip"
          onClick={handleChangeBackend}
          title={`Connected directly to ${activeConnection.address}`}
        >
          <span aria-hidden="true" />
          <span className="public-connection-chip__address">{new URL(activeConnection.address).host}</span>
          <span className="public-connection-chip__action">Change</span>
        </button>
      </>
    );
  }

  const warning = insecureBackendWarning(address);
  let routeAddress = "your backend";
  try {
    routeAddress = address ? new URL(normalizeBackendAddress(address)).host : routeAddress;
  } catch {
    // Keep the neutral route label while the user is typing an incomplete URL.
  }

  return (
    <main className="connect-page">
      <section className="connect-story" aria-labelledby="connect-title">
        <header className="connect-brand">
          <img src={orkLogo} alt="" />
          <div>
            <strong>Orkestrator</strong>
            <span>Public client</span>
          </div>
        </header>

        <div className="connect-copy">
          <p className="connect-kicker">Your network stays in the loop</p>
          <h1 id="connect-title">The app arrives from Vercel. The work doesn’t go back.</h1>
          <p>
            Choose an Orkestrator backend this browser can reach. Commands, events, terminals,
            and agent sessions travel directly from this device to that node.
          </p>
        </div>

        <div className="route-map" aria-label="Direct connection route">
          <div className="route-node route-node--browser">
            <span className="route-node__icon"><Network aria-hidden="true" /></span>
            <span><b>This browser</b><small>client loaded</small></span>
          </div>
          <div className="route-wire" aria-hidden="true"><i /></div>
          <div className="route-node route-node--backend">
            <span className="route-node__icon"><RadioTower aria-hidden="true" /></span>
            <span><b>{routeAddress}</b><small>direct over your network</small></span>
          </div>
        </div>

        <p className="static-note">
          <span>Vercel</span> serves static HTML, CSS, and JavaScript only. It is not a traffic proxy.
        </p>
      </section>

      <section className="connect-panel" aria-label="Backend connection">
        <div className="connect-form-wrap">
          <div className="connect-form-heading">
            <span className="connect-form-icon"><LockKeyhole aria-hidden="true" /></span>
            <div>
              <h2>Connect to a backend</h2>
              <p>The address and token stay in this browser.</p>
            </div>
          </div>

          <form onSubmit={handleSubmit}>
            <input
              className="credential-username"
              type="text"
              name="username"
              value={address}
              autoComplete="username"
              tabIndex={-1}
              readOnly
              aria-hidden="true"
            />
            <label htmlFor="backend-address">Backend address</label>
            <input
              id="backend-address"
              type="url"
              inputMode="url"
              value={address}
              onChange={(event) => setAddress(event.target.value)}
              placeholder="https://workstation.tailnet.ts.net"
              autoComplete="url"
              disabled={connecting}
              aria-describedby={warning ? "backend-warning" : "backend-hint"}
              required
            />
            {warning ? (
              <p id="backend-warning" className="field-warning">{warning}</p>
            ) : (
              <p id="backend-hint" className="field-hint">Use the HTTPS origin exposed inside your tailnet.</p>
            )}

            <label htmlFor="gateway-token">Gateway token</label>
            <div className="token-field">
              <input
                id="gateway-token"
                type={showToken ? "text" : "password"}
                value={token}
                onChange={(event) => setToken(event.target.value)}
                placeholder="Token from gateway-auth.json"
                autoComplete="current-password"
                disabled={connecting}
                required
              />
              <button
                type="button"
                onClick={() => setShowToken((shown) => !shown)}
                aria-label={showToken ? "Hide gateway token" : "Show gateway token"}
                disabled={connecting}
              >
                {showToken ? <EyeOff aria-hidden="true" /> : <Eye aria-hidden="true" />}
              </button>
            </div>

            <label className="remember-choice">
              <input
                type="checkbox"
                checked={rememberToken}
                onChange={(event) => setRememberToken(event.target.checked)}
                disabled={connecting}
              />
              <span><b>Remember token</b><small>Otherwise it lasts for this browser tab.</small></span>
            </label>

            {error && <div className="connect-error" role="alert">{error}</div>}

            <button className="connect-button" type="submit" disabled={connecting}>
              {connecting ? <Loader2 className="spin" aria-hidden="true" /> : <RadioTower aria-hidden="true" />}
              {connecting ? "Checking private route…" : "Connect directly"}
              {!connecting && <ArrowRight className="connect-button__arrow" aria-hidden="true" />}
            </button>
          </form>

          {hasSavedConnection && (
            <button className="forget-button" type="button" onClick={handleForget} disabled={connecting}>
              Forget saved connection
            </button>
          )}
        </div>
      </section>
    </main>
  );
}
