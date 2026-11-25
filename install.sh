#!/usr/bin/env bash
# Installs or updates Muster:  curl -fsSL https://agentmuster.io/install.sh | bash
#
# It checks for git, Node, Python and Pi first and tells you how to install anything missing; it never installs
# them itself. Then it puts Muster in ~/.muster, builds it, sets up a Python virtual environment, links the
# agentmuster command into ~/.local/bin and starts Muster as a login service (launchd on macOS, a systemd user
# service on Linux). Running it again updates an existing install.
#
# Settings, all optional:
#   MUSTER_DIR=~/.muster          where the app goes
#   MUSTER_PORT=47831             the local port (first install only; later it lives in $MUSTER_DIR/.env)
#   MUSTER_BIN_DIR=~/.local/bin   where the agentmuster command is linked
#   MUSTER_SERVICE=0              don't install the login service; run `agentmuster start` yourself
#   MUSTER_REPO, MUSTER_REF       the git repository and branch or tag to install from

# Everything is inside main, so a download cut off halfway runs nothing.
main() {
  set -euo pipefail

  local repo="${MUSTER_REPO:-https://github.com/agentmuster/muster.git}"
  local ref="${MUSTER_REF:-main}"
  local dir="${MUSTER_DIR:-$HOME/.muster}"
  local port="${MUSTER_PORT:-47831}"
  local bin_dir="${MUSTER_BIN_DIR:-$HOME/.local/bin}"
  local want_service="${MUSTER_SERVICE:-1}"
  local label="io.agentmuster.muster"

  if [ -t 1 ]; then
    bold=$'\033[1m' dim=$'\033[2m' green=$'\033[32m' red=$'\033[31m' yellow=$'\033[33m' reset=$'\033[0m'
  else
    bold='' dim='' green='' red='' yellow='' reset=''
  fi
  step() { printf '%s==>%s %s\n' "$green" "$reset" "$*"; }
  note() { printf '%s!%s %s\n' "$yellow" "$reset" "$*"; }
  fail() {
    printf '%sx%s %s\n' "$red" "$reset" "$*" >&2
    exit 1
  }

  log=""
  # Runs a command quietly; on failure shows the end of its output and where the full log is.
  quiet() {
    if ! "$@" >>"$log" 2>&1; then
      tail -n 25 "$log" >&2
      fail "'$*' failed. Full log: $log"
    fi
  }

  # Versions as comparable integers: 22.23.1 -> 22023001.
  version_number() { echo "$1" | awk -F. '{ printf "%d%03d%03d", $1, $2, $3 }'; }

  local os
  case "$(uname -s)" in
    Darwin) os=macos ;;
    Linux) os=linux ;;
    *) fail "Muster runs on macOS and Linux. This is $(uname -s)." ;;
  esac

  printf '%sMuster installer%s\n\n' "$bold" "$reset"
  step "Checking what's installed"

  local missing=()
  local node_hint python_hint
  if [ "$os" = macos ]; then
    node_hint="brew install node   (or nvm: https://github.com/nvm-sh/nvm, then: nvm install 22)"
    python_hint="brew install python   (or the installer from https://www.python.org/downloads/)"
  else
    node_hint="nvm: https://github.com/nvm-sh/nvm, then: nvm install 22   (or https://nodejs.org/en/download)"
    python_hint="sudo apt install python3 python3-venv   (or your distribution's python3 and venv packages)"
  fi

  if command -v git >/dev/null 2>&1; then
    printf '  git      %s\n' "$(git --version | awk '{print $3}')"
  elif [ "$os" = macos ]; then
    missing+=("git: xcode-select --install")
  else
    missing+=("git: sudo apt install git")
  fi

  local node_version=""
  if command -v node >/dev/null 2>&1; then
    node_version="$(node -p 'process.versions.node' 2>/dev/null || true)"
  fi
  if [ -z "$node_version" ]; then
    missing+=("Node 22.23 or later: $node_hint")
  elif [ "$(version_number "$node_version")" -lt "$(version_number 22.23.0)" ]; then
    missing+=("Node 22.23 or later (you have $node_version): $node_hint")
  elif ! command -v npm >/dev/null 2>&1; then
    missing+=("npm, which comes with Node: $node_hint")
  else
    printf '  node     %s\n' "$node_version"
  fi

  local python="${PYTHON:-python3}"
  local python_version=""
  if command -v "$python" >/dev/null 2>&1; then
    python_version="$("$python" -c 'import sys; print("%d.%d.%d" % sys.version_info[:3])' 2>/dev/null || true)"
  fi
  if [ -z "$python_version" ]; then
    missing+=("Python 3.9 or later: $python_hint")
  elif [ "$(version_number "$python_version")" -lt "$(version_number 3.9.0)" ]; then
    missing+=("Python 3.9 or later (you have $python_version): $python_hint")
  elif ! "$python" -m venv --help >/dev/null 2>&1; then
    missing+=("Python's venv module: sudo apt install python3-venv")
  else
    printf '  python   %s\n' "$python_version"
  fi

  # node-pty, used by the in-browser terminal, ships macOS builds but compiles from source on Linux.
  if [ "$os" = linux ] && ! { command -v make >/dev/null 2>&1 && command -v c++ >/dev/null 2>&1; }; then
    missing+=("a C++ compiler and make, to build the terminal's node-pty: sudo apt install build-essential")
  fi

  local pi="${PI_BIN:-}"
  [ -n "$pi" ] || pi="$(command -v pi 2>/dev/null || true)"
  if [ -n "$pi" ] && [ -x "$pi" ]; then
    printf '  pi       %s\n' "$("$pi" --version 2>/dev/null | head -n 1 || echo found)"
  else
    missing+=("Pi, the coding agent Muster runs: npm install -g @earendil-works/pi-coding-agent   then run pi and use /login")
  fi

  if [ ${#missing[@]} -gt 0 ]; then
    printf '\n%sInstall these first, then run this installer again:%s\n' "$bold" "$reset"
    local item
    for item in "${missing[@]}"; do
      printf '  - %s\n' "$item"
    done
    exit 1
  fi
  echo

  # Data folder, chosen the same way the server chooses it (server/env.ts).
  local data="${MUSTER_DATA_DIR:-}"
  if [ -z "$data" ]; then
    data="$HOME/.local/share/muster"
    if [ ! -d "$data" ] && [ -d "$HOME/.local/share/meta-agent" ]; then data="$HOME/.local/share/meta-agent"; fi
  fi

  # An existing install keeps its port. Anything else already listening there would clash with the service.
  if [ -f "$dir/.env" ] && grep -q '^PORT=' "$dir/.env"; then port="$(grep '^PORT=' "$dir/.env" | tail -n 1 | cut -d= -f2)"; fi
  if [ "$want_service" = 1 ] && (exec 3<>"/dev/tcp/127.0.0.1/$port") 2>/dev/null; then
    local ours=0
    if [ "$os" = macos ]; then
      launchctl print "gui/$(id -u)/$label" >/dev/null 2>&1 && ours=1
    else
      systemctl --user is-active --quiet muster 2>/dev/null && ours=1
    fi
    [ "$ours" = 1 ] || fail "Something is already using port $port. Run again with MUSTER_PORT set to a free port, for example MUSTER_PORT=47900."
  fi

  # Kept only when a step fails, so its output can be read.
  log="$(mktemp "${TMPDIR:-/tmp}/muster-install.XXXXXX")"

  local updating=0
  if [ -d "$dir/.git" ]; then
    updating=1
    step "Updating Muster in $dir"
    if [ -n "$(git -C "$dir" status --porcelain --untracked-files=no)" ]; then
      fail "$dir has local changes. Commit or stash them, then run this again."
    fi
    quiet git -C "$dir" fetch origin "$ref"
    quiet git -C "$dir" checkout -q "$ref"
    quiet git -C "$dir" merge -q --ff-only FETCH_HEAD
  elif [ -e "$dir" ] && [ -n "$(ls -A "$dir" 2>/dev/null)" ]; then
    fail "$dir exists and isn't a Muster checkout. Move it away or set MUSTER_DIR to another folder."
  else
    step "Downloading Muster into $dir"
    quiet git clone -q --branch "$ref" "$repo" "$dir"
  fi
  printf '  %sversion %s (%s)%s\n' "$dim" "$(node -p "require('$dir/package.json').version")" "$(git -C "$dir" rev-parse --short HEAD)" "$reset"

  cd "$dir"
  step "Installing Node packages (a minute or two the first time)"
  quiet npm ci --no-audit --no-fund
  step "Building the web app"
  quiet npm run build

  step "Setting up Python packages in $dir/.venv"
  [ -x .venv/bin/python ] || quiet "$python" -m venv .venv
  quiet .venv/bin/python -m pip install --disable-pip-version-check -q -r requirements.txt

  # .env keeps this install's settings. Existing values are never overwritten.
  touch .env
  chmod 600 .env
  set_default() { grep -q "^$1=" .env || printf '%s=%s\n' "$1" "$2" >>.env; }
  set_default PORT "$port"
  set_default PYTHON "$dir/.venv/bin/python"
  set_default PI_BIN "$pi"

  step "Linking the agentmuster command into $bin_dir"
  mkdir -p "$bin_dir"
  chmod +x bin/agentmuster.mjs
  ln -sf "$dir/bin/agentmuster.mjs" "$bin_dir/agentmuster"

  local url="http://127.0.0.1:$port"
  local service_ok=0
  if [ "$want_service" = 1 ]; then
    local node_bin path_value
    node_bin="$(command -v node)"
    path_value="$(dirname "$node_bin"):$(dirname "$pi"):$bin_dir:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"
    mkdir -p "$data/logs"
    chmod 700 "$data" 2>/dev/null || true

    if [ "$os" = macos ]; then
      local plist="$HOME/Library/LaunchAgents/$label.plist"
      local domain="gui/$(id -u)"
      local loaded=0
      launchctl print "$domain/$label" >/dev/null 2>&1 && loaded=1
      step "Starting Muster as a login service ($label)"
      mkdir -p "$(dirname "$plist")"
      cat >"$plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>$label</string>
  <key>ProgramArguments</key><array>
    <string>$node_bin</string><string>--import</string><string>tsx</string><string>server/index.ts</string>
  </array>
  <key>WorkingDirectory</key><string>$dir</string>
  <key>EnvironmentVariables</key><dict>
    <key>PATH</key><string>$path_value</string>
    <key>HOME</key><string>$HOME</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$data/logs/app.log</string>
  <key>StandardErrorPath</key><string>$data/logs/app.log</string>
</dict></plist>
PLIST
      if [ "$loaded" = 1 ]; then
        note "Restarting Muster to load the update. Replies that were running stop and can be resumed."
        launchctl bootout "$domain/$label" >/dev/null 2>&1 || true
        sleep 1
      fi
      quiet launchctl bootstrap "$domain" "$plist"
      service_ok=1
    elif command -v systemctl >/dev/null 2>&1 && systemctl --user show-environment >/dev/null 2>&1; then
      local unit="$HOME/.config/systemd/user/muster.service"
      step "Starting Muster as a systemd user service (muster)"
      mkdir -p "$(dirname "$unit")"
      cat >"$unit" <<UNIT
[Unit]
Description=Muster
After=network.target

[Service]
WorkingDirectory=$dir
ExecStart=$node_bin --import tsx server/index.ts
Environment=PATH=$path_value
Restart=always
RestartSec=3
StandardOutput=append:$data/logs/app.log
StandardError=append:$data/logs/app.log

[Install]
WantedBy=default.target
UNIT
      quiet systemctl --user daemon-reload
      quiet systemctl --user enable muster
      if [ "$updating" = 1 ] && systemctl --user is-active --quiet muster; then
        note "Restarting Muster to load the update. Replies that were running stop and can be resumed."
      fi
      quiet systemctl --user restart muster
      service_ok=1
    else
      note "No systemd user session here, so Muster won't start at login. Run: agentmuster start"
    fi
  fi

  if [ "$service_ok" = 1 ]; then
    step "Waiting for Muster to answer on $url"
    local i
    for i in $(seq 1 60); do
      curl -fsS -o /dev/null --max-time 2 "$url/api/health" 2>/dev/null && break
      sleep 1
    done
    curl -fsS -o /dev/null --max-time 2 "$url/api/health" 2>/dev/null ||
      fail "Muster didn't start. Its log: $data/logs/app.log"
  fi
  rm -f "$log"

  printf '\n%sMuster is installed.%s\n\n' "$bold" "$reset"
  if [ "$service_ok" = 1 ]; then
    printf '  Open        %s\n' "$url"
  else
    printf '  Start it    agentmuster start, then open %s\n' "$url"
  fi
  if [ -f "$data/initial-password.txt" ]; then
    printf '  Password    cat %s\n' "$data/initial-password.txt"
  elif [ "$service_ok" = 0 ]; then
    printf '  Password    cat %s   (written on first start)\n' "$data/initial-password.txt"
  fi
  printf '  Commands    agentmuster help\n'
  printf '  Pi tools    pi install %s/pi-session-memory   lets Pi search your sessions in any terminal too\n' "$dir"
  printf '  Update      run the same install command again, or: agentmuster update\n'
  case ":$PATH:" in
    *":$bin_dir:"*) ;;
    *) note "$bin_dir isn't on your PATH. Add this to your shell profile: export PATH=\"$bin_dir:\$PATH\"" ;;
  esac
  if [ ! -s "$HOME/.pi/agent/auth.json" ] && [ -z "${ANTHROPIC_API_KEY:-}${OPENAI_API_KEY:-}${GEMINI_API_KEY:-}" ]; then
    note "Pi doesn't look signed in to a model provider yet. Run pi and use /login."
  fi
  printf '\n  To use it from your phone, see https://github.com/agentmuster/muster#remote-access\n'
}

main "$@"
