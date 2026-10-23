#!/bin/bash
# Puts Resonance on the iPhone plugged into this Mac, built and signed with xtool and a free Apple ID.
set -euo pipefail
cd "$(dirname "$0")/.."

if ! xcrun -sdk iphoneos -show-sdk-path > /dev/null 2>&1; then
  echo "Install Xcode from the App Store, open it once to finish setting it up, then run this again."
  exit 1
fi
if ! command -v brew > /dev/null; then
  echo "Install Homebrew from https://brew.sh first, then run this again."
  exit 1
fi
command -v node > /dev/null || brew install node
command -v xtool > /dev/null || brew install xtool-org/tap/xtool

# Apple asks for your Apple ID, its password and a 6-digit code here, in this window only.
if ! xtool auth status 2>&1 | grep -qi "logged in" || xtool auth status 2>&1 | grep -qi "not logged in"; then
  xtool auth login --mode password
fi

npm install
npm run ios:web
cd ios
xtool dev run
