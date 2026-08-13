# Orkestrator backend

Run the Orkestrator backend service without installing the desktop application:

```bash
bunx orkestrator
```

The service stays in the foreground and stops cleanly when it receives Ctrl-C,
SIGINT, or SIGTERM. It stores persistent state in the normal Orkestrator data
directory.

For the hosted web client, publish the backend through Tailscale Serve and allow
the Orkestrator origins:

```bash
bunx orkestrator \
  --tailscale-serve \
  --allowed-origins https://orkestrator.dev,https://www.orkestrator.dev
```

For a loopback-only service:

```bash
bunx orkestrator \
  --host 127.0.0.1 \
  --port 34121 \
  --allow-non-tailscale-bind
```

Or install Bun when needed and start the service in one command:

```bash
curl -fsSL https://orkestrator.dev/install.sh | bash
```

Pass backend arguments through the installer with `bash -s --`:

```bash
curl -fsSL https://orkestrator.dev/install.sh | \
  bash -s -- --tailscale-serve \
  --allowed-origins https://orkestrator.dev,https://www.orkestrator.dev
```

macOS and Linux are supported. Docker is required for container environments;
Tailscale is required only for tailnet access and Tailscale Serve.

## Publishing

`dependencies` here lists only the modules `scripts/build.ts` leaves unbundled;
everything else is inlined into `dist/` and `resources/`. `tests/cli.test.ts`
derives that list from the built artifacts, so adding a dependency the bundles do
not resolve — or bumping one in `apps/backend` or `bridges/` without mirroring it
here — fails the suite.

Publish from the repository root:

```bash
bun run publish:cli
```

That runs `smoke:cli` first, which packs the tarball, installs it into a scratch
project, checks the unbundled dependencies resolve from the installed layout, and
starts and stops the backend. It needs network access, which is why it is a
publish gate rather than part of `bun run test`.
