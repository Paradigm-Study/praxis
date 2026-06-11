#!/usr/bin/env bash
# Create a local self-signed code-signing certificate ("Praxis Local Signing")
# in the login keychain, if one doesn't already exist.
#
# Why: ad-hoc signing keys macOS TCC permissions to the binary's CDHash, which
# changes on every rebuild — so granted Screen-Recording/Accessibility permission
# is lost each time you repackage. Signing with a STABLE cert makes the app's
# designated requirement cert-based (identifier + cert leaf), so the grant
# survives rebuilds. No paid Apple Developer account needed.
set -euo pipefail

IDENTITY="Praxis Local Signing"

# NB: no -v — a self-signed cert is "untrusted" so it's omitted from the -v
# (valid-only) list, but codesign can still sign with it by name.
if security find-identity -p codesigning 2>/dev/null | grep -q "$IDENTITY"; then
  echo "✓ code-signing identity already present: $IDENTITY"
  exit 0
fi

echo "▸ creating self-signed code-signing certificate: $IDENTITY"
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

cat > "$TMP/csr.cnf" <<EOF
[req]
distinguished_name = dn
x509_extensions = ext
prompt = no
[dn]
CN = $IDENTITY
[ext]
basicConstraints = critical, CA:false
keyUsage = critical, digitalSignature
extendedKeyUsage = critical, codeSigning
EOF

openssl req -x509 -newkey rsa:2048 -keyout "$TMP/key.pem" -out "$TMP/cert.pem" \
  -days 3650 -nodes -config "$TMP/csr.cnf" >/dev/null 2>&1

# -legacy: OpenSSL 3's default PKCS12 MAC is rejected by macOS's importer.
openssl pkcs12 -export -inkey "$TMP/key.pem" -in "$TMP/cert.pem" \
  -out "$TMP/id.p12" -passout pass:praxis -name "$IDENTITY" -legacy -macalg sha1 >/dev/null 2>&1

# -T codesign lets codesign use the key without a per-use keychain prompt.
security import "$TMP/id.p12" -k "$HOME/Library/Keychains/login.keychain-db" \
  -P praxis -T /usr/bin/codesign -A >/dev/null

if security find-identity -v -p codesigning 2>/dev/null | grep -q "$IDENTITY"; then
  echo "✓ created. (Self-signed → 'not trusted' for distribution, but fine for"
  echo "  local signing + stable TCC permissions.)"
else
  echo "✗ certificate creation failed" >&2
  exit 1
fi
