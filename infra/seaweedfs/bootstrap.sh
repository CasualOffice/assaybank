#!/bin/sh
# ---------------------------------------------------------------------------
# SeaweedFS bucket bootstrap — development only.
#
# Run as the one-shot `seaweedfs-init` service in docker-compose.yml. It waits
# for the S3 gateway, creates the bucket named by S3_BUCKET, and exits 0.
# Idempotent: creating a bucket that already exists is treated as success, so
# `docker compose up` after a restart is a no-op rather than a failure.
#
# ACTIVATES: M1 (2026-10-12 → 2026-10-30), when the first export file is
# written. Harmless to run before then.
#
# Production does NOT use this script. There the bucket, its lifecycle rules
# and its access policy are provisioned by the deployment pipeline, because a
# bucket that holds proctor media has a deletion schedule attached
# (RETENTION_PROCTOR_MEDIA_DAYS) and a schedule is not something a container
# entrypoint should be inventing.
#
# WHY SEAWEEDFS AND NOT MINIO
# MinIO is AGPL-3.0. Running AGPL software as a networked service inside a
# product is exactly what that licence is written to reach. SeaweedFS is
# Apache-2.0. See docs/05-licensing-and-compliance.md.
# ---------------------------------------------------------------------------
set -eu

BUCKET="${S3_BUCKET:-hiring-dev}"
MASTER="${SEAWEEDFS_MASTER:-seaweedfs:9333}"
FILER="${SEAWEEDFS_FILER:-seaweedfs:8888}"
MAX_WAIT_SECONDS=120

echo "seaweedfs-init: bucket=${BUCKET} master=${MASTER}"

# ---------------------------------------------------------------------------
# Wait for the filer, not just the master. `weed shell` talks to the filer for
# bucket operations, and the filer is ready some seconds after the master is.
# Racing it produces a confusing "connection refused" that looks like a
# networking problem.
# ---------------------------------------------------------------------------
waited=0
until wget -q -O /dev/null "http://${FILER}/?limit=1" 2>/dev/null; do
    waited=$((waited + 2))
    if [ "$waited" -ge "$MAX_WAIT_SECONDS" ]; then
        echo "seaweedfs-init: filer did not become ready within ${MAX_WAIT_SECONDS}s" >&2
        exit 1
    fi
    printf '.'
    sleep 2
done
echo
echo "seaweedfs-init: filer ready."

# ---------------------------------------------------------------------------
# Create the bucket.
#
# `weed shell` returns 0 even when a command inside it fails, so the output is
# inspected rather than the exit status. "already exists" is success.
# ---------------------------------------------------------------------------
output="$(echo "s3.bucket.create -name ${BUCKET}" | weed shell -master="${MASTER}" 2>&1 || true)"
echo "$output"

case "$output" in
    *"error"*|*"Error"*)
        case "$output" in
            *"already exists"*|*"existing"*)
                echo "seaweedfs-init: bucket ${BUCKET} already exists."
                ;;
            *)
                echo "seaweedfs-init: failed to create bucket ${BUCKET}" >&2
                exit 1
                ;;
        esac
        ;;
esac

# ---------------------------------------------------------------------------
# Verify by listing. Creating a bucket that is not then visible is a failure
# worth catching here rather than at the first upload.
# ---------------------------------------------------------------------------
listing="$(echo "s3.bucket.list" | weed shell -master="${MASTER}" 2>&1 || true)"
case "$listing" in
    *"${BUCKET}"*)
        echo "seaweedfs-init: bucket ${BUCKET} present. Done."
        ;;
    *)
        echo "seaweedfs-init: bucket ${BUCKET} not present after create:" >&2
        echo "$listing" >&2
        exit 1
        ;;
esac

# ---------------------------------------------------------------------------
# A NOTE ON CREDENTIALS IN DEVELOPMENT
#
# The dev SeaweedFS runs without an s3_config.json, so its S3 gateway accepts
# any access key. S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY in .env are
# therefore ignored here; they exist so application code takes the same signed
# path it takes in production, not because anything checks them. The dev
# gateway is reachable only from the `edge` network and the developer's
# loopback interface.
#
# Production runs with `-s3.config=/run/secrets/hiring_s3_config_json`, which
# defines real identities and per-bucket actions. See s3_config.example.json
# in this directory and the `seaweedfs` service in docker-compose.prod.yml.
# ---------------------------------------------------------------------------
