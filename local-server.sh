#!/usr/bin/env bash
set -euo pipefail

cd -- "$(dirname -- "${BASH_SOURCE[0]}")"
exec npm run dev -- --host 0.0.0.0 --port 2635
