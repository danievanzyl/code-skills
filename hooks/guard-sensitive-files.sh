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
# also touches an allow-listed path) can slip past. It reliably stops the common
# accidental case (`cat ~/.aws/credentials`, `Read ~/.ssh/id_rsa`). For real
# isolation, run the agent without access to these files.
#
# Customize: edit DENY (block) and ALLOW (exceptions) below. Only deps: jq, grep.
set -euo pipefail

input=$(cat)
tool=$(printf '%s' "$input" | jq -r '.tool_name // empty')

# The string to inspect, per tool. Unguarded tools fall through and are allowed.
case "$tool" in
  Read|Edit|Write|MultiEdit|NotebookEdit)
    target=$(printf '%s' "$input" | jq -r '.tool_input.file_path // .tool_input.notebook_path // empty') ;;
  Grep|Glob)
    target=$(printf '%s' "$input" | jq -r '.tool_input.path // empty') ;;
  Bash)
    target=$(printf '%s' "$input" | jq -r '.tool_input.command // empty') ;;
  *)
    exit 0 ;;
esac

[[ -z "$target" ]] && exit 0

# --- denylist (case-insensitive, matched anywhere in the path/command) ---------
# Boundaries use ($|/) for dir stores (match the dir with or without a trailing
# slash) and ([^a-z0-9]|$) for filenames. `\.env` is a bare prefix match, so it
# catches every `.env*` variant (.env, .env.local, .envrc, .environment) — the
# ALLOW list below rescues template files (.env.example etc). Works for both path
# tokens and Bash command strings, where the next char is often a space/;/quote.
DENY='\.aws($|/)|\.ssh($|/)|\.gnupg($|/)|\.config/gcloud($|/)|\.kube($|/)|\.docker/config\.json|kubeconfig'
DENY+='|\.netrc([^a-z0-9]|$)|\.git-credentials|\.npmrc([^a-z0-9]|$)|\.pypirc|\.pgpass'
DENY+='|\.env'
DENY+='|\.pem([^a-z0-9]|$)|\.(key|p12|pfx|keystore|jks)([^a-z0-9]|$)'
DENY+='|id_(rsa|dsa|ecdsa|ed25519)|service[-_]account[^/]*\.json|\.tfstate'
# Remote tf state: `terraform|tofu|terragrunt state pull|show` dumps full state
# (secrets included) to stdout — the .tfstate file pattern above won't catch it.
DENY+='|state[[:space:]]+(pull|show)'

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
