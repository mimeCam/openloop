#!/usr/bin/env bash
#

set -o errexit
set -o nounset
set -o pipefail
if [[ "${TRACE-0}" == "1" ]]; then
    set -o xtrace
fi

cd "$(dirname "$0")"

. ./_agent_flags.sh

# Not an array (bash 3.2 + set -u errors on empty array expansion); unquoted so empty expands to no args
BASE_BUILD_ARGS=""
# No flags = no build args = Dockerfile ARG defaults (all agents) apply
if (( WITH_CC + WITH_OC + WITH_MV )); then
    BASE_BUILD_ARGS="--build-arg WITH_CLAUDE_CODE=$WITH_CC --build-arg WITH_OPENCODE=$WITH_OC --build-arg WITH_VIBE=$WITH_MV"
fi

# Build base image first (no Swift)
docker build -f Dockerfile.devcontainer -t "yolo_devcontainer" $BASE_BUILD_ARGS .

# Native Swift variant
docker build -f Dockerfile.devcontainer-swift -t "yolo_devcontainer:swift" .

if [ "$(hostname)" == "realm13.local" ]; then
    #
    # Build SwiftBridge variant
    # SwiftBridge - access hosting OS commands (over TCP) from inside docker container
    #
    docker build -f Dockerfile.devcontainer-swiftbridge -t "yolo_devcontainer:swiftbridge" .

    # #
    # mkdir -p ~/.local/bin
    # REPO_SERVER="$REPO/swiftbridge-server:release"
    # docker pull "$REPO_SERVER"
    # docker cp $(docker create --rm "$REPO_SERVER"):/usr/local/bin/SwiftBridgeServer ~/.local/bin/swiftbridge-server
fi

echo "Success. _build_docker_containers.sh completed."
