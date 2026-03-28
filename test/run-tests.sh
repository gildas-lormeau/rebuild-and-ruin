#!/usr/bin/env bash

set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

cd "$SCRIPT_DIR"

TEST_FILES=(
	"build-ai-1x1.test.ts"
	"build-ai-1x2.test.ts"
	"build-ai-1x3.test.ts"
	"build-ai-C.test.ts"
	"build-ai-J.test.ts"
	"build-ai-L.test.ts"
	"build-ai-PLUS.test.ts"
	"build-ai-S.test.ts"
	"build-ai-SR.test.ts"
)

total_passed=0
total_failed=0
total_known_limitations=0
total_unexpected_passes=0
total_rounds=0
total_violations=0
rounds_by_game=""
overall_failed=0

accumulate_suite_summary() {
	local output="$1"
	local summary
	summary="$(printf "%s\n" "$output" | grep -E '^[0-9]+ passed, [0-9]+ failed, [0-9]+ known limitations, [0-9]+ unexpected passes$' | tail -n 1)"
	if [[ -z "$summary" ]]; then
		return
	fi

	local p f k u
	read -r p f k u < <(printf "%s\n" "$summary" | awk -F'[ ,]+' '{print $1, $3, $5, $8}')
	total_passed=$((total_passed + p))
	total_failed=$((total_failed + f))
	total_known_limitations=$((total_known_limitations + k))
	total_unexpected_passes=$((total_unexpected_passes + u))
}

append_rounds_by_game() {
	local round_lines="$1"
	[[ -z "$round_lines" ]] && return

	while IFS= read -r line; do
		[[ -z "$line" ]] && continue
		local game_id rounds_value
		game_id="$(printf "%s\n" "$line" | sed -E 's/.*Game ([0-9]+).*/\1/')"
		rounds_value="$(printf "%s\n" "$line" | sed -E 's/.*: ([0-9]+) rounds.*/\1/')"
		if [[ -n "$rounds_by_game" ]]; then
			rounds_by_game+=" | "
		fi
		rounds_by_game+="game${game_id}=${rounds_value}"
	done <<< "$round_lines"
}

run_suite() {
	local file="$1"
	local output
	output="$(bun "$file" 2>&1)"
	local status=$?

	printf "%s\n" "$output"
	accumulate_suite_summary "$output"

	if [[ $status -ne 0 ]]; then
		overall_failed=1
	fi
}

for file in "${TEST_FILES[@]}"; do
	run_suite "$file"
done

headless_output="$(cd "$PROJECT_DIR" && bun test/headless.test.ts 2>&1)"
headless_status=$?
printf "%s\n" "$headless_output"

rounds_in_headless="$(printf "%s\n" "$headless_output" | grep -oE '[0-9]+ rounds' | awk '{sum += $1} END {print sum + 0}')"
violations_in_headless="$(printf "%s\n" "$headless_output" | grep -E '^Total violations:' | awk '{print $3}' | tail -n 1)"

round_lines="$(printf "%s\n" "$headless_output" | grep -E 'Game [0-9]+ .*: [0-9]+ rounds')"
append_rounds_by_game "$round_lines"

if [[ -n "$rounds_in_headless" ]]; then
	total_rounds=$((total_rounds + rounds_in_headless))
fi
if [[ -n "$violations_in_headless" ]]; then
	total_violations=$((total_violations + violations_in_headless))
fi

if [[ $headless_status -ne 0 ]]; then
	overall_failed=1
fi

echo
echo "=== AGGREGATE ==="
echo "passed: $total_passed"
echo "failed: $total_failed"
echo "known limitations: $total_known_limitations"
echo "unexpected passes: $total_unexpected_passes"
echo "rounds by game: ${rounds_by_game:-n/a}"
echo "total rounds: $total_rounds"
echo "violations: $total_violations"

if [[ $overall_failed -ne 0 || $total_failed -gt 0 || $total_unexpected_passes -gt 0 ]]; then
	exit 1
fi

exit 0