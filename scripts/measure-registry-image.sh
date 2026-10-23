#!/bin/bash
# Registry measurements for a published environment image (0019): resolves a
# tag or digest to its multi-architecture index and reports, per platform,
# the manifest digest, layer count, largest layers and compressed bytes
# (layers + config), read from the manifests alone.
#
#   scripts/measure-registry-image.sh [options] <image-ref>
#
#   <image-ref>          e.g. ghcr.io/orkestrator-ai/orkestrator-v2:2.23.0 or
#                        ghcr.io/orkestrator-ai/orkestrator-v2@sha256:<digest>
#   --transfer <os/arch> download every layer and the config blob of that
#                        platform to /dev/null through the registry API and time
#                        it. Cold with respect to the Docker cache by
#                        construction; Docker's own state is not touched.
#   --dind <os/arch>     time a true cold `docker pull` (download + extraction)
#                        into a throwaway privileged docker:dind daemon with its
#                        own empty, labelled volume. The local Docker cache is
#                        never cleared. Needs about 12 GB free in the Docker VM.
#   --concurrency <n>    parallel blob downloads for --transfer (default 3,
#                        Docker's max-concurrent-downloads default).
#   --json <file>        also write the measurements as JSON.
#
# Anonymous pull only: the registry must hand out a pull token without
# credentials (GHCR does for public packages). Every container and volume the
# --dind run creates carries `orkestrator-q0019-registry=<run>` and is removed
# on exit; the docker:dind image is removed again only when this run pulled it.
# Timings are this host's network and load, which the report prints. Exits 0
# when every requested measurement completed, 1 when one failed, 2 on setup
# errors.
set -euo pipefail

usage() { sed -n '2,/^set -euo/p' "$0" | sed '$d; s/^# \{0,1\}//' >&2; exit 2; }

TRANSFER_PLATFORM=""
DIND_PLATFORM=""
CONCURRENCY=3
JSON_OUT=""
REF=""
while [ $# -gt 0 ]; do
    case "$1" in
        --transfer) TRANSFER_PLATFORM="${2:?--transfer needs <os/arch>}"; shift 2 ;;
        --dind) DIND_PLATFORM="${2:?--dind needs <os/arch>}"; shift 2 ;;
        --concurrency) CONCURRENCY="${2:?--concurrency needs a number}"; shift 2 ;;
        --json) JSON_OUT="${2:?--json needs a file}"; shift 2 ;;
        -h|--help) usage ;;
        -*) echo "setup: unknown option $1" >&2; exit 2 ;;
        *) [ -z "$REF" ] || { echo "setup: one image reference only" >&2; exit 2; }; REF="$1"; shift ;;
    esac
done
[ -n "$REF" ] || usage
for tool in curl jq python3; do
    command -v "$tool" >/dev/null || { echo "setup: $tool is required" >&2; exit 2; }
done

# --- Reference parsing --------------------------------------------------------
# registry/repository[:tag][@digest]; the registry is the first path segment.
REGISTRY="${REF%%/*}"
REMAINDER="${REF#*/}"
case "$REGISTRY" in *.*|*:*|localhost) ;; *) echo "setup: give a fully qualified reference (registry/repo:tag)" >&2; exit 2 ;; esac
if [[ "$REMAINDER" == *@* ]]; then
    REPOSITORY="${REMAINDER%%@*}"; REFERENCE="${REMAINDER#*@}"; REPOSITORY="${REPOSITORY%%:*}"
elif [[ "${REMAINDER##*/}" == *:* ]]; then
    REPOSITORY="${REMAINDER%:*}"; REFERENCE="${REMAINDER##*:}"
else
    REPOSITORY="$REMAINDER"; REFERENCE="latest"
fi

STAGE="$(mktemp -d)"
RUN="q0019reg$(python3 -c 'import secrets; print(secrets.token_hex(6))')"
LABEL="orkestrator-q0019-registry=$RUN"
DIND_CONTAINER="" DIND_VOLUME="" DIND_IMAGE_PULLED=0
DIND_IMAGE="docker:dind"
FAILED=0

