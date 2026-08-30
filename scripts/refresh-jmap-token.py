# Renew the JMAP access token from the stored refresh token and rewrite ~/.dsh/.env.
# The token expires mid-session; without this every measurement stops on a 401
# that looks like a server fault rather than a clock.
import json, os, re, time, urllib.parse, urllib.request

env_path = os.path.expanduser("~/.dsh/.env")
tokens = json.loads(os.environ["MAIL_SENTINEL_JMAP_TOKENS"])
body = urllib.parse.urlencode({
    "grant_type": "refresh_token",
    "refresh_token": tokens["refreshToken"],
    "client_id": os.environ["MAIL_SENTINEL_OIDC_CLIENT_ID"],
    "client_secret": os.environ["MAIL_SENTINEL_OIDC_CLIENT_SECRET"],
}).encode()
req = urllib.request.Request(
    "https://sso.linagora.com/oauth2/token", data=body,
    headers={"content-type": "application/x-www-form-urlencoded"},
)
try:
    with urllib.request.urlopen(req, timeout=30) as r:
        got = json.load(r)
except urllib.error.HTTPError as e:
    print("refresh failed:", e.code, e.read().decode()[:300])
    raise SystemExit(2)

fresh = {
    "accessToken": got["access_token"],
    "refreshToken": got.get("refresh_token", tokens["refreshToken"]),
    "expiresAt": int(time.time()) + int(got.get("expires_in", 3600)),
    "scope": got.get("scope", tokens.get("scope", "")),
}
# Single-quoted: the value contains double quotes, and `set -a; source` in
# a shell strips them from a bare assignment, leaving JSON that will not parse.
line = "MAIL_SENTINEL_JMAP_TOKENS='" + json.dumps(fresh, separators=(",", ":")) + "'"
src = open(env_path).read()
out = re.sub(r"^MAIL_SENTINEL_JMAP_TOKENS=.*$", line.replace("\\", "\\\\"), src, flags=re.M)
if out == src:
    print("refusing: MAIL_SENTINEL_JMAP_TOKENS line not found in " + env_path)
    raise SystemExit(2)
open(env_path, "w").write(out)
print("renewed, expires in %ds (%s)" % (
    int(got.get("expires_in", 3600)),
    time.strftime("%H:%M:%S UTC", time.gmtime(fresh["expiresAt"])),
))
