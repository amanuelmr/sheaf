#!/usr/bin/env bash
# Runs the Maestro flows, after checking Maestro is actually here.
#
# `maestro` is not a project dependency: it is a global CLI that needs a JDK, and
# pinning it in package.json would still not install a JVM. So it is checked
# explicitly, with a version floor, and the failure says what to do rather than
# leaving a bare "command not found".
set -euo pipefail

cd "$(dirname "$0")/.."

if ! command -v maestro > /dev/null 2>&1; then
  echo "Maestro is not installed. The flows need Java 17+ and:" >&2
  echo '  curl -fsSL "https://get.maestro.mobile.dev" | bash' >&2
  exit 1
fi

# The row selectors are matched as patterns, which needs a recent Maestro.
MIN_MAJOR=1
MIN_MINOR=40
version="$(maestro --version 2>/dev/null | grep -oE '[0-9]+\.[0-9]+(\.[0-9]+)?' | head -1 || true)"

if [ -z "$version" ]; then
  echo "Could not read a version from 'maestro --version'." >&2
  exit 1
fi

major="${version%%.*}"
minor="${version#*.}"
minor="${minor%%.*}"

if [ "$major" -lt "$MIN_MAJOR" ] || { [ "$major" -eq "$MIN_MAJOR" ] && [ "$minor" -lt "$MIN_MINOR" ]; }; then
  echo "Maestro $version is older than the $MIN_MAJOR.$MIN_MINOR these flows expect." >&2
  echo '  curl -fsSL "https://get.maestro.mobile.dev" | bash' >&2
  exit 1
fi

echo "Maestro $version"
exec maestro test e2e