cleanup() {
    if [ -n "$DIND_CONTAINER" ]; then docker rm -f "$DIND_CONTAINER" >/dev/null 2>&1 || true; fi
    if [ -n "$DIND_VOLUME" ]; then docker volume rm "$DIND_VOLUME" >/dev/null 2>&1 || true; fi
    if [ "$DIND_IMAGE_PULLED" = 1 ]; then docker image rm "$DIND_IMAGE" >/dev/null 2>&1 || true; fi
    rm -rf "$STAGE"
}
trap cleanup EXIT
trap 'exit 2' INT TERM

now() { python3 -c 'import time; print(f"{time.time():.3f}")'; }
elapsed() { python3 -c "import sys; print(f'{float(sys.argv[2]) - float(sys.argv[1]):.2f}')" "$1" "$2"; }
human() { python3 -c "import sys; n=float(sys.argv[1]); print(f'{n/1e6:.1f} MB ({n/2**20:.1f} MiB)')" "$1"; }

# --- Registry access ----------------------------------------------------------
# Bearer realm and service come from the registry's own challenge.
TOKEN=""
fetch_token() {
    local challenge realm service
    challenge="$(curl -sS -o /dev/null -D - "https://$REGISTRY/v2/" | tr -d '\r' \
        | awk 'tolower($1) == "www-authenticate:" { $1 = ""; print }')" || true
    realm="$(sed -n 's/.*realm="\([^"]*\)".*/\1/p' <<< "$challenge")"
    service="$(sed -n 's/.*service="\([^"]*\)".*/\1/p' <<< "$challenge")"
    if [ -z "$realm" ]; then TOKEN=""; return 0; fi
    TOKEN="$(curl -fsS -G "$realm" --data-urlencode "service=$service" \
        --data-urlencode "scope=repository:$REPOSITORY:pull" | jq -r '.token // .access_token // empty')" \
        || { echo "setup: no anonymous pull token from $realm" >&2; exit 2; }
    [ -n "$TOKEN" ] || { echo "setup: empty pull token from $realm" >&2; exit 2; }
}
auth_header() { if [ -n "$TOKEN" ]; then printf 'Authorization: Bearer %s' "$TOKEN"; else printf 'X-No-Auth: 1'; fi; }

ACCEPT="application/vnd.oci.image.index.v1+json,application/vnd.docker.distribution.manifest.list.v2+json,application/vnd.oci.image.manifest.v1+json,application/vnd.docker.distribution.manifest.v2+json"

# get_manifest <reference> <body-file>: sets M_DIGEST, M_MEDIA and M_BYTES.
# Runs in this shell (never a command substitution) so a setup exit or a
# digest failure is not lost in a subshell.
get_manifest() {
    local headers="$STAGE/headers" status digest media computed
    status="$(curl -sS -o "$2" -D "$headers" -w '%{http_code}' -H "$(auth_header)" -H "Accept: $ACCEPT" \
        "https://$REGISTRY/v2/$REPOSITORY/manifests/$1")" || { echo "setup: manifest request failed for $1" >&2; exit 2; }
    [ "$status" = 200 ] || { echo "setup: manifest $1 answered HTTP $status" >&2; exit 2; }
    digest="$(tr -d '\r' < "$headers" | awk 'tolower($1) == "docker-content-digest:" { print $2 }' | tail -n 1)"
    media="$(jq -r '.mediaType // empty' "$2")"
    [ -n "$media" ] || media="$(tr -d '\r' < "$headers" | awk 'tolower($1) == "content-type:" { print $2 }' | tail -n 1)"
    computed="sha256:$(shasum -a 256 "$2" | awk '{ print $1 }')"
    if [ -n "$digest" ] && [ "$digest" != "$computed" ]; then
        echo "FAIL manifest $1: registry digest $digest does not match its body ($computed)"; FAILED=1
    fi
    M_DIGEST="${digest:-$computed}" M_MEDIA="$media" M_BYTES="$(wc -c < "$2" | tr -d ' ')"
}

fetch_token
get_manifest "$REFERENCE" "$STAGE/index.json"
INDEX_DIGEST="$M_DIGEST" INDEX_MEDIA="$M_MEDIA" INDEX_BYTES="$M_BYTES"
LOAD="$(uptime | sed 's/.*load averages*: *//')"
STARTED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

echo "Image      $REGISTRY/$REPOSITORY ($REFERENCE)"
echo "Measured   $STARTED_AT from $(hostname -s) ($(uname -sm)); load averages $LOAD"
echo "Network    this host's connection, not CI"
echo "Index      $INDEX_DIGEST ($INDEX_MEDIA, $INDEX_BYTES bytes)"

# One "<os/arch> <digest>" line per runnable platform; attestation manifests
# (unknown/unknown, buildx provenance) are listed but not measured.
case "$INDEX_MEDIA" in
    *index*|*manifest.list*)
        jq -r '.manifests[] | select(.platform.os != "unknown")
            | "\(.platform.os)/\(.platform.architecture)\(if .platform.variant then "/" + .platform.variant else "" end) \(.digest)"' \
            "$STAGE/index.json" > "$STAGE/platforms"
        attestations="$(jq '[.manifests[] | select(.platform.os == "unknown")] | length' "$STAGE/index.json")"
        echo "Platforms  $(wc -l < "$STAGE/platforms" | tr -d ' ') runnable, $attestations attestation manifest(s)"
        ;;
    *)
        config_digest="$(jq -r '.config.digest' "$STAGE/index.json")"
        platform="$(curl -fsSL -H "$(auth_header)" "https://$REGISTRY/v2/$REPOSITORY/blobs/$config_digest" \
            | jq -r '"\(.os)/\(.architecture)"')"
        echo "$platform $INDEX_DIGEST" > "$STAGE/platforms"
        echo "Platforms  single-platform manifest"
        ;;
