#!/bin/zsh
cd "$(dirname "$0")" || exit 1

if [ ! -x "./node_modules/.bin/electron" ]; then
  echo "Electron runtime is not installed."
  echo "Run: npm install"
  osascript -e 'display dialog "Electron runtime is not installed. Run npm install in this folder, then reopen ScopeLease.command." buttons {"OK"} default button "OK"' >/dev/null 2>&1
  exit 1
fi

npm run app:dev
