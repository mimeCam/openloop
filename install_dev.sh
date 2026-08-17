#!/usr/bin/env bash
#
# This scripts installs openloop by building from source code.
# Use this if you plan to contibute to openloop.
#

set -o errexit
set -o nounset
set -o pipefail
if [[ "${TRACE-0}" == "1" ]]; then
    set -o xtrace
fi

cd "$(dirname "${BASH_SOURCE[0]:-$0}")"

./_verify_system.sh || exit 1

verify_available() {
    local cmd=$1
    if ! command -v "$cmd" &> /dev/null; then
        echo "Error: $cmd is not installed or not in PATH"
        exit 1
    fi
}

verify_and_install_swift() {
    if command -v swift &> /dev/null; then
        return 0
    fi

    echo "Swift is not installed. Installing via swiftly..."
    if [[ "$OSTYPE" == "darwin"* ]]; then
        curl --fail -O https://download.swift.org/swiftly/darwin/swiftly.pkg
        installer -pkg swiftly.pkg -target CurrentUserHomeDirectory
        ~/.swiftly/bin/swiftly init --quiet-shell-followup
        . "${SWIFTLY_HOME_DIR:-$HOME/.swiftly}/env.sh"
        hash -r
    elif [[ "$OSTYPE" == "linux-gnu"* ]]; then
        curl --fail -O "https://download.swift.org/swiftly/linux/swiftly-$(uname -m).tar.gz"
        tar zxf "swiftly-$(uname -m).tar.gz"
        ./swiftly init --quiet-shell-followup
        . "${SWIFTLY_HOME_DIR:-$HOME/.local/share/swiftly}/env.sh"
        hash -r
    elif [[ "$OSTYPE" == "msys" || "$OSTYPE" == "cygwin" || "$OSTYPE" == "win32" ]]; then
        winget install --id Microsoft.VisualStudio.2022.Community --exact --force --custom "--add Microsoft.VisualStudio.Component.Windows11SDK.22621 --add Microsoft.VisualStudio.Component.VC.Tools.x86.x64 --add Microsoft.VisualStudio.Component.VC.Tools.ARM64" --source winget
        winget install --id Swift.Toolchain -e --source winget
    else
        echo "Error: Unsupported OS: $OSTYPE. Visit https://www.swift.org/install/ for installation instructions."
        exit 1
    fi
}

start_keepalive() {
    local img=$1 name=$2
    docker rm -f "$name" &> /dev/null || true
    docker run -d --restart=unless-stopped --name="$name" "$img" tail -f /dev/null >/dev/null
}

# install_yq() {
#     if command -v yq &> /dev/null; then
#         return 0
#     fi

#     echo "Installing yq..."
#     if [[ "$OSTYPE" == "darwin"* ]]; then
#         if command -v brew &> /dev/null; then
#             brew install yq
#         else
#             echo "Error: Homebrew is required to install yq on macOS. yq is used to prepare markdown files for later use by opencode in  oc_docker. Ref: https://opencode.ai/docs/agents#markdown"
#             exit 1
#         fi
#     elif [[ "$OSTYPE" == "linux-gnu"* ]]; then
#         local arch="amd64"
#         if [[ "$(uname -m)" == "aarch64" ]] || [[ "$(uname -m)" == "arm64" ]]; then
#             arch="arm64"
#         fi
#         local yq_url="https://github.com/mikefarah/yq/releases/latest/download/yq_linux_${arch}"
#         echo "Installing yq from $yq_url..."
#         if command -v wget &> /dev/null; then
#             sudo wget "$yq_url" -O /usr/local/bin/yq
#         elif command -v curl &> /dev/null; then
#             sudo curl -sL "$yq_url" -o /usr/local/bin/yq
#         else
#             echo "Error: wget or curl required to download yq"
#             exit 1
#         fi
#         sudo chmod +x /usr/local/bin/yq
#     else
#         echo "Error: Unsupported OS: $OSTYPE"
#         exit 1
#     fi
# }

# yq 4+ fails to work with frontmatter + body
# install_yq

verify_available docker
./_build_docker_containers.sh

start_keepalive yolo_devcontainer keepalive-yolo
start_keepalive yolo_devcontainer:swift keepalive-yolo-swift
if [ "$(hostname)" == "realm13.local" ]; then
    start_keepalive yolo_devcontainer:swiftbridge keepalive-yolo-swiftbridge
