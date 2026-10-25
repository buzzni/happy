#!/bin/bash
# Builds, signs and installs the N4 content-filter probe into /Applications.
# Measurement only; not part of any release. Profiles come from a local, uncommitted folder.
#   NOTARY_PROFILE=saycode-notary PROFILES="$HOME/Library/Application Support/SaycodeNEProbe" ./build.sh
set -euo pipefail
cd "$(dirname "$0")"
TEAM=36C77K9BJ2
APP_ID=com.saycode.nativeh.nefilterprobe
EXT_ID=$APP_ID.filter
IDENTITY=43F20AC7E9A008D9F7C6CA683BEDFB9618A662C2
PROFILES=${PROFILES:-"$HOME/Library/Application Support/SaycodeNEProbe"}
OUT=${OUT:-"$(mktemp -d)"}
APP="$OUT/SaycodeNEProbe.app"
EXT="$APP/Contents/Library/SystemExtensions/$EXT_ID.systemextension"

mkdir -p "$APP/Contents/MacOS" "$EXT/Contents/MacOS"
swiftc -O -target arm64-apple-macos15.0 -o "$EXT/Contents/MacOS/$EXT_ID" Filter.swift
swiftc -O -target arm64-apple-macos15.0 -o "$APP/Contents/MacOS/SaycodeNEProbe" App.swift

plist() { /usr/bin/plutil -convert xml1 -o "$1" - ; }
plist "$EXT/Contents/Info.plist" <<EOF
{"CFBundleIdentifier":"$EXT_ID","CFBundleExecutable":"$EXT_ID","CFBundleName":"Saycode NE filter probe",
 "CFBundlePackageType":"SYSX","CFBundleShortVersionString":"0.3","CFBundleVersion":"3","LSMinimumSystemVersion":"15.0",
 "NSSystemExtensionUsageDescription":"Measures which process and account opens each network flow (Saycode native H N4 probe).",
 "NetworkExtension":{"NEMachServiceName":"$TEAM.$APP_ID.filter",
   "NEProviderClasses":{"com.apple.networkextension.filter-data":"FilterDataProvider"}}}
EOF
plist "$APP/Contents/Info.plist" <<EOF
{"CFBundleIdentifier":"$APP_ID","CFBundleExecutable":"SaycodeNEProbe","CFBundleName":"SaycodeNEProbe",
 "CFBundlePackageType":"APPL","CFBundleShortVersionString":"0.3","CFBundleVersion":"3","LSMinimumSystemVersion":"15.0"}
EOF
plist "$OUT/ext.entitlements" <<EOF
{"com.apple.application-identifier":"$TEAM.$EXT_ID","com.apple.developer.team-identifier":"$TEAM",
 "com.apple.developer.networking.networkextension":["content-filter-provider-systemextension"],
 "com.apple.security.application-groups":["$TEAM.$APP_ID"]}
EOF
plist "$OUT/app.entitlements" <<EOF
{"com.apple.application-identifier":"$TEAM.$APP_ID","com.apple.developer.team-identifier":"$TEAM",
 "com.apple.developer.networking.networkextension":["content-filter-provider-systemextension"],
 "com.apple.developer.system-extension.install":true,
 "com.apple.security.application-groups":["$TEAM.$APP_ID"]}
EOF

cp "$PROFILES/Saycode_NE_Probe_Filter.provisionprofile" "$EXT/Contents/embedded.provisionprofile"
cp "$PROFILES/Saycode_NE_Probe_App.provisionprofile" "$APP/Contents/embedded.provisionprofile"
codesign --force --timestamp --options runtime -s "$IDENTITY" --entitlements "$OUT/ext.entitlements" "$EXT"
codesign --force --timestamp --options runtime -s "$IDENTITY" --entitlements "$OUT/app.entitlements" "$APP"
codesign --verify --strict --deep --verbose=2 "$APP"

# sysextd refuses a Developer ID system extension that is not notarized (-67050).
if [ -n "${NOTARY_PROFILE:-}" ]; then
  ditto -c -k --keepParent "$APP" "$OUT/probe.zip"
  xcrun notarytool submit "$OUT/probe.zip" --keychain-profile "$NOTARY_PROFILE" --wait --timeout 20m
  xcrun stapler staple "$APP"
fi

rm -rf /Applications/SaycodeNEProbe.app
ditto "$APP" /Applications/SaycodeNEProbe.app
echo "installed /Applications/SaycodeNEProbe.app (build dir $OUT)"
