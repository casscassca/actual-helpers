#!/bin/bash
# Single cron entrypoint for all Actual helper jobs.
# Schedule: e.g. 0 8 * * * /home/pi/actual-helpers/run.sh
cd "$(dirname "$0")"
set -a
source .env
set +a

LOG="$(pwd)/budget-sync.log"
NODE="${NODE:-node}"

notify() {
    curl -s -X POST -H "Authorization: Bearer $HA_TOKEN" \
        -H "Content-Type: application/json" \
        -d "{\"message\":\"💰 $1 sync failed\",\"title\":\"Budget Sync\"}" \
        http://127.0.0.1:8123/api/services/notify/mobile_app_pixel > /dev/null
}

run_sync() {
    local name="$1"
    local cmd="$2"
    local tmp
    tmp=$(mktemp)

    eval "$cmd" > "$tmp" 2>&1
    local status=$?
    cat "$tmp" >> "$LOG"

    # Avoid matching benign output like `{ errors: [] }` from Actual/Plaid logs.
    if [ $status -ne 0 ] || grep -qiE \
        'ACCOUNT_NEEDS_ATTENTION|need re-authentication|ECONNREFUSED|ENOTFOUND|axios|unable to get|token exchange failed|all tokens failed|sync completed with errors|^\s*error_type:' \
        "$tmp"; then
        notify "$name"
    fi
    rm "$tmp"
}

echo "=== $(date) ===" >> "$LOG"

run_sync "SimpleFin" "$NODE jobs/simplefin.js"
run_sync "Plaid" "$NODE jobs/plaid.js"
run_sync "Questrade" "$NODE jobs/questrade.js"

# Monthly on the 5th and 20th
if [ "$(date +%d)" = "05" ] || [ "$(date +%d)" = "20" ]; then
    run_sync "Zestimate" "$NODE jobs/zestimate.js"
fi

# Interest is typically run on a separate schedule (loan interest day).
# Uncomment or cron separately:
# run_sync "Interest" "$NODE jobs/interest.js"
