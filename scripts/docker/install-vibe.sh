#!/bin/sh
set -eu

REMOTE_INSTALLER="https://mistral.ai/vibe/install.sh"
UV="/home/node/.local/bin/uv"

try_remote() {
    bash -c "set -o pipefail; curl -LsSf '${REMOTE_INSTALLER}' | bash"
}

use_pypi_fallback() {
    echo ">> remote vibe install failed, falling back to uv tool install"
    "$UV" tool install mistral-vibe
}

try_remote || use_pypi_fallback
