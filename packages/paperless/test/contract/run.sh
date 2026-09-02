#!/usr/bin/env bash
# Brings up a throwaway Paperless-ngx, waits for it, resolves an admin token,
# runs the contract tests against it, and tears it down again -- whether they
# passed or not.
#
# Not part of `pnpm test`: this needs Docker, a real network round trip per
# assertion, and real wall-clock time for Paperless to consume each document.
# Run it by hand, or from a release checklist -- see the README this sits
# beside.
set -euo pipefail
cd "$(dirname "$0")"

PROJECT=sheaf-paperless-contract-test
BASE_URL=http://localhost:18000

cleanup() {
  docker compose -p "$PROJECT" down --volumes --remove-orphans
}
trap cleanup EXIT

docker compose -p "$PROJECT" up -d

echo "waiting for Paperless to accept requests..."
for _ in $(seq 1 90); do
  if curl -fs "$BASE_URL/api/" >/dev/null 2>&1; then
    break
  fi
  sleep 2
done
if ! curl -fs "$BASE_URL/api/" >/dev/null 2>&1; then
  echo "Paperless never became reachable at $BASE_URL" >&2
  docker compose -p "$PROJECT" logs paperless >&2
  exit 1
fi

echo "resolving an admin token..."
TOKEN=""
for _ in $(seq 1 30); do
  RESPONSE=$(curl -fs -X POST "$BASE_URL/api/token/" \
    -H 'content-type: application/json' \
    -d '{"username":"admin","password":"contract-test-only"}' 2>/dev/null || true)
  TOKEN=$(node -e "try { console.log(JSON.parse(process.argv[1]).token ?? '') } catch { console.log('') }" "$RESPONSE")
  if [ -n "$TOKEN" ]; then
    break
  fi
  sleep 2
done
if [ -z "$TOKEN" ]; then
  echo "could not get a token from $BASE_URL -- admin user may not exist yet" >&2
  exit 1
fi

echo "running contract tests..."
cd ../../../.. # repo root
PAPERLESS_CONTRACT_URL="$BASE_URL" PAPERLESS_CONTRACT_TOKEN="$TOKEN" \
  pnpm exec vitest run packages/paperless/test/contract/live.test.ts --config vitest.contract.config.ts
