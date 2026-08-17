#!/bin/sh
set -eu

REMOTE_INSTALLER="https://opencode.ai/install"
FALLBACK_VERSION="${OPENCODE_VERSION:-1.18.18}"
INSTALL_DIR="/home/node/.opencode/bin"
ARCH=$(uname -m)
case "$ARCH" in x86_64) ARCH=x64 ;; aarch64) ARCH=arm64 ;; esac

try_remote() {
    bash -c "set -o pipefail; curl -fsSL '${REMOTE_INSTALLER}' | bash"
}

use_versioned_fallback() {
    URL="https://github.com/anomalyco/opencode/releases/download/v${FALLBACK_VERSION}/opencode-linux-${ARCH}.tar.gz"
    echo ">> remote opencode install failed, falling back to ${URL}"
    wget -q -O /tmp/opencode.tar.gz "$URL" &&
        tar -xzf /tmp/opencode.tar.gz -C /tmp &&
        mkdir -p "$INSTALL_DIR" &&
        mv /tmp/opencode "${INSTALL_DIR}/opencode" &&
        rm -f /tmp/opencode.tar.gz
}

try_remote || use_versioned_fallback