esac

: > "$STAGE/summary.jsonl"
while read -r platform digest; do
    file="$STAGE/manifest-$(tr '/' '-' <<< "$platform").json"
    get_manifest "$digest" "$file" < /dev/null
    media="$M_MEDIA" bytes="$M_BYTES"
    jq -c --arg platform "$platform" --arg digest "$digest" --argjson manifestBytes "$bytes" '{
        platform: $platform, digest: $digest, manifestBytes: $manifestBytes,
        configBytes: .config.size, layerCount: (.layers | length),
        layerBytes: ([.layers[].size] | add),
        compressedBytes: (([.layers[].size] | add) + .config.size),
        largestLayers: ([.layers[] | {digest, size}] | sort_by(-.size) | .[:5])
    }' "$file" >> "$STAGE/summary.jsonl"
    entry="$(tail -n 1 "$STAGE/summary.jsonl")"
    echo
    echo "$platform  $digest"
    echo "  manifest   $bytes bytes ($media)"
    echo "  layers     $(jq -r .layerCount <<< "$entry"), $(human "$(jq -r .layerBytes <<< "$entry")")"
    echo "  config     $(jq -r .configBytes <<< "$entry") bytes"
    echo "  compressed $(human "$(jq -r .compressedBytes <<< "$entry")") (layers + config; $(jq -r .compressedBytes <<< "$entry") bytes)"
    echo "  largest    $(jq -r '[.largestLayers[] | "\(.size / 1e6 * 10 | floor / 10) MB"] | join(", ")' <<< "$entry")"
done < "$STAGE/platforms"

manifest_for() { awk -v p="$1" '$1 == p { print $2 }' "$STAGE/platforms"; }

