#!/usr/bin/env bash
# Installs Persec on a fresh Ubuntu or Debian server, with HTTPS and invite-only access.
# Run as root:
#   curl -fsSL https://raw.githubusercontent.com/Trackertheweasel/xenapsis/master/deploy/setup.sh | bash
# With your own domain (point it at the server first):
#   curl -fsSL https://raw.githubusercontent.com/Trackertheweasel/xenapsis/master/deploy/setup.sh | PERSEC_DOMAIN=yourname.duckdns.org bash
# PERSEC_INVITE_CODES="name:code,..." sets codes you choose yourself, which is easier than
# copying a generated one when the console can't paste (it also works as a startup script).
# Running it again updates Persec to the latest version and keeps your settings and invites.
set -euo pipefail

# Everything is inside main so an update can't change this file while bash is still reading it.
main() {
  local repo=${PERSEC_REPO:-https://github.com/Trackertheweasel/xenapsis}
  local branch=${PERSEC_BRANCH:-master}
  local dir=/opt/persec
  local env=$dir/deploy/.env

  # Startup scripts run without HOME, which Docker needs.
  export HOME=${HOME:-/root}

  if [ "$(id -u)" != 0 ]; then
    echo "Run this as root (put sudo in front of bash)." >&2
    exit 1
  fi

  echo "==> Installing Docker and Git"
  # A new server is often still installing updates; wait for it instead of failing.
  echo 'DPkg::Lock::Timeout "900";' >/etc/apt/apt.conf.d/99persec-wait-for-lock
  command -v git >/dev/null || { apt-get update -q && apt-get install -yq git; }
  command -v docker >/dev/null || curl -fsSL https://get.docker.com | sh

  # Building needs more memory than the smallest servers have.
  if [ "$(free -m | awk '/^Mem:/ {print $2}')" -lt 2000 ] && [ -z "$(swapon --show)" ]; then
    echo "==> Adding 2 GB of swap"
    fallocate -l 2G /swapfile || dd if=/dev/zero of=/swapfile bs=1M count=2048
    chmod 600 /swapfile
    mkswap /swapfile >/dev/null
    swapon /swapfile
    grep -q '^/swapfile ' /etc/fstab || echo '/swapfile none swap sw 0 0' >>/etc/fstab
  fi

  echo "==> Downloading Persec"
  if [ -d "$dir/.git" ]; then
    git -C "$dir" fetch -q --depth 1 origin "$branch"
    git -C "$dir" reset -q --hard FETCH_HEAD
  else
    git clone -q --depth 1 -b "$branch" "$repo" "$dir"
  fi
  ln -sf "$dir/deploy/persec.sh" /usr/local/bin/persec
  chmod +x "$dir/deploy/persec.sh"

  local first_install=false
  if [ ! -f "$env" ]; then
    first_install=true
    local domain=${PERSEC_DOMAIN:-}
    if [ -z "$domain" ]; then
      # Free hostname that points at this server's address, e.g. 203-0-113-5.sslip.io.
      local ip
      ip=$(curl -4fsS https://api.ipify.org || curl -4fsS https://ifconfig.me)
      domain=${ip//./-}.sslip.io
    fi
    umask 077
    cat >"$env" <<EOF
DOMAIN=$domain
PERSEC_INVITE_ONLY=true
PERSEC_SECRET=$(openssl rand -hex 32)
PERSEC_REVOKED=
EOF
  elif [ -n "${PERSEC_DOMAIN:-}" ]; then
    sed -i "s|^DOMAIN=.*|DOMAIN=$PERSEC_DOMAIN|" "$env"
  fi
  if [ -n "${PERSEC_INVITE_CODES:-}" ]; then
    if ! [[ "$PERSEC_INVITE_CODES" =~ ^[A-Za-z0-9_.,:-]+$ ]]; then
      echo "Invite codes may only use letters, numbers and - _ . (as name:code,name:code)." >&2
      exit 1
    fi
    sed -i '/^PERSEC_INVITE_CODES=/d' "$env"
    echo "PERSEC_INVITE_CODES=$PERSEC_INVITE_CODES" >>"$env"
  fi
  local domain
  domain=$(sed -n 's/^DOMAIN=//p' "$env")

  if command -v ufw >/dev/null && ufw status | grep -q 'Status: active'; then
    ufw allow 80/tcp >/dev/null
    ufw allow 443 >/dev/null
  fi

  echo "==> Building and starting Persec (this takes 5-10 minutes the first time)"
  docker compose --project-directory "$dir/deploy" -f "$dir/deploy/compose.yml" \
    up -d --build --remove-orphans
  docker image prune -f >/dev/null

  echo
  echo "Persec is running at https://$domain"
  echo "(The HTTPS certificate can take a minute to arrive after the first start.)"
  if [ -n "${PERSEC_INVITE_CODES:-}" ]; then
    echo
    echo "Sign in with the invite code you chose."
  elif $first_install; then
    local code
    code=$(persec invite owner 365)
    echo
    echo "Your invite code (valid for a year):"
    echo "  $code"
  fi
  echo
  echo "Commands:"
  echo "  persec invite <name> [days]   make an invite code for someone (default 30 days)"
  echo "  persec revoke <name>          cancel someone's invites"
  echo "  persec update                 update to the latest version"
  echo "  persec logs                   see what the server is doing"
}

main "$@"
