# Two-machine service preview runbook

Status: Living — how to run the two-machine tailnet qualification for service
previews, the tool it uses, and what to record.

This run gates remote desktop previews by default. The gate, the
performance-threshold item and the evidence log are in
[0042-service-preview-rollout.md](../todo/previews-and-annotations/0042-service-preview-rollout.md)
(§"Qualification": "Two-machine tailnet" and "Performance thresholds";
§"Evidence log"). How previews work is in
[browser-previews.md](../architecture/browser-previews.md).

**No latency or resource thresholds are set yet.** The first two-machine
baseline sets them: record the numbers, propose thresholds in 0042, and do not
mark a route as passing or failing on latency until they are agreed. The
qualitative checks below (decoy at zero, bounded queues, recovery after loss)
do pass or fail.

## What the run covers

1. A decoy on the client machine that no request ever reaches.
2. Real-latency baselines for the direct, legacy, desktop tunnel and private
   origin routes.
3. A throttled link: backend queues stay bounded, memory does not grow.
4. Network loss and reconnect.
5. Publication reached from the second machine (only when testing it).

Two machines: **B** runs the backend and the application; **C** runs the
desktop app, the decoy and the measurement tool.

## The tool

`scripts/preview-latency-baseline.ts` runs on C. It never prints tokens,
tunnel credentials, grants, session codes, cookies or response bodies: it
checks its output for every secret it handled before writing it, and refuses
to print if one would appear. The gateway token comes from
`ORKESTRATOR_PREVIEW_BASELINE_TOKEN` or `--token-file` (a raw token or a
`gateway-auth.json`); it is never accepted on the command line.
`bun scripts/preview-latency-baseline.ts --help` lists every option.

| Subcommand | Purpose |
| --- | --- |
| (none) | Latency baseline for one registered service. JSON on stdout, a Markdown table on stderr. Exit 0, or 2 when a route failed. |
| `decoy` | Listener on C's loopback (127.0.0.1 and ::1) on the remote service's port. Logs each connection, never its contents; prints the count on Ctrl-C and exits 1 if anything connected. |
| `throttle` | Userspace TCP forwarder on C's loopback adding one-way latency and a shared per-direction rate cap. No admin rights needed. |
| `watch` | Polls `get_preview_diagnostics` (numbers only) as JSON lines; prints the peak of every gauge on Ctrl-C. |
| `download` | One GET over the real desktop tunnel, read at a capped rate, with the backend's tunnel gauges once a second. A slow reader for the throttled run. |

Each baseline sample uses a fresh connection, sends one `GET <path>`, and
stops at the first response byte. Warm-ups are not measured. Percentiles are
nearest-rank, the same method as `preview-bench.test.ts` and `PreviewMetrics`.
A sample fails on a transport error, a timeout or an HTTP 5xx; failed samples
are counted and left out of the percentiles.

| Route | Path from C | Connect time ends at | Skipped or unreachable when |
| --- | --- | --- | --- |
| `direct` | Plain HTTP to the service's host port at the backend URL's address | TCP connect | The service binds loopback on B (expected: `unreachable`); the backend URL is loopback (`--direct auto` never sends to C's own loopback); relay or HTTPS service |
| `legacy` | `/__orkestrator/browser/loopback/<host port>/` on the gateway with the bearer token | TCP (or TLS) connect to the gateway | No host port, HTTPS service |
| `desktop-tunnel` | One `desktop-tunnel` attachment (`create_preview_attachment`), then Electron's `openPreviewTunnel` per sample, sending what the Electron ingress sends | `OPEN_OK` (WebSocket handshake, HELLO, OPEN and the backend's upstream connect) | B's capabilities say the tunnel is off (the reason is copied) |
| `private-origin` | `create_preview_handoff_url`, the one-use session code exchanged for the session cookie, then TLS GETs to the service host | TLS handshake (fresh, no resumption) | Publication is not enabled on B (the reason is copied) |

The JSON also has one-off setup times (`setupMs`: attachment issuance,
handoff, session exchange), the backend's capabilities, and
`get_preview_diagnostics` numbers before sampling, after sampling and after
release. The tool releases every attachment it created, including the one
behind the handoff URL.

Limits: Electron pools idle tunnel connections, so in-app repeated requests
can be faster than a fresh-connection sample. HMR delivery is not measured,
and nothing records reconnect time; time those by hand (see below).

## Prerequisites

