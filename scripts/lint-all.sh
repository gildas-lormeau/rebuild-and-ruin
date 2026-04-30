#!/bin/bash
# lint:all — parallel lanes, per-step ok/FAIL, failing logs dumped at end.
# Mirrors .git/hooks/pre-commit lane layout but skips the commit-only prelude,
# postlude, and fast-test lane. Runs every step even on failure so one pass
# surfaces every broken check.

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

# run LABEL CMD...
#   Executes CMD, logs to $TMP/LABEL.log. On failure, touches $TMP/FAILED.LABEL.
#   Returns 0 either way so sequential steps in a lane keep running.
run() {
  local label=$1; shift
  if "$@" >"$TMP/$label.log" 2>&1; then
    printf '  ok    %s\n' "$label"
  else
    printf '  FAIL  %s\n' "$label"
    : >"$TMP/FAILED.$label"
  fi
}

echo "lint:all: parallel checks..."

# Lane 1 — tsc
( run tsc tsc --noEmit ) &

# Lane 2 — biome + knip + madge + jscpd (short node checks)
(
  run format-check npx @biomejs/biome format src/ server/
  run biome        npx @biomejs/biome check src/ server/
  run knip         npx knip
  run madge        npx madge --circular --extensions ts src/ server/
  run jscpd        npx jscpd src/ --min-lines 10
) &

# Lane 3 — eslint (isolated)
( run eslint npx eslint src/ ) &

# Lane 4 — deno lint scripts
(
  run layers            deno run -A scripts/generate-import-layers.ts --check --server
  run lateral           deno run -A scripts/lint-lateral-imports.ts
  run domains           deno run -A scripts/lint-domain-boundaries.ts
  run literals          deno run -A scripts/find-duplicate-literals.ts
  run imports           deno run -A scripts/merge-imports.ts --check
  run architecture      deno run -A scripts/lint-architecture.ts
  run arch-non-runtime  deno run -A scripts/lint-architecture-non-runtime.ts
  run entry-placement   deno run -A scripts/lint-entry-placement.ts
  run restricted        deno run -A scripts/lint-restricted-imports.ts
  run checkpoint-fields deno run -A scripts/lint-checkpoint-fields.ts
  run applyat           deno run -A scripts/lint-applyat.ts
  run test-timeouts     deno run -A scripts/lint-test-timeouts.ts
  run raw-playwright    deno run -A scripts/lint-raw-playwright.ts
  run phase-transitions deno run -A scripts/lint-phase-transitions.ts
  run typeof            deno run -A scripts/lint-typeof.ts
  run null-init         deno run -A scripts/lint-null-init.ts
  run registries        deno run -A scripts/lint-registries.ts
  run useless-guards    deno run -A scripts/lint-useless-guards.ts
  run if-chain          deno run -A scripts/lint-if-chain.ts
  run passthrough       deno run -A scripts/lint-passthrough-wrappers.ts
  run tile-mutators     deno run -A scripts/lint-tile-mutators.ts
  run dead-params       deno run -A scripts/lint-dead-params.ts --min-callers=1
) &

# Lane 5 — deno type-check + lint
(
  run deno-check deno check src server/*.ts test/*.ts
  run deno-lint  deno lint src test/ server/
) &

wait

# --- Report failures ---
if ls "$TMP"/FAILED.* >/dev/null 2>&1; then
  echo
  echo "=== lint:all: failures ==="
  for marker in "$TMP"/FAILED.*; do
    label=${marker##*FAILED.}
    echo
    echo "--- $label ---"
    cat "$TMP/$label.log"
  done
  exit 1
fi

echo
echo "lint:all: all checks passed"
