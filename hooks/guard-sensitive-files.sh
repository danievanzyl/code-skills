#!/usr/bin/env bash
# PreToolUse guard: deny agents AND sub-agents (they inherit hooks) from reading
# sensitive files — cloud creds, SSH/GPG keys, .env, certs, kube/docker/npm/pypi
# /pg configs, terraform state. Covers the file tools (Read/Edit/Write/Notebook
# Edit/Grep/Glob) and Bash commands that touch those paths.
#
# Mechanism: exit 2 + a reason on stderr => Claude Code blocks the call and shows
# the reason to the model. Exit 0 => allow.
#
# Best-effort, NOT a sandbox: the Bash check is a regex over the command string,
# so deliberate obfuscation (base64, var indirection, a multi-file command that
# also touches an allow-listed path) can slip past. To avoid blocking ordinary
# code, the Bash list is path-boundary anchored and does NOT scan bare cert/key
# extensions — so `cat secret.pem` via Bash isn't caught, though Read of it is.
# It reliably stops the common case (`cat ~/.aws/credentials`, `source .env`).
# For real isolation, run the agent without access to these files.
#
# Customize: edit DENY_PATHS / DENY_BASH (block) and ALLOW (exceptions) below.
# Only deps: jq, grep.
set -euo pipefail

input=$(cat)
tool=$(printf '%s' "$input" | jq -r '.tool_name // empty')

# Two denylists. A path from a file tool is a real filesystem path, so the broad
# patterns are safe. A Bash *command* is arbitrary code, where tokens like
# process.env, Object.keys, kms.Key.fromKeyArn collide with \.env / \.key — so
# Bash uses a stricter, path-boundary-anchored list and drops the bare extension
# patterns (.pem/.key/.p12/...). Trade-off: `cat secret.pem` via Bash isn't
# caught (Read of it still is); this is what kills false positives on real code.

# Broad list for real paths (file tools). ($|/) for dir stores, ([^a-z0-9]|$) for
# filenames; \.env is a leading-boundary prefix match (.env, .env.local, .envrc,
# .environment) so it doesn't false-positive on foo.env / aws_key_pair.env.
DENY_PATHS='\.aws($|/)|\.ssh($|/)|\.gnupg($|/)|\.config/gcloud($|/)|\.kube($|/)|\.docker/config\.json|kubeconfig'
DENY_PATHS+='|\.netrc([^a-z0-9]|$)|\.git-credentials|\.npmrc([^a-z0-9]|$)|\.pypirc|\.pgpass'
DENY_PATHS+='|(^|[^[:alnum:]_])\.env'
DENY_PATHS+='|\.pem([^a-z0-9]|$)|\.(key|p12|pfx|keystore|jks)([^a-z0-9]|$)'
DENY_PATHS+='|id_(rsa|dsa|ecdsa|ed25519)|service[-_]account[^/]*\.json|\.tfstate'

# Stricter list for Bash. Each name token requires a leading path boundary
# (^|[^[:alnum:]_]) so identifiers like process.env / Object.keys / kms.Key do
# NOT match; dir stores keep ($|/) since the slash already disambiguates. Remote
# tf state (`terraform|tofu state pull|show`) dumps secrets to stdout — caught here.
DENY_BASH='\.aws($|/)|\.ssh($|/)|\.gnupg($|/)|\.config/gcloud($|/)|\.kube($|/)|\.docker/config\.json'
DENY_BASH+='|(^|[^[:alnum:]_])kubeconfig'
DENY_BASH+='|(^|[^[:alnum:]_])\.env'
DENY_BASH+='|(^|[^[:alnum:]_])\.(netrc|npmrc|pypirc|pgpass)([^[:alnum:]]|$)'
DENY_BASH+='|(^|[^[:alnum:]_])\.git-credentials'
DENY_BASH+='|(^|[^[:alnum:]_])id_(rsa|dsa|ecdsa|ed25519)'
DENY_BASH+='|(^|[^[:alnum:]_])service[-_]account[^/]*\.json'
DENY_BASH+='|\.tfstate|state[[:space:]]+(pull|show)'

# The string to inspect + which denylist, per tool. Unguarded tools => allow.
case "$tool" in
  Read|Edit|Write|MultiEdit|NotebookEdit)
    target=$(printf '%s' "$input" | jq -r '.tool_input.file_path // .tool_input.notebook_path // empty'); DENY="$DENY_PATHS" ;;
  Grep|Glob)
    target=$(printf '%s' "$input" | jq -r '.tool_input.path // empty'); DENY="$DENY_PATHS" ;;
  Bash)
    target=$(printf '%s' "$input" | jq -r '.tool_input.command // empty'); DENY="$DENY_BASH" ;;
  *)
    exit 0 ;;
esac

[[ -z "$target" ]] && exit 0

# --- allow-list exceptions (template/sample env files, public keys) ------------
ALLOW='\.env\.(example|sample|template|dist|defaults?)|\.pub([^a-z0-9]|$)'

if printf '%s' "$target" | grep -iqE "$DENY"; then
  if printf '%s' "$target" | grep -iqE "$ALLOW"; then
    exit 0
  fi
  echo "BLOCKED by guard-sensitive-files: '$target' matches a sensitive-path pattern (cloud creds, keys, .env, certs, state). Agent reads of secrets are disabled. False positive? Edit hooks/guard-sensitive-files.sh (DENY/ALLOW), or open/inspect the file yourself outside the agent." >&2
  exit 2
fi
exit 0