- Both machines on one tailnet. Run `tailscale ip -4` on B and
  `export B_IP=<that address>` in every shell on both machines. From C, `tailscale ping $B_IP` says whether the path is direct or relayed
  through DERP; record it, because a relayed path has very different latency.
- The same commit on both, dependencies installed
  (`mise exec -- bun install --frozen-lockfile`).
- No production profile is used on either machine. B runs a standalone backend
  on a throwaway data directory and a non-default port; C uses an isolated
  `dev:test` profile. Never point anything at
  `~/Library/Application Support/orkestrator-v2` or `~/.config/orkestrator-v2`.

### Backend machine (B)

```bash
export ORK_2M=$(mktemp -d /tmp/ork-2m.XXXXXX)
bun apps/backend/src/main.ts --data-dir "$ORK_2M/data" --host "$B_IP" --port 34190
```

This serves plain HTTP on the Tailscale address. Remote previews follow B's
capabilities, not the client's, so the transport must be on for B: once C is
connected, turn on **Issue new preview access** in **Settings → Previews**.
Starting B with `ORKESTRATOR_PREVIEW_TRANSPORT=1` also works, but the
override pins the switch, and the compatibility-mode check below needs to turn
it off. The token is in `$ORK_2M/data/gateway-auth.json`
(mode 0600). Copy it to C over a private channel (for example `scp`) into a
mode-0600 file; never paste it into chat, a ticket or the evidence log.

The application, on B's loopback only, so the direct route from C cannot reach
it:

```bash
HOST=127.0.0.1 PORT=5173 FIXTURE_MARKER=remote-app bun test-fixtures/preview-app/server.ts
```

Register it once C is connected (next section): add a throwaway project on B
with a local environment, then **Environment settings → Preview services** →
register a backend-host service on port 5173 labelled `remote-app`. A Docker
service (published with Auto) works too; its host port differs from its
application port, so run a decoy on both.

### Client machine (C)

```bash
ORKESTRATOR_PREVIEW_TRANSPORT=1 mise run dev:test --profile preview-2m
```

The variable affects only C's own local backend in that profile (agent-test
backends keep it); it is set so local and remote previews behave alike. In the
window, **Settings → Connections → Add machine** with `http://$B_IP:34190` and
the token.

## 1. Decoy on the client

Start it before opening any preview, on the remote service's port (and on its
host port too if they differ). Nothing else on C may hold that port; stop any
local server using it first.

```bash
bun scripts/preview-latency-baseline.ts decoy --port 5173
```

Keep it running for the whole run, through every section below. Nothing may
connect: not the service tab, not compatibility mode (turn **Issue new preview
access** off for B, reopen the tab, then turn it back on), not **Open in
browser**, not the baseline tool. Remote previews block requests
to C's loopback and private addresses other than their own ingress, and the
baseline tool's `--direct auto` targets B's address, never C's. On Ctrl-C it
prints `{"decoy":{…,"connections":0,"requests":0}}`; any other count fails the
run. Each connection is logged on stderr with a timestamp; use it to find the
action responsible.

## 2. Real-latency baselines

With the decoy running and no previews open:

```bash
bun scripts/preview-latency-baseline.ts --url "http://$B_IP:34190" \
  --token-file ~/ork-2m-token.json --service remote-app --path /health \
  --samples 200 --warmups 10 \
  --label "2m idle: C <os/arch> -> B <os/arch>, <direct|DERP>, <Wi-Fi|Ethernet>" \
  > 2m-idle.json
```

Expect `direct` to be `unreachable` and the other routes `measured` (or
`private-origin` skipped while publication is off). Repeat with the same
command and a new label for each condition: idle, throttled (section 3),
after a reconnect (section 4), and with publication on (section 5). Paste the
stderr table into the evidence log and keep the JSON files.

## 3. Throttled link

Pick one way to slow the link.

**Without admin rights (gateway only).** On C:

```bash
bun scripts/preview-latency-baseline.ts throttle --listen 44190 \
  --target "$B_IP:34190" --latency-ms 50 --rate-kib 256
```

Point the baseline and the other subcommands at `http://127.0.0.1:44190`, and
add the same address as a machine in C's window (with the same token) for the
in-app checks. Electron treats it as a remote connection: the remote guards
follow the connection, not its address. This works only while B serves plain
HTTP, and it shapes only traffic sent to it: the control API, events, the
legacy route and the tunnel. To shape a private origin too, run a second
throttle with `--listen <publication port> --target $B_IP:<publication port>`
and pass `--publication-address 127.0.0.1`. Through the throttle, connect
times measure the local accept; read first-byte times. It adds no loss or
jitter.

