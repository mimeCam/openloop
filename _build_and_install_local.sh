#!/usr/bin/env bash
#

set -o errexit
set -o nounset
set -o pipefail
if [[ "${TRACE-0}" == "1" ]]; then
    set -o xtrace
fi

cd "$(dirname "$0")"

rebuild() {
    local EXECUTABLE_NAME="$1"
    local WORKING_NAME="$1"
    local NEW_NAME=""

    if [[ -n "${2:-}" ]]; then
        NEW_NAME="$2"
    fi

    local BUILD_DIR=".build/release"

    swift build \
        -Xswiftc -strict-concurrency=minimal \
        -c release --product "$EXECUTABLE_NAME"

    if [[ -n "${NEW_NAME:-}" ]]; then
        mv "$BUILD_DIR/$EXECUTABLE_NAME" "$BUILD_DIR/$NEW_NAME"
        WORKING_NAME="$NEW_NAME"
    fi

    echo "Killing old service"
    set +o errexit && set +o nounset && set +o pipefail
    killall "$WORKING_NAME" 2>/dev/null || true
    mv "$HOME/.local/bin/$WORKING_NAME" "$HOME/.local/bin/$WORKING_NAME-old" 2>/dev/null || true
    set -o errexit && set -o nounset && set -o pipefail

    mv "$BUILD_DIR/$WORKING_NAME" "$HOME/.local/bin/"
    echo "Moved ${WORKING_NAME} to ~/.local/bin/"
}

main() {
    if [ $# -lt 1 ] || [ $# -gt 2 ]; then
        echo "Usage: $0 <target> [new_name]"
        exit 1
    fi

    if [ $# -eq 2 ]; then
        rebuild "$1" "$2"
    else
        rebuild "$1"
    fi
}

if [ "${1:-}" == "clean" ]; then
    # Apple's swift builder often uses stale build artefacts
    # and fails to recognize changes to src code
    rm -rf .build/release
    rm -rf .build/arm64-apple-macosx/release
    # rm -rf .build/index-build
fi

mkdir -p "$HOME/.local/bin"
cp scripts/yolo/* "$HOME/.local/bin/"
# rm -rf $HOME/.local/bin/Public
cp -r Sources/api/Public "$HOME/.local/bin/"

# Rewritting `docker` to full path to docker binary. openloop-api/runner are launched by LaunchAgent on mac that sets minimal PATH. `whereis` also fails when running with minimal PATH.
DOCKER=""
for candidate in /usr/bin/docker /usr/local/bin/docker /opt/homebrew/bin/docker; do
    if [ -x "$candidate" ]; then
        DOCKER="$candidate"
        break
    fi
done
if [ -z "$DOCKER" ]; then
    DOCKER=$(command -v docker 2>/dev/null || true)
fi
if [ -n "$DOCKER" ]; then
    for f in "$HOME/.local/bin/"*-base; do
        if [ -f "$f" ]; then
            if [[ "$OSTYPE" == "darwin"* ]]; then
                sed -i '' "s|\$DOCKER|$DOCKER|g" "$f"
            else
                sed -i "s|\$DOCKER|$DOCKER|g" "$f"
            fi
        fi
    done
fi

main "openloop"
main "runner" "openloop-runner"
main "api" "openloop-api"
main "w2"

echo "Success. _build_and_install_local.sh completed."
