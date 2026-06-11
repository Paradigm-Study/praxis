#!/usr/bin/env bash
# Package Praxis as a proper macOS app bundle: dist/Praxis.app
#
# - release-builds PraxisBar (menu bar) + PraxisCapture (taps)
# - bundles both binaries inside the app so the whole capture tree runs under
#   the app's code-signing identity (stable TCC permission attribution)
# - signs with a Developer ID Application certificate when one exists in the
#   keychain, else falls back to ad-hoc signing
set -euo pipefail
cd "$(dirname "$0")/.."

APP=dist/Praxis.app
VERSION=0.1.0
BUNDLE_ID=com.paradigm.praxis

echo "▸ building release binaries"
swift build -c release --package-path native/PraxisBar
swift build -c release --package-path native/PraxisCapture

echo "▸ assembling $APP"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp native/PraxisBar/.build/release/praxis-bar "$APP/Contents/MacOS/"
cp native/PraxisCapture/.build/release/praxis-capture "$APP/Contents/MacOS/"

cat > "$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleIdentifier</key><string>${BUNDLE_ID}</string>
  <key>CFBundleName</key><string>Praxis</string>
  <key>CFBundleDisplayName</key><string>Praxis</string>
  <key>CFBundleExecutable</key><string>praxis-bar</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleVersion</key><string>${VERSION}</string>
  <key>CFBundleShortVersionString</key><string>${VERSION}</string>
  <key>LSMinimumSystemVersion</key><string>13.0</string>
  <key>LSUIElement</key><true/>
  <key>NSHighResolutionCapable</key><true/>
  <key>NSMicrophoneUsageDescription</key>
  <string>Praxis transcribes nearby speech on-device (never uploaded) so meetings and dictation become part of your context. Microphone capture is off unless you enable it in the menu.</string>
  <key>NSSpeechRecognitionUsageDescription</key>
  <string>Praxis uses Apple's on-device speech recognition to turn captured audio into text. Recognition runs entirely on this Mac.</string>
</dict>
</plist>
PLIST
plutil -lint "$APP/Contents/Info.plist" >/dev/null

# Pick a STABLE signing identity so TCC grants survive rebuilds.
# Preference: Developer ID (distributable) → local self-signed → ad-hoc.
bash "$(dirname "$0")/setup-signing.sh" || true
IDENTITY=$(security find-identity -v -p codesigning 2>/dev/null \
  | awk -F'"' '/Developer ID Application/{print $2; exit}' || true)
# Plain string (not an array): macOS bash 3.2 throws on "${empty[@]}" under set -u.
RUNTIME="--options runtime"
if [ -z "${IDENTITY:-}" ]; then
  # No -v: the self-signed local cert is untrusted, so it's excluded from the
  # valid-only list. Sign by the identity HASH ($2), not the name — names can
  # collide and codesign errors "ambiguous".
  IDENTITY=$(security find-identity -p codesigning 2>/dev/null \
    | awk '/Praxis Local Signing/{print $2; exit}' || true)
  RUNTIME="" # hardened runtime needs a trusted cert; skip for self-signed
fi

# Sign inside-out: nested binary first, then the bundle. $RUNTIME is unquoted on
# purpose so an empty value expands to nothing.
if [ -n "${IDENTITY:-}" ]; then
  echo "▸ signing with: $IDENTITY"
  codesign --force $RUNTIME --sign "$IDENTITY" "$APP/Contents/MacOS/praxis-capture"
  codesign --force $RUNTIME --sign "$IDENTITY" "$APP"
else
  echo "▸ no signing identity — ad-hoc (TCC grants will reset on each rebuild)"
  codesign --force --sign - "$APP/Contents/MacOS/praxis-capture"
  codesign --force --sign - "$APP"
fi

codesign --verify --strict "$APP"
echo "✓ codesign verify OK"
codesign -dv "$APP" 2>&1 | grep -E "Identifier|Signature|TeamIdentifier" | sed 's/^/  /'
echo
echo "✓ packaged: $APP"
echo "  open it:           open $APP"
echo "  run at login:      npm run app:install"
