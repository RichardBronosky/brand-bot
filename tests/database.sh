#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
brand_test_dir="$(mktemp -d /tmp/brand-db-test.XXXXXX)"
trap 'pg_ctl -D "$brand_test_dir/data" -m immediate stop >/dev/null 2>&1 || true' EXIT
initdb -D "$brand_test_dir/data" -A trust --no-locale >/dev/null
pg_ctl -D "$brand_test_dir/data" -l "$brand_test_dir/postgres.log" -o "-k $brand_test_dir -c listen_addresses=''" -w start >/dev/null
psql -X -q -h "$brand_test_dir" -d postgres -f tests/database.sql
