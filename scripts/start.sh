#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
[ -f .env ] || cp .env.example .env
[ -f certs/cert.pem ] || node scripts/make-certs.js
node server/index.js
