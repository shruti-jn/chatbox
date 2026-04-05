-- Create a separate database for Langfuse (self-hosted observability)
-- This script runs automatically on first postgres container start
-- via the /docker-entrypoint-initdb.d/ mount.

SELECT 'CREATE DATABASE langfuse'
WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'langfuse')\gexec
