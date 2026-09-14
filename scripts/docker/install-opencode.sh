#!/bin/sh
set -eu

# 1.17.20 (released 2026-07-13) - the last version without the new-UI cutover.
# Microsoftification of Opencode with 
# forced new horizontal-tabs web UI and removed the
# "revert to old UI" toggle.
# Pin to the release just before it.
FALLBACK_VERSION="${OPENCODE_VERSION:-1.17.20}"
INSTALL_DIR="/home/node/.opencode/bin"
ARCH=$(uname -m)
case "$ARCH" in x86_64) ARCH=x64 ;; aarch64) ARCH=arm64 ;; esac

install_versioned() {
    URL="https://github.com/anomalyco/opencode/releases/download/v${FALLBACK_VERSION}/opencode-linux-${ARCH}.tar.gz"
    echo ">> installing pinned opencode v${FALLBACK_VERSION} from ${URL}"
    wget -q -O /tmp/opencode.tar.gz "$URL" &&
        tar -xzf /tmp/opencode.tar.gz -C /tmp &&
        mkdir -p "$INSTALL_DIR" &&
        mv /tmp/opencode "${INSTALL_DIR}/opencode" &&
        rm -f /tmp/opencode.tar.gz
}

install_versioned
