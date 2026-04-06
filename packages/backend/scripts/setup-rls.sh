#!/bin/bash
# Setup RLS restricted user for ChatBridge
# Run once after first deployment:
#   railway run bash packages/backend/scripts/setup-rls.sh

set -e

if [ -z "$DATABASE_URL" ]; then
  echo "ERROR: DATABASE_URL not set"
  exit 1
fi

echo "Creating chatbridge_app role..."
psql "$DATABASE_URL" <<'SQL'
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'chatbridge_app') THEN
    CREATE ROLE chatbridge_app WITH LOGIN PASSWORD 'chatbridge_app_railway';
  END IF;
END
$$;

GRANT CONNECT ON DATABASE railway TO chatbridge_app;
GRANT USAGE ON SCHEMA public TO chatbridge_app;
GRANT ALL ON ALL TABLES IN SCHEMA public TO chatbridge_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO chatbridge_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO chatbridge_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO chatbridge_app;
SQL

echo "Applying RLS policies..."
psql "$DATABASE_URL" < packages/backend/prisma/rls-policies.sql

echo "RLS setup complete."
echo ""
echo "Set DATABASE_URL_APP to: postgresql://chatbridge_app:chatbridge_app_railway@<host>:<port>/<db>"
