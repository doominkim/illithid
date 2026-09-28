#!/bin/zsh
# Build, notarize and verify the macOS DMGs for a release, then clear the unpacked apps.
#   scripts/release-mac.sh 0.2.11
# Needs the Developer ID certificate and a notarytool keychain profile (NOTARY_PROFILE, default mac-notarize).
# Publishing (release commit, gh release, Homebrew tap) stays manual.
set -euo pipefail

VERSION=${1:?usage: scripts/release-mac.sh <version>}
PROFILE=${NOTARY_PROFILE:-mac-notarize}
cd "$(dirname "$0")/.."

npm version "$VERSION" --no-git-tag-version >/dev/null
APPLE_KEYCHAIN_PROFILE=$PROFILE npm run build:mac

for dmg in dist/illithid-arm64.dmg dist/illithid-x64.dmg; do
  echo "== $dmg"
  xcrun notarytool submit "$dmg" --keychain-profile "$PROFILE" --wait | grep -E "status:" | tail -1
  xcrun stapler staple "$dmg" | tail -1
  mp=$(hdiutil attach -nobrowse -readonly "$dmg" | grep -o '/Volumes/.*' | tail -1)
  spctl -a -vv -t exec "$mp/Illithid.app" 2>&1 | head -2
  built=$(/usr/libexec/PlistBuddy -c 'Print CFBundleShortVersionString' "$mp/Illithid.app/Contents/Info.plist")
  hdiutil detach -quiet "$mp"
  [[ "$built" == "$VERSION" ]] || { echo "version mismatch: $built" >&2; exit 1; }
done

# The unpacked apps in dist/mac* are registered with LaunchServices as the newest Illithid, so Spotlight or Launchpad can
# open them instead of /Applications (the Intel one runs under Rosetta and is slow). Unregister them and move them to the Trash
LSREGISTER=/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister
for app in dist/mac/Illithid.app dist/mac-arm64/Illithid.app; do
  [[ -d "$app" ]] || continue
  "$LSREGISTER" -u "$PWD/$app"
  trash "${app:h}"
done

shasum -a 256 dist/illithid-arm64.dmg dist/illithid-x64.dmg
