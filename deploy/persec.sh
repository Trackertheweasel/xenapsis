#!/usr/bin/env bash
# Manages a Persec server installed with setup.sh. Installed as the `persec` command.
set -euo pipefail

dir=/opt/persec/deploy
env=$dir/.env
compose() { docker compose --project-directory "$dir" -f "$dir/compose.yml" "$@"; }

case "${1:-}" in
  invite)
    if [ -z "${2:-}" ]; then
      echo "Usage: persec invite <name> [days]" >&2
      exit 1
    fi
    compose exec -T persec pnpm -s invite "$2" "${3:-30}"
    ;;
  add)
    if ! [[ "${2:-}" =~ ^[A-Za-z0-9_-]{1,32}$ && "${3:-}" =~ ^[A-Za-z0-9_.-]{8,}$ ]]; then
      echo "Usage: persec add <name> <code>   (code: 8 or more letters, numbers, - _ .)" >&2
      exit 1
    fi
    # Replaces the person's old code if they had one, and lifts an earlier revoke.
    codes=$(sed -n 's/^PERSEC_INVITE_CODES=//p' "$env" | tr ',' '\n' | { grep -v "^$2:" || true; } | paste -sd, -)
    revoked=$(sed -n 's/^PERSEC_REVOKED=//p' "$env" | tr ',' '\n' | { grep -vx "$2" || true; } | paste -sd, -)
    sed -i '/^PERSEC_INVITE_CODES=/d; /^PERSEC_REVOKED=/d' "$env"
    echo "PERSEC_INVITE_CODES=${codes:+$codes,}$2:$3" >>"$env"
    echo "PERSEC_REVOKED=$revoked" >>"$env"
    compose up -d persec
    echo "\"$2\" can now sign in with: $3"
    ;;
  revoke)
    if ! [[ "${2:-}" =~ ^[A-Za-z0-9_-]{1,32}$ ]]; then
      echo "Usage: persec revoke <name>" >&2
      exit 1
    fi
    current=$(sed -n 's/^PERSEC_REVOKED=//p' "$env")
    sed -i "s/^PERSEC_REVOKED=.*/PERSEC_REVOKED=${current:+$current,}$2/" "$env"
    compose up -d persec
    echo "Revoked every invite for \"$2\"."
    ;;
  update)
    curl -fsSL https://raw.githubusercontent.com/Trackertheweasel/xenapsis/master/deploy/setup.sh | bash
    ;;
  logs)
    compose logs --tail 100 -f persec
    ;;
  *)
    echo "Usage: persec add <name> <code> | invite <name> [days] | revoke <name> | update | logs" >&2
    exit 1
    ;;
esac