# --- Blob transfer --------------------------------------------------------------
TRANSFER_JSON="null"
if [ -n "$TRANSFER_PLATFORM" ]; then
    digest="$(manifest_for "$TRANSFER_PLATFORM")"
    [ -n "$digest" ] || { echo "setup: $TRANSFER_PLATFORM is not in the index" >&2; exit 2; }
    file="$STAGE/manifest-$(tr '/' '-' <<< "$TRANSFER_PLATFORM").json"
    jq -r '(.layers + [.config])[] | "\(.digest) \(.size)"' "$file" > "$STAGE/blobs"
    fetch_token
    export REGISTRY REPOSITORY STAGE
    AUTH="$(auth_header)"; export AUTH
    echo
    echo "Transfer   $TRANSFER_PLATFORM: $(wc -l < "$STAGE/blobs" | tr -d ' ') blobs, $CONCURRENCY at a time, to /dev/null (load $(uptime | sed 's/.*load averages*: *//'))"
    start="$(now)"
    # Each worker records "<digest> <expected> <downloaded> <seconds> <http>";
    # redirects to the blob storage CDN are followed.
    xargs -P "$CONCURRENCY" -n 2 sh -c '
        curl -sS -L -o /dev/null -H "$AUTH" \
            -w "$0 $1 %{size_download} %{time_total} %{http_code}\n" \
            "https://$REGISTRY/v2/$REPOSITORY/blobs/$0" >> "$STAGE/transfer" || echo "$0 $1 0 0 error" >> "$STAGE/transfer"
    ' < "$STAGE/blobs"
    end="$(now)"
    seconds="$(elapsed "$start" "$end")"
    expected="$(awk '{ s += $2 } END { printf "%.0f", s }' "$STAGE/blobs")"
    received="$(awk '{ s += $3 } END { printf "%.0f", s }' "$STAGE/transfer")"
    bad="$(awk '$2 != $3 || $5 != 200' "$STAGE/transfer" | wc -l | tr -d ' ')"
    slowest="$(sort -k4 -n -r "$STAGE/transfer" | head -n 1 | awk '{ printf "%.1f MB in %.1f s", $3 / 1e6, $4 }')"
    rate="$(python3 -c "import sys; print(f'{float(sys.argv[1]) / float(sys.argv[2]) / 1e6:.1f}')" "$received" "$seconds")"
    echo "  wall time  ${seconds} s for $(human "$received") = ${rate} MB/s"
    echo "  slowest    $slowest"
    if [ "$received" = "$expected" ] && [ "$bad" = 0 ]; then
        echo "PASS transfer: every blob arrived at its descriptor size"
    else
        echo "FAIL transfer: $bad blob(s) short or not HTTP 200 (expected $expected bytes, got $received)"; FAILED=1
    fi
    TRANSFER_JSON="$(jq -n --arg platform "$TRANSFER_PLATFORM" --argjson seconds "$seconds" \
        --argjson bytes "$received" --argjson expected "$expected" --argjson concurrency "$CONCURRENCY" \
        --arg load "$LOAD" --arg loadAfter "$(uptime | sed 's/.*load averages*: *//')" \
        '{platform: $platform, seconds: $seconds, bytes: $bytes, expectedBytes: $expected,
          megabytesPerSecond: (($bytes / $seconds / 1e4 | floor) / 100), concurrency: $concurrency,
          loadBefore: $load, loadAfter: $loadAfter}')"
fi

