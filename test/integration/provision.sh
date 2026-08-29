#!/usr/bin/env bash
#
# Bring up the integration mail servers and create the account the tests use.
#
#   bash test/integration/provision.sh
#
# Idempotent: run it as often as you like. Tears down with
#   docker compose -f test/integration/docker-compose.yml down -v
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
COMPOSE="$HERE/docker-compose.yml"

DOMAIN="${ITEST_DOMAIN:-example.test}"
USER="${ITEST_USER:-itest@$DOMAIN}"
PASSWORD="${ITEST_PASSWORD:-itest-secret}"
WEBADMIN="${ITEST_JAMES_WEBADMIN:-http://localhost:18000}"

step() { printf '%-52s' "$1"; }
ok() { printf 'OK\n'; }
ko() {
  printf 'FAIL\n      %s\n' "$1"
  exit 1
}

# ---------------------------------------------------------------------------
# James will not start without a keystore, even when every listener it is
# asked to run is cleartext. Self-signed, throwaway, and never committed: the
# password is James's own documented default.
step "keystore"
if [ -s "$HERE/james-conf/keystore" ]; then
  ok
else
  mkdir -p "$HERE/james-conf"
  if (cd "$HERE/james-conf" &&
    openssl req -x509 -newkey rsa:2048 -keyout k.pem -out c.pem -days 3650 -nodes \
      -subj "/CN=mail-itest/O=dsh-mail-agent/C=FR" 2>/dev/null &&
    openssl pkcs12 -export -in c.pem -inkey k.pem -out keystore \
      -passout pass:james72laBalle -name james 2>/dev/null &&
    rm -f k.pem c.pem); then ok; else ko "openssl could not build a PKCS12 keystore"; fi
fi

# ---------------------------------------------------------------------------
step "containers"
if docker compose -f "$COMPOSE" up -d >/dev/null 2>&1; then ok; else
  ko "docker compose up failed; run it directly to see why"
fi

# ---------------------------------------------------------------------------
step "james answers webadmin"
for _ in $(seq 1 60); do
  curl -sf "$WEBADMIN/healthcheck" >/dev/null 2>&1 && break
  sleep 2
done
if curl -sf "$WEBADMIN/healthcheck" >/dev/null 2>&1; then ok; else
  ko "no healthy webadmin at $WEBADMIN after 120s: docker logs mail-itest-james"
fi

# ---------------------------------------------------------------------------
step "james domain $DOMAIN"
code=$(curl -s -o /dev/null -w '%{http_code}' -X PUT "$WEBADMIN/domains/$DOMAIN")
case "$code" in
204 | 200 | 409) ok ;;
*) ko "webadmin returned $code creating the domain" ;;
esac

step "james user $USER"
code=$(curl -s -o /dev/null -w '%{http_code}' -X PUT \
  -H 'Content-Type: application/json' \
  -d "{\"password\":\"$PASSWORD\"}" "$WEBADMIN/users/$USER")
case "$code" in
204 | 200 | 409) ok ;;
*) ko "webadmin returned $code creating the user" ;;
esac

# ---------------------------------------------------------------------------
# Dovecot's image authenticates any username against one password, so there is
# no account to create — only a port to wait for.
step "dovecot accepts connections"
for _ in $(seq 1 30); do
  (exec 3<>/dev/tcp/localhost/11143) 2>/dev/null && break
  sleep 1
done
if (exec 3<>/dev/tcp/localhost/11143) 2>/dev/null; then ok; else
  ko "nothing listening on 11143: docker logs mail-itest-dovecot"
fi

echo
echo "ready:"
echo "  JMAP      http://localhost:18080/jmap        session http://localhost:18080/jmap/session"
echo "  IMAP      localhost:10143 (james)  localhost:11143 (dovecot)"
echo "  SMTP      localhost:10587 (james submission)"
echo "  account   $USER / $PASSWORD"
