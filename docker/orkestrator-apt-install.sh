#!/bin/bash
# ORKESTRATOR_CAPABILITY apt-packages=1
#
# Installs the Debian packages a project declares in orkestrator-ai.json's
# "aptPackages" field, as root, without running any of the project's own
# commands as root (to-do 7770). node reaches it only through its sudoers
# grant; workspace-setup.sh passes each declared name as one argument.
#
#   sudo /usr/local/bin/orkestrator-apt-install <package>...
#
# Root, not the caller, enforces every rule:
# - each argument is a Debian package name (^[a-z0-9][a-z0-9+.-]+$, at most
#   APT_NAME_MAX characters), at most APT_PACKAGES_MAX of them, and names a
#   real package in the image's configured archive exactly. apt-get would
#   otherwise read a name as a regular expression (`sud.`), strip a `+` or `-`
#   modifier (`sudo+`, `hello-` removes hello) or pick a provider of a virtual
#   package;
# - no requested package, and nothing the install would bring in, is on
#   APT_PACKAGE_DENYLIST, and the install removes nothing;
# - a restricted container installs only when its firewall is held by an
#   egress gateway (recorded egress `gateway`, verified at boot), so a
#   maintainer script running as root cannot change the rules.
#
# The archive is Debian's own, signed by the keyring the image ships; the
# sources are HTTPS (docker/Dockerfile). Maintainer scripts still run as root:
# they are Debian's code, not the project's.
#
# Exit status, which workspace-setup.sh turns into a setup failure reason:
#   0 installed (or already installed)   2 usage
#   3 refused (name, count, denylist, dependency or removal)
#   4 this runtime may not install under Restricted
#   5 the archive could not be reached   6 apt-get failed
set -euo pipefail
PATH=/usr/sbin:/usr/bin:/sbin:/bin
export PATH
umask 022

APT_PACKAGES_MAX=32
APT_NAME_MAX=100
# Packages that change the container boundary: privilege grants, the
# firewall, and remote login. Keep in step with APT_PACKAGE_DENYLIST in
# packages/protocol/src/apt-packages.ts (tests/unit/apt-packages-installer.test.ts).
APT_PACKAGE_DENYLIST="sudo sudo-ldap sudo-rs doas opendoas pkexec polkitd policykit-1 iptables iptables-persistent netfilter-persistent nftables ufw firewalld arptables ebtables ipset conntrack openssh-server dropbear dropbear-bin tinysshd telnetd inetutils-telnetd openbsd-inetd xinetd"

refuse() {
    echo "orkestrator-apt-install: $*" >&2
    exit 3
}

denied() {
    case " $APT_PACKAGE_DENYLIST " in
        *" $1 "*) return 0 ;;
    esac
    return 1
}

if [ "$#" -eq 0 ]; then
    echo "usage: orkestrator-apt-install <package>..." >&2
    exit 2
fi
if [ "$#" -gt "$APT_PACKAGES_MAX" ]; then
    refuse "$# packages requested; at most $APT_PACKAGES_MAX are allowed"
fi

declare -a packages=()
for name in "$@"; do
    if [ "${#name}" -gt "$APT_NAME_MAX" ] || ! [[ "$name" =~ ^[a-z0-9][a-z0-9+.-]+$ ]]; then
        refuse "\"${name:0:$APT_NAME_MAX}\" is not a Debian package name"
    fi
    if denied "$name"; then
        refuse "$name is not allowed: it could change the container's protections"
    fi
    seen=0
    for existing in "${packages[@]}"; do
        [ "$existing" = "$name" ] && seen=1
    done
    [ "$seen" = 1 ] || packages+=("$name")
done

# Nothing to do when every package is already installed: no network, no
# maintainer script, and no runtime check, so a list naming tools the image
# already has (git, curl) works everywhere.
missing=0
for name in "${packages[@]}"; do
    status=$(dpkg-query -W -f='${db:Status-Abbrev}' -- "$name" 2>/dev/null || true)
    case "$status" in
        ii*) ;;
        *) missing=1 ;;
    esac
done
if [ "$missing" = 0 ]; then
    echo "Already installed: ${packages[*]}"
    exit 0
fi

# Only root-owned records decide the runtime (network-policy-entrypoint.sh
# writes them before privileges drop).
network_mode=""
IFS= read -r network_mode 2>/dev/null < /etc/orkestrator/network-mode || true
case "$network_mode" in
    full) ;;
    restricted)
        egress=container
        firewall_boot=""
        if [ -f /etc/orkestrator/egress ]; then IFS= read -r egress < /etc/orkestrator/egress || true; fi
        IFS= read -r firewall_boot 2>/dev/null < /run/orkestrator-network/firewall-boot || true
        if [ "$egress" != gateway ] || [ "$firewall_boot" != gateway ]; then
            echo "orkestrator-apt-install: this container's firewall runs inside it, so a package's install scripts could change it; packages install only in containers with an egress gateway or full network access" >&2
            exit 4
        fi
        ;;
    *)
        echo "orkestrator-apt-install: this container has no recorded network policy" >&2
        exit 4
        ;;
esac

# A private temporary directory for apt and the maintainer scripts, and an
# environment with nothing from the caller.
work=$(mktemp -d /root/.orkestrator-apt.XXXXXX)
trap 'rm -rf "$work"' EXIT
run_apt() {
    env -i PATH="$PATH" HOME=/root TMPDIR="$work" LANG=C.UTF-8 DEBIAN_FRONTEND=noninteractive \
        "$@"
}
APT_OPTIONS=(-o Acquire::Retries=2 -o Acquire::http::Timeout=30 -o Acquire::https::Timeout=30 -o DPkg::Lock::Timeout=120)

echo "Updating the package lists from Debian's archive"
if ! run_apt apt-get "${APT_OPTIONS[@]}" -q --error-on=any update; then
    echo "orkestrator-apt-install: Debian's archive could not be reached (deb.debian.org)" >&2
    exit 5
fi

# Exact real package names only (virtual names and patterns are refused).
for name in "${packages[@]}"; do
    known=$(run_apt apt-cache pkgnames -- "$name" 2>/dev/null || true)
    if ! grep -qxF -- "$name" <<< "$known"; then
        refuse "$name is not a package in Debian's archive"
    fi
done

# Everything the install would do, before it does anything.
if ! plan=$(run_apt apt-get "${APT_OPTIONS[@]}" install -s -y --no-install-recommends -- "${packages[@]}" 2>&1); then
    printf '%s\n' "$plan" >&2
    echo "orkestrator-apt-install: apt-get could not plan the install" >&2
    exit 6
fi
while read -r action name _; do
    case "$action" in
        Inst)
            if denied "$name"; then
                refuse "the install would bring in $name, which is not allowed: it could change the container's protections"
            fi
            ;;
        Remv)
            refuse "the install would remove $name; installs never remove packages"
            ;;
    esac
done <<< "$plan"

echo "Installing: ${packages[*]}"
if ! run_apt apt-get "${APT_OPTIONS[@]}" install -y -q --no-install-recommends \
    -o Dpkg::Options::=--force-confdef -o Dpkg::Options::=--force-confold -- "${packages[@]}"; then
    echo "orkestrator-apt-install: apt-get install failed" >&2
    exit 6
fi
run_apt apt-get clean || true
echo "Installed: ${packages[*]}"
