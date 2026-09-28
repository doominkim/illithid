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

DMGS=(dist/illithid-arm64.dmg dist/illithid-x64.dmg)

# Both DMGs go to Apple at once (each wait is minutes); logs land next to them
for dmg in $DMGS; do
  xcrun notarytool submit "$dmg" --keychain-profile "$PROFILE" --wait > "$dmg.notary.log" 2>&1 &
done
wait

for dmg in $DMGS; do
  echo "== $dmg"
  grep -E "status:" "$dmg.notary.log" | tail -1
  grep -qE "status: Accepted" "$dmg.notary.log" || { echo "notarization failed, see $dmg.notary.log" >&2; exit 1; }
  rm -f "$dmg.notary.log"
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
