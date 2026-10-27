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
  domain)
    # DOMAIN holds every name the site answers on, separated by spaces.
    domains=$(sed -n 's/^DOMAIN=//p' "$env")
    name=$(echo "${3:-}" | tr '[:upper:]' '[:lower:]')
    name=${name#http://}
    name=${name#https://}
    name=${name%%/*}
    in_list() { printf '%s\n' $domains | grep -Fqx "$name"; }
    case "${2:-list}" in
      list) ;;
      add)
        if ! [[ "$name" =~ ^([a-z0-9-]+\.)+[a-z]{2,}$ ]]; then
          echo "Usage: persec domain add <name>   (for example: persec domain add yourname.duckdns.org)" >&2
          exit 1
        fi
        if in_list; then
          echo "$name is already added."
          exit 0
        fi
        ip=$(curl -4fs https://api.ipify.org || true)
        points_to=$(getent ahostsv4 "$name" | awk 'NR == 1 {print $1}' || true)
        if [ -n "$ip" ] && [ "$points_to" != "$ip" ]; then
          echo "Warning: $name points to ${points_to:-nothing}, but this server is ${ip:-unknown}."
          echo "Point it here (on DuckDNS: put $ip in \"current ip\"). It starts working once it does."
        fi
        domains="$domains $name"
        ;;
      remove)
        if ! in_list; then
          echo "$name isn't one of this site's names. See them with: persec domain" >&2
          exit 1
        fi
        domains=$(printf '%s\n' $domains | grep -Fvx "$name" | paste -sd' ' - || true)
        if [ -z "$domains" ]; then
          echo "That's the only name left; add another first so the site stays reachable." >&2
          exit 1
        fi
        ;;
      *)
        echo "Usage: persec domain [add <name> | remove <name>]" >&2
        exit 1
        ;;
    esac
    if [ "${2:-list}" != list ]; then
      sed -i "s|^DOMAIN=.*|DOMAIN=$domains|" "$env"
      # Caddy picks up the new names and gets their HTTPS certificates.
      compose up -d caddy
      echo
    fi
    echo "The site answers on:"
    for d in $domains; do echo "  https://$d"; done
    ;;
  update)
    curl -fsSL https://raw.githubusercontent.com/Trackertheweasel/xenapsis/master/deploy/setup.sh | bash
    ;;
  logs)
    compose logs --tail 100 -f persec
    ;;
  export)
    # Prints a ready-to-paste command for standing up a backup server that shares this one's
    # invites. Because logins are signed with PERSEC_SECRET, a second server with the same
    # secret accepts the same minted invite codes (and existing logins) with nothing to sync.
    # Give people the backup's address too, so one blocked IP doesn't cut everyone off.
    secret=$(sed -n 's/^PERSEC_SECRET=//p' "$env")
    if [ -z "$secret" ]; then
      echo "This server has no PERSEC_SECRET set, so its invites aren't portable to another server." >&2
      exit 1
    fi
    codes=$(sed -n 's/^PERSEC_INVITE_CODES=//p' "$env")
    revoked=$(sed -n 's/^PERSEC_REVOKED=//p' "$env")
    echo "On a second server (ideally a different provider or region), open its console and paste:"
    echo
    line="curl -fsSL https://raw.githubusercontent.com/Trackertheweasel/xenapsis/master/deploy/setup.sh | PERSEC_SECRET=$secret"
    [ -n "$codes" ] && line="$line PERSEC_INVITE_CODES=$codes"
    [ -n "$revoked" ] && line="$line PERSEC_REVOKED=$revoked"
    echo "  $line bash"
    echo
    echo "Then 'persec domain add' a name for that server and share it as a backup."
    echo "Keep this command private: anyone with the secret can mint invites."
    ;;
  *)
    echo "Usage: persec add <name> <code> | invite <name> [days] | revoke <name> | domain [add|remove <name>] | export | update | logs" >&2
    exit 1
    ;;
esac
