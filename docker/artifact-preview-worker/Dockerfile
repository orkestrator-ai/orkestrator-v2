# Artifact preview worker: runs one transcript-artifact preview job per
# container, launched by the backend supervisor with
#   docker run --rm -i --network none --read-only --tmpfs /tmp:size=64m
#     --memory 1g --cpus 2 --pids-limit 128 --user pwuser --cap-drop ALL
#     --security-opt no-new-privileges --security-opt seccomp=<seccomp_profile.json>
# and no repository, home, credential, Docker-socket or host-network mounts.
# The job package arrives on stdin and bounded results leave on stdout.
#
# Build with docker/artifact-preview-worker/build.sh (it stages the worker
# bundle and the pinned renderer bundles into the build context).
#
# Base image pin: Playwright's official image for the repository's pinned
# playwright-core version, by multi-architecture index digest. Refresh with
#   docker buildx imagetools inspect mcr.microsoft.com/playwright:v<version>-noble
# whenever apps/backend/package.json changes playwright-core.
FROM mcr.microsoft.com/playwright:v1.64.0-noble@sha256:06a9939e57531807f8d5fd76ce44b53165ffb7d7501d87ab10e285c20b1e971f

ENV NODE_ENV=production \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    HOME=/tmp

WORKDIR /opt/artifact-preview-worker

# playwright-core matching the image's browsers, installed exactly as locked
# (package-lock.json, generated with this base image's npm); `npm ci` fails if
# the lockfile and manifest disagree. No lifecycle scripts.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund \
    && npm cache clean --force

# Worker bundle plus pinned Mermaid/DOMPurify/d3 bundles (hash-verified at
# stage time and again by the worker at load time) and their license texts.
COPY preview-worker.mjs mermaid.min.js purify.min.js d3.min.js THIRD_PARTY_NOTICES.txt ./
COPY licenses ./licenses
# Pinned pdf.js (first-page previews of PDF attachments), verified the same way.
COPY pdf.min.mjs pdf.worker.min.mjs ./

# Chromium's own sandbox is required: it needs user namespaces, which the
# supervisor's seccomp profile permits. Never add --no-sandbox.
USER pwuser
ENTRYPOINT ["node", "/opt/artifact-preview-worker/preview-worker.mjs"]