fi

verify_and_install_swift
./_build_and_install_local.sh

if [[ "$OSTYPE" == "linux-gnu"* ]]; then
    loginctl enable-linger "$(whoami)" 2>/dev/null || true

    if [[ ! -d "/run/user/$(id -u)" ]]; then
        echo "Waiting for systemd user session..."
        for i in $(seq 1 10); do
            [[ -d "/run/user/$(id -u)" ]] && break
            sleep 1
        done
    fi
    if [[ -z "${XDG_RUNTIME_DIR:-}" ]]; then
        export XDG_RUNTIME_DIR=/run/user/$(id -u)
        export DBUS_SESSION_BUS_ADDRESS="unix:path=${XDG_RUNTIME_DIR}/bus"

        for f in ~/.bashrc ~/.zshrc; do
            if [[ -f "$f" ]]; then
                grep -q 'XDG_RUNTIME_DIR' "$f" || echo '[[ -z "$XDG_RUNTIME_DIR" ]] && export XDG_RUNTIME_DIR=/run/user/$(id -u) && export DBUS_SESSION_BUS_ADDRESS="unix:path=${XDG_RUNTIME_DIR}/bus"' >> "$f"
            fi
        done
    fi

    mkdir -p ~/.config/systemd/user

    echo "Enabled openloop to auto-start after reboot"
    echo "See enabled services:"
    echo "systemctl --user list-units --type=service"
    echo "Or to see all user service unit files (including inactive/enabled):"
    echo "systemctl --user list-unit-files --type=service"
fi

# rm -rf ~/.local/bin/Public
cp -r Sources/api/Public ~/.local/bin
pkill openloop-api || true
sleep 1
if ! pgrep -x openloop-api > /dev/null 2>&1; then
    (cd ~/.local/bin && ./openloop-api serve --port 54321 --hostname 0.0.0.0 > /dev/null 2>&1 &)
fi


echo "Adding ~/.local/bin to your PATH. Run 'w2' (or 'openloop') in terminal from inside project's folder to setup openloop for it."
for f in ~/.bashrc ~/.zshrc; do
  if [[ -f "$f" ]]; then
    grep -q '\.local/bin' "$f" || echo '[[ -d "$HOME/.local/bin" && ! ":$PATH:" == *":$HOME/.local/bin:"* ]] && export PATH="$HOME/.local/bin:$PATH"' >> "$f"
  fi
done
[[ -d "$HOME/.local/bin" && ! ":$PATH:" == *":$HOME/.local/bin:"* ]] && export PATH="$HOME/.local/bin:$PATH"


echo ""
echo "SUCCESS. To add openloop to a project run 'openloop' in terminal from the project's folder . Control Plane available at http://localhost:54321/"
echo "You may need to setup auth for AI agents (opencode, claude-code). See https://openloop.mimecam.com/docs"

if [[ "$OSTYPE" == "darwin"* ]]; then
    open http://localhost:54321/ || true
elif [[ "$OSTYPE" == "linux-gnu"* ]]; then
    command -v xdg-open > /dev/null 2>&1 && xdg-open http://localhost:54321/ || true
fi


echo ""
echo "Checking oc_docker:"
openloop_oc_docker "$PWD" "$PWD/.openloop/knowledge/pirate" "how many files, not counting folders, in cur dir?" "speak like true Jack Sparrow ey" plan || true
if [ -d "$HOME/.claude" ]; then
    echo "Checking cc_docker (subscription):"
    openloop_cc_docker "$PWD" "$PWD/.openloop/knowledge/pirate" "how many files, not counting folders, in cur dir?" "speak like true Jack Sparrow ey" plan || true
fi
#
# vibe disabled - it does not have a convinient way to specify system_prompt + grant permissions to use all installed mcp tools.
#
# if [ -f "$HOME/.vibe/.env" ] || [ -f "./.vibe/.env" ]; then
#     echo "Checking mv_docker (subscription):"
#     openloop_mv_docker "$PWD" "$PWD/.openloop/knowledge/pirate" "ahoy there" "speak like true Jack Sparrow ey" "plan" || true
# fi

echo ""
echo "Run 'ya hi' to verify that claude-code is authenticated (subscription). Run 'ywa' to authenticate within interactive session."

echo ""
echo "Cha-ching! 🪽 Installation complete 🪽. See http://localhost:54321/"