# --- Cold docker pull into a throwaway daemon ------------------------------------
DIND_JSON="null"
if [ -n "$DIND_PLATFORM" ]; then
    command -v docker >/dev/null || { echo "setup: docker is required for --dind" >&2; exit 2; }
    digest="$(manifest_for "$DIND_PLATFORM")"
    [ -n "$digest" ] || { echo "setup: $DIND_PLATFORM is not in the index" >&2; exit 2; }
    if ! docker image inspect "$DIND_IMAGE" >/dev/null 2>&1; then
        docker pull -q "$DIND_IMAGE" >/dev/null || { echo "setup: could not pull $DIND_IMAGE" >&2; exit 2; }
        DIND_IMAGE_PULLED=1
    fi
    DIND_VOLUME="$RUN-storage"
    docker volume create --label "$LABEL" "$DIND_VOLUME" >/dev/null || exit 2
    DIND_CONTAINER="$RUN-dind"
    docker run -d --privileged --name "$DIND_CONTAINER" --label "$LABEL" \
        -e DOCKER_TLS_CERTDIR= -v "$DIND_VOLUME:/var/lib/docker" "$DIND_IMAGE" \
        dockerd --host=unix:///var/run/docker.sock >/dev/null || exit 2
    ready=0
    for _ in $(seq 1 120); do
        if docker exec "$DIND_CONTAINER" docker info >/dev/null 2>&1; then ready=1; break; fi
        sleep 1
    done
    [ "$ready" = 1 ] || { echo "setup: the throwaway daemon did not start" >&2; exit 2; }
    free_kb="$(docker exec "$DIND_CONTAINER" df -Pk /var/lib/docker | awk 'NR == 2 { print $4 }')"
    images_before="$(docker exec "$DIND_CONTAINER" docker images -q | wc -l | tr -d ' ')"
    echo
    echo "Cold pull  $DIND_PLATFORM into throwaway daemon $DIND_CONTAINER ($((free_kb / 1048576)) GiB free, $images_before images)"
    [ "$images_before" = 0 ] || { echo "setup: the throwaway daemon is not empty" >&2; exit 2; }
    [ "$free_kb" -ge $((12 * 1048576)) ] || { echo "setup: under 12 GiB free in the Docker VM; not pulling" >&2; exit 2; }
    load_before="$(uptime | sed 's/.*load averages*: *//')"
    start="$(now)"
    if docker exec "$DIND_CONTAINER" docker pull -q --platform "$DIND_PLATFORM" \
        "$REGISTRY/$REPOSITORY@$INDEX_DIGEST" > "$STAGE/pull.log" 2>&1; then
        end="$(now)"
        seconds="$(elapsed "$start" "$end")"
        size="$(docker exec "$DIND_CONTAINER" docker image inspect --format '{{.Size}}' "$REGISTRY/$REPOSITORY@$INDEX_DIGEST")"
        id="$(docker exec "$DIND_CONTAINER" docker image inspect --format '{{.Id}}' "$REGISTRY/$REPOSITORY@$INDEX_DIGEST")"
        echo "  pull time  ${seconds} s (download, verification and extraction; load before $load_before, after $(uptime | sed 's/.*load averages*: *//'))"
        echo "  image      $id, $(human "$size") uncompressed"
        echo "PASS cold pull"
        DIND_JSON="$(jq -n --arg platform "$DIND_PLATFORM" --argjson seconds "$seconds" --argjson size "$size" \
            --arg id "$id" --arg loadBefore "$load_before" --arg loadAfter "$(uptime | sed 's/.*load averages*: *//')" \
            '{platform: $platform, seconds: $seconds, imageId: $id, uncompressedBytes: $size, loadBefore: $loadBefore, loadAfter: $loadAfter}')"
    else
        echo "FAIL cold pull: $(tail -n 3 "$STAGE/pull.log")"; FAILED=1
    fi
fi

if [ -n "$JSON_OUT" ]; then
    jq -s --arg image "$REGISTRY/$REPOSITORY" --arg reference "$REFERENCE" --arg indexDigest "$INDEX_DIGEST" \
        --argjson indexBytes "$INDEX_BYTES" --arg measuredAt "$STARTED_AT" --arg load "$LOAD" \
        --arg host "$(uname -sm)" --argjson transfer "$TRANSFER_JSON" --argjson coldPull "$DIND_JSON" \
        '{image: $image, reference: $reference, indexDigest: $indexDigest, indexBytes: $indexBytes,
          measuredAt: $measuredAt, host: $host, loadAverages: $load, network: "measuring host, not CI",
          platforms: ., transfer: $transfer, coldPull: $coldPull}' "$STAGE/summary.jsonl" > "$JSON_OUT"
fi
exit "$FAILED"
