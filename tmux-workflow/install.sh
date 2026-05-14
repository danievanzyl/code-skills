#!/usr/bin/env bash
# install.sh — idempotent installer for the tmux-workflow scripts.
# Re-running is safe. The tmux.conf block lives between sentinel markers
# and is replaced atomically, so editing the snippet + re-running updates it.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BIN_DIR="${BIN_DIR:-$HOME/bin}"
TMUX_CONF="${TMUX_CONF:-$HOME/.tmux.conf}"
ZSHRC="${ZSHRC:-$HOME/.zshrc}"

SCRIPTS=(sessionizer new-branch close-branch open-worktree pr-status)
SNIPPET="$SCRIPT_DIR/tmux.conf.snippet"
START_MARKER="# === tmux-workflow start ==="
END_MARKER="# === tmux-workflow end ==="

say() { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m!!\033[0m %s\n' "$*" >&2; }
die() { printf '\033[1;31mxx\033[0m %s\n' "$*" >&2; exit 1; }

check_prereqs() {
  say "checking prerequisites"
  local missing=()
  for cmd in tmux gh fd fzf git jq; do
    if ! command -v "$cmd" >/dev/null 2>&1; then
      missing+=("$cmd")
    fi
  done
  if (( ${#missing[@]} > 0 )); then
    die "missing: ${missing[*]} — install with: brew install ${missing[*]}"
  fi
  local tmux_ver
  tmux_ver=$(tmux -V | awk '{print $2}' | tr -d 'a-z')
  if (( $(echo "$tmux_ver < 3.4" | bc -l 2>/dev/null || echo 0) )); then
    warn "tmux $tmux_ver detected — 3.4+ recommended (split-window -l <pct>%)"
  fi
  if ! gh auth status >/dev/null 2>&1; then
    warn "gh is not authenticated — close-branch and pr-status will no-op until you 'gh auth login'"
  fi
}

install_scripts() {
  say "installing scripts to $BIN_DIR"
  mkdir -p "$BIN_DIR"
  for s in "${SCRIPTS[@]}"; do
    install -m 0755 "$SCRIPT_DIR/$s" "$BIN_DIR/$s"
    printf '   %s\n' "$BIN_DIR/$s"
  done
}

ensure_path() {
  if [[ ":$PATH:" == *":$BIN_DIR:"* ]]; then
    return
  fi
  say "adding $BIN_DIR to PATH in $ZSHRC"
  if [[ -f "$ZSHRC" ]] && grep -qF "export PATH=\"$BIN_DIR" "$ZSHRC"; then
    return
  fi
  printf '\nexport PATH="%s:$PATH"\n' "$BIN_DIR" >> "$ZSHRC"
  warn "open a new shell or run: source $ZSHRC"
}

install_tmux_conf() {
  say "updating tmux config block in $TMUX_CONF"
  touch "$TMUX_CONF"
  local content
  if grep -qF "$START_MARKER" "$TMUX_CONF"; then
    content=$(awk -v start="$START_MARKER" -v end="$END_MARKER" '
      $0 == start { in_block=1; next }
      $0 == end { in_block=0; next }
      !in_block { print }
    ' "$TMUX_CONF")
  else
    content=$(<"$TMUX_CONF")
  fi
  {
    [[ -n "$content" ]] && printf '%s\n\n' "$content"
    cat "$SNIPPET"
  } > "$TMUX_CONF"
}

reload_tmux() {
  if tmux list-sessions >/dev/null 2>&1; then
    say "reloading tmux config"
    tmux source-file "$TMUX_CONF"
  else
    say "no tmux server running — config will load on next 'tmux' start"
  fi
}

main() {
  check_prereqs
  install_scripts
  ensure_path
  install_tmux_conf
  reload_tmux
  say "done"
  cat <<EOF

Keybinds (prefix is whatever you have configured — your conf shows Ctrl-Space):
  prefix-T   project switcher (sessionizer)
  prefix-N   new branch + worktree (prompts for name)
  prefix-O   open existing worktree (fzf popup)
  prefix-X   cleanup current window's worktree (only if PR is MERGED)

EOF
}

main "$@"
