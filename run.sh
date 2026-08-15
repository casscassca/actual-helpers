#!/bin/bash
# Single cron entrypoint for all Actual helper jobs.
# Default: run inside the actual-helpers Docker container.
# Override: NODE=node ./run.sh  (bare metal)
cd "$(dirname "$0")"
set -a
source .env
set +a

LOG="$(pwd)/budget-sync.log"

# Prefer docker exec when the container is running; else bare node.
if [ -n "${NODE:-}" ]; then
    RUN="$NODE"
elif docker ps --format '{{.Names}}' | grep -qx 'actual-helpers'; then
    RUN="docker exec actual-helpers node"
else
    RUN="node"
fi

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

run_sync "SimpleFin" "$RUN jobs/simplefin.js"
run_sync "Guideline" "$RUN jobs/guideline.js"
run_sync "Plaid" "$RUN jobs/plaid.js"
run_sync "Questrade" "$RUN jobs/questrade.js"

# Mortgage interest - Monthly on the 1st
if [ "$(date +%d)" = "01" ]; then
    run_sync "Interest" "$RUN jobs/interest.js"
fi

# Zestimate + ServiceMac + Finley (KBB/HA) - 5th and 20th
if [ "$(date +%d)" = "05" ] || [ "$(date +%d)" = "20" ]; then
    run_sync "Zestimate" "$RUN jobs/zestimate.js"
    run_sync "ServiceMac" "$RUN jobs/servicemac.js"
    run_sync "Finley" "$RUN jobs/finley.js"
fi

run_sync "Backup" "$RUN jobs/backup.js"
