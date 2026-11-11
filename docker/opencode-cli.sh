#!/bin/sh
# `opencode` in a container: the image's OpenCode 2.x, the only OpenCode the
# image ships (/opt/opencode/bin/opencode2, also on PATH as `opencode2`).
#
# Installed root-owned as /opt/opencode/bin/opencode, and reached through
# node's ~/.opencode/bin/opencode. It runs as whoever calls it and is never
# run by root: a root shell has neither directory on its PATH.
#
# 2.x's default database is `opencode.db`, the file OpenCode 1.x left behind,
# which 2.x would migrate in place. The container's 2.x server keeps its own
# (`opencode2.db`, on the persistent mount when the runtime has one; see
# apps/backend/src/core/container-state-layout.ts), and so does a command run
# here unless the caller chose a database: sessions and the sign-ins
# Orkestrator stores there are the same ones the server sees.
if [ -z "${OPENCODE_DB:-}" ]; then
    if mountpoint -q /home/node/.local/share/opencode/orkestrator-db 2>/dev/null; then
        OPENCODE_DB=/home/node/.local/share/opencode/orkestrator-db/opencode2.db
    else
        OPENCODE_DB=/home/node/.local/share/opencode/opencode2.db
    fi
    export OPENCODE_DB
fi
# The binary is the image's pin; it cannot replace itself.
export OPENCODE_DISABLE_AUTOUPDATE=1
exec /opt/opencode/bin/opencode2 "$@"