**Whole link, admin rights.** Not run by any repository tooling; do it on C
and undo it afterwards. On macOS use Network Link Conditioner (Xcode
Additional Tools), or dummynet:

```bash
sudo dnctl pipe 1 config bw 2Mbit/s delay 50
printf 'dummynet out quick proto tcp from any to %s pipe 1\ndummynet in quick proto tcp from %s to any pipe 1\n' \
  "$B_IP" "$B_IP" | sudo pfctl -a com.apple/orkestrator-2m -f -
sudo pfctl -E          # prints a reference token; keep it
# undo
sudo pfctl -a com.apple/orkestrator-2m -F all
sudo dnctl -q flush
sudo pfctl -X <token>
```

On Linux: `sudo tc qdisc add dev tailscale0 root netem delay 50ms rate 2mbit`,
undone with `sudo tc qdisc del dev tailscale0 root`. These recipes were not
checked against Tailscale's interfaces when this page was written; confirm
with a baseline run that latency actually changed before relying on them.

Then observe:

1. The baseline under throttle, with the throttle parameters in the label.
2. A slow reader. In one terminal on C, `watch`; in another, `download`
   (`URL` is `http://127.0.0.1:44190` through the userspace throttle, else
   `http://$B_IP:34190`):

   ```bash
   bun scripts/preview-latency-baseline.ts watch --url "$URL" --token-file ~/ork-2m-token.json
   bun scripts/preview-latency-baseline.ts download --url "$URL" \
     --token-file ~/ork-2m-token.json --service remote-app \
     --path /endless --seconds 120 --read-kib 32
   ```

   `/endless` streams until the reader stops. `tunnel.queued_bytes` (the
   aggregate backend queue toward clients) must stay within 256 KiB plus one
   32 KiB frame per open tunnel, and well under the 64 MiB aggregate cap. On a
   loopback self-test it held at 262,176 bytes for one tunnel. After the
   download, `tunnel.sockets`, `tunnel.active` and `access.attachments` return
   to their earlier values.
3. Backend memory on B while the reader runs:
   `while sleep 10; do ps -o rss= -p <backend pid>; done`. It levels off; it
   must not grow with time.
4. In C's window, open `remote-app` in a service tab and load `/binary`
   (1 MiB) and `/sse`. Pages load slowly but completely, the app stays
   responsive, and the tab's **Diagnostics** shows the transport `ready`.

`watch` and the baseline JSON read `PreviewMetrics`
(`apps/backend/src/preview-metrics.ts`) through `get_preview_diagnostics`:

| Name | Kind | Meaning |
| --- | --- | --- |
| `tunnel.open_ms` | Histogram | Backend side, from WebSocket accept to the upstream connect for `OPEN` (includes one client round trip) |
| `http.connect_ms` | Histogram | Private-origin proxy: upstream connect per request |
| `http.first_byte_ms` | Histogram | Private-origin proxy: from the upstream connect to the upstream response head |
| `tunnel.sockets`, `tunnel.active`, `tunnel.queued_bytes` | Gauges | Open tunnel WebSockets, admitted tunnels, aggregate queued bytes toward clients |
| `publication.sockets`, `publication.http_active`, `publication.upgrades_active` | Gauges | Private-origin listener |
| `legacy.http_active` | Gauge | Legacy route requests in flight |
| `relay.processes`, `relay.channels` | Gauges | Container relay |
| `tunnel.open`, `tunnel.failed{…}`, `http.failed{…}`, … | Counters | Totals since the backend started, labelled by failure category |

Histograms keep the last 512 samples in whole milliseconds and report p50,
p95 and max (nearest rank). Diagnostics never contain URLs, paths, headers or
credentials.

## 4. Network loss and reconnect

Keep the decoy and `watch` running (its lines show `null` diagnostics while B
is unreachable), with a service tab open on `remote-app`. Note the time of
each step.

1. Cut the path for about 10 seconds: `tailscale down` on C (or turn Wi-Fi
   off), then `tailscale up`.
2. Repeat for about 90 seconds, longer than the 30-second tunnel liveness ping
   and its timeout, so B closes the tunnels on its side.
3. Optional: restart B's backend (Ctrl-C and the same command). The backend
   epoch changes, so every attachment is revoked.

Expected:

- During the outage requests fail. Nothing in flight is replayed. The tab's
  **Diagnostics** transport state is one of `connecting`, `ready`,
  `reconnecting` or `unavailable` (with a failure category); it must not stay
  in `connecting` or `reconnecting` once B is reachable again.
