#!/bin/bash
# Daily backup of the BIR Compliance System (installed by setup-ubuntu.sh as
# /usr/local/sbin/bir-backup.sh and run by /etc/cron.d/bir-backup).
# Keeps 60 days locally. COPY /var/backups/bir-compliance OFF THIS SERVER
# (another provider or the office) - a backup on the same VPS is not enough.
set -euo pipefail
DEST=/var/backups/bir-compliance
STAMP=$(date +%Y%m%d-%H%M%S)
mkdir -p "$DEST"; chmod 700 "$DEST"
umask 077

# Database (consistent snapshot; root authenticates through the local socket).
mariadb-dump --single-transaction --routines --triggers bir_compliance | gzip -9 > "$DEST/db-$STAMP.sql.gz"
# Original uploaded packages (evidence, never modified).
tar -C /opt/bir-compliance/storage -czf "$DEST/packages-$STAMP.tar.gz" packages

find "$DEST" -type f -mtime +60 -delete
echo "$(date '+%F %T') backup ok: db-$STAMP.sql.gz packages-$STAMP.tar.gz"
