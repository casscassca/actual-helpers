#!/bin/bash
# Back-compat name. Prefer: ./run.sh
exec "$(dirname "$0")/run.sh" "$@"
