#!/usr/bin/env bash
# Pre-commit hook: block secrets from being committed.
# Install: cp scripts/pre-commit-hook.sh .git/hooks/pre-commit && chmod +x .git/hooks/pre-commit

set -euo pipefail

ERRORS=()

# Block known secret filenames
for staged_file in $(git diff --cached --name-only 2>/dev/null); do
  case "$staged_file" in
    .env|.env.*|credentials.json|token.json|client_secret*)
      ERRORS+=("BLOCKED: $staged_file looks like a secrets file. Remove from staging.")
      ;;
  esac
done

# Scan staged diffs for secret patterns
SECRET_PATTERNS='(AKIA[0-9A-Z]{16}|sk-[a-zA-Z0-9]{48}|ghp_[a-zA-Z0-9]{36}|xox[bps]-[a-zA-Z0-9-]+|-----BEGIN (RSA |EC )?PRIVATE KEY)'

for staged_file in $(git diff --cached --name-only --diff-filter=ACM 2>/dev/null); do
  if [ -f "$staged_file" ]; then
    matches=$(git diff --cached "$staged_file" | grep -E "$SECRET_PATTERNS" || true)
    if [ -n "$matches" ]; then
      ERRORS+=("BLOCKED: $staged_file appears to contain a secret (API key, token, or private key).")
    fi
  fi
done

if [ ${#ERRORS[@]} -gt 0 ]; then
  echo "✗ Pre-commit blocked:"
  for err in "${ERRORS[@]}"; do
    echo "  • $err"
  done
  exit 1
fi

echo "✓ Pre-commit checks passed"
exit 0
