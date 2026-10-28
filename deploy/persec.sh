#!/usr/bin/env bash
# Manages a Persec server installed with setup.sh. Installed as the `persec` command.
set -euo pipefail

# PERSEC_DIR is only for the tests (tests/persec-cli.test.ts).
dir=${PERSEC_DIR:-/opt/persec}/deploy
env=$dir/.env
compose() { docker compose --project-directory "$dir" -f "$dir/compose.yml" "$@"; }

case "${1:-}" in
  invite)
    if [ -z "${2:-}" ]; then
      echo "Usage: persec invite <name> [days]" >&2
      exit 1
    fi
    compose exec -T persec node dist/invite.mjs "$2" "${3:-30}"
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
    echo "Backup servers don't pick this up: run the same command on each of them."
    ;;
  revoke)
    if ! [[ "${2:-}" =~ ^[A-Za-z0-9_-]{1,32}$ ]]; then
      echo "Usage: persec revoke <name>" >&2
      exit 1
    fi
    current=$(sed -n 's/^PERSEC_REVOKED=//p' "$env")
    sed -i "s/^PERSEC_REVOKED=.*/PERSEC_REVOKED=${current:+$current,}$2/" "$env"
    compose up -d persec
    echo "Revoked every invite for \"$2\" on this server."
    echo "Backup servers don't pick this up: run 'persec revoke $2' on each of them too."
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
          echo "Usage: persec domain add <name>   (for example: persec domain add yourdomain.com)" >&2
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
  admin)
    # Turns on the usage page (/admin) with a generated password, or shows the existing one.
    password=$(sed -n 's/^PERSEC_ADMIN_PASSWORD=//p' "$env")
    if [ -z "$password" ]; then
      password=$(openssl rand -hex 12)
      sed -i '/^PERSEC_ADMIN_PASSWORD=/d' "$env"
      echo "PERSEC_ADMIN_PASSWORD=$password" >>"$env"
      compose up -d persec
    fi
    echo "Usage stats for each person, live:"
    for d in $(sed -n 's/^DOMAIN=//p' "$env"); do echo "  https://$d/admin"; done
    echo "Sign in with your own invite code first, then this password (any username): $password"
    echo "Keep it private. It shows when each person is online and how much they use, never which sites."
    ;;
  update)
    curl -fsSL https://raw.githubusercontent.com/Trackertheweasel/xenapsis/master/deploy/setup.sh | bash
    ;;
  rollback)
    # Swaps back to the build from before the last update, which setup.sh keeps as persec:previous.
    # Settings, invites and saved logins are untouched. Running it again swaps forward.
    if ! docker image inspect persec:previous >/dev/null 2>&1; then
      echo "No earlier version is kept on this server yet. One is kept from the next 'persec update' on." >&2
      exit 1
    fi
    docker image tag persec:latest persec:swap
    docker image tag persec:previous persec:latest
    docker image tag persec:swap persec:previous
    docker image rm persec:swap >/dev/null
    compose up -d --no-build persec
    echo "Rolled back to the previous version. 'persec rollback' again undoes this; 'persec update' builds the latest."
    ;;
  logs)
    compose logs --tail 100 -f persec
    ;;
  status)
    # Health check: asks each of the site's addresses for the sign-in page over HTTPS, which needs
    # DNS, the certificate, Caddy and Persec all working. Exits non-zero if any fails, so it can run
    # from cron or a monitor. It checks from here, not from the networks people use.
    failed=0
    for d in $(sed -n 's/^DOMAIN=//p' "$env"); do
      code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 "https://$d/enter" || true)
      if [ "$code" = 200 ]; then
        echo "ok    https://$d"
      else
        echo "FAIL  https://$d (answered ${code:-nothing}; check its DNS, certificate and 'persec logs')"
        failed=1
      fi
    done
    exit $failed
    ;;
  logins)
    # Copies saved-login backups between servers. They are encrypted in people's browsers with a key
    # made from their invite code, so this moves bytes neither server can read. Files are named after
    # the person, the same way on every server; an import never replaces a newer backup.
    case "${2:-}" in
      export)
        # Files only: GNU tar's --keep-newer-files fails on a directory entry that already exists.
        compose exec -T persec sh -c 'mkdir -p /app/data/logins && cd /app/data && find logins -name "*.bin" -print0 | tar --null -T - -cf -'
        ;;
      import)
        # Only backup files are taken from the archive, whatever else it holds.
        compose exec -T persec sh -c 'mkdir -p /app/data/logins && cd /app/data && tar --keep-newer-files --wildcards -xf - "logins/*.bin"'
        ;;
      *)
        echo "Usage: persec logins export > logins.tar   |   persec logins import < logins.tar" >&2
        exit 1
        ;;
    esac
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
    # A hidden tunnel path stays hidden on the backup, but gets its own, made when the command runs
    # there: finding one server's path then tells nobody the other's.
    if grep -q '^PUBLIC_PERSEC_WISP_PATH=.' "$env"; then
      line="$line PUBLIC_PERSEC_WISP_PATH=/\$(openssl rand -hex 6)/"
    fi
    echo "  $line bash"
    echo
    echo "Then 'persec domain add' a name for that server and share it as a backup."
    echo "Keep this command private: anyone with the secret can mint invites."
    echo
    echo "Shared from now on: the secret, so minted invites ('persec invite') work on both."
    echo "Copied once, NOT kept in sync: codes from 'persec add' and revokes from 'persec revoke'."
    echo "  Run those on every server. A revoke done only here leaves that person able to use the backup."
    echo "Not copied: saved logins. Move them with: persec logins export > logins.tar (here), then"
    echo "  persec logins import < logins.tar (there)."
    ;;
  *)
    echo "Usage: persec add <name> <code> | invite <name> [days] | revoke <name> | domain [add|remove <name>] | export | status | admin | logins export|import | update | rollback | logs" >&2
    exit 1
    ;;
esac