- After the path returns, a reload (or **Reload preview**) loads the page
  through the tunnel without restarting the app. After a backend restart the
  tab gets a fresh attachment (`reconnecting`, then `ready`).
- On B, `tunnel.sockets` drops to zero within about a minute of a long cut;
  after recovery the gauges and `access.attachments` match the open tabs.
- The decoy still shows zero.

Record per step: outage length, what the tab and Diagnostics showed, time from
`tailscale up` to the first successful load, whether a reload was needed, any
error text, and the gauges after recovery. Then run one baseline labelled
"after reconnect".

## 5. Publication from the second machine

Only when testing publication. On B, make a throwaway CA and a wildcard
certificate for `*.preview.test` with the test helper:

```bash
mkdir "$ORK_2M/pki"
PKI="$ORK_2M/pki" bun -e 'import { certificates } from "./apps/backend/src/preview-test-pki.ts"; certificates(process.env.PKI);'
```

In C's window, connected to B, **Settings → Previews**: tick **Publish
private preview origins** and set **Preview domain** `preview.test`,
**Certificate file (PEM)** `$ORK_2M/pki/leaf.pem`, **Private key file (PEM)**
`$ORK_2M/pki/leaf.key`, **Listen address** `$B_IP` and **Listen port** 8443
(paths are on B). Copy
`$ORK_2M/pki/ca.pem` (the public certificate only) to C, then:

```bash
bun scripts/preview-latency-baseline.ts --url "http://$B_IP:34190" \
  --token-file ~/ork-2m-token.json --service remote-app --path /health \
  --routes private-origin --samples 200 --warmups 10 \
  --ca-file ca.pem --publication-address "$B_IP" --label "2m publication" \
  > 2m-publication.json
```

`--publication-address` stands in for DNS, so this proves the listener,
bootstrap and session over the tailnet, not name resolution. Opening the
service in a real browser on C (**Open in browser**) needs `*.preview.test` to
resolve to `$B_IP` and the CA to be trusted; that belongs to the real private
DNS and certificates item in 0042 unless split DNS is already in place.

## Cleanup

On C:

- Stop `watch`, `download` and `throttle`; stop the decoy last and record its
  final count.
- Remove any dummynet rules, Network Link Conditioner profile or `tc` qdisc.
- `mise run dev:stop --profile preview-2m`, then
  `mise run dev:reset --profile preview-2m`.
- Delete the token copy and `ca.pem`.

On B:

- Stop the backend and the fixture (Ctrl-C).
- `rm -rf "$ORK_2M"`: the data directory, the token and the CA key.

## What to record

Add one dated entry to §"Evidence log" in
[0042-service-preview-rollout.md](../todo/previews-and-annotations/0042-service-preview-rollout.md),
following its existing entries:

- Commit on each machine; OS, version and architecture of each; Bun,
  Electron and Tailscale versions; link type; `tailscale ping` result (direct
  or DERP, round-trip time).
- Effective capabilities (`backend.capabilities` in the JSON) and the variables
  set on each machine.
- The exact commands, with the token file shown as a placeholder.
- One baseline table per condition (idle, each throttle setting, after
  reconnect, publication), with sample counts and failures. Skipped routes
  with their reasons.
- Decoy totals per port.
- Throttled run: parameters, peak `tunnel.queued_bytes` and other gauge
  peaks from `watch`, the backend RSS series, and the in-app observations.
- Loss and reconnect: the timeline and observations from section 4.
- Anything not run, and why; cleanup done on both machines.
- Proposed thresholds, if this is the first baseline: first-byte and connect
  p95 per route, peak queued bytes and socket counts. HMR delivery and
  reconnect time have no metric yet; give the hand-timed values.

Never record tokens, handoff URLs, cookies or tailnet host names; the JSON
reports the backend only as a host kind.

## One-machine self-test

The tool's own checks run on loopback and are not two-machine evidence:

```bash
bun test ./tests/unit/preview-latency-baseline.test.ts --parallel=1
ORKESTRATOR_PREVIEW_BENCH=1 bun test --cwd apps/backend ./src/preview-latency-baseline.test.ts --parallel=1
```

The second runs the CLI end to end against
`apps/backend/src/preview-baseline-harness.ts`: the real gateway, command API,
tunnel and private-origin listener over a throwaway data directory and CA,
with one fixture service. Run the harness alone with
`bun apps/backend/src/preview-baseline-harness.ts`; it prints the gateway URL,
token file and CA file (never the token) and stops when stdin closes.
