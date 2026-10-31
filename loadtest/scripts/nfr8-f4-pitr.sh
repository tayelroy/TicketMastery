#!/usr/bin/env bash
# NFR-8/9 / drill F4: RDS point-in-time restore to a NEW instance, timed until `available`, then deleted.
# The restore point is the source's LatestRestorableTime read just before the request (or RESTORE_TIME), passed
# explicitly so the report can state exactly which point was restored; the gap to "now" is the achieved RPO for
# data corruption. The production instance is not touched (cutting the app over is the documented manual step).
# The restored instance gets the source's subnet group, security group and class, no public access, and is deleted
# with --skip-final-snapshot --delete-automated-backups when the timing is done (also on Ctrl-C or error).
# VERIFY=1 additionally runs the NFR-3 SQL check against the restored copy through ECS Exec.
#
#   scripts/nfr8-f4-pitr.sh                 # about 15-30 min, ~USD 0.01 of db.t4g.micro time
#   DRY_RUN=1 scripts/nfr8-f4-pitr.sh       # read-only: prints the restore point and the calls it would make
source "$(dirname "$0")/lib.sh"
require_aws

TARGET_ID="${TARGET_ID:-$DB_INSTANCE-f4-$(date -u +%m%d%H%M)}"
POLL="${POLL:-30}"

SRC="$(aws rds describe-db-instances --db-instance-identifier "$DB_INSTANCE" --output json | jq '.DBInstances[0]')"
LATEST="$(jq -r .LatestRestorableTime <<<"$SRC")"
RESTORE_TIME="${RESTORE_TIME:-$LATEST}"
SUBNET_GROUP="$(jq -r .DBSubnetGroup.DBSubnetGroupName <<<"$SRC")"
SGS="$(jq -r '[.VpcSecurityGroups[].VpcSecurityGroupId] | join(" ")' <<<"$SRC")"
CLASS="$(jq -r .DBInstanceClass <<<"$SRC")"
RETENTION="$(jq -r .BackupRetentionPeriod <<<"$SRC")"
EARLIEST="$(aws rds describe-db-instance-automated-backups --db-instance-identifier "$DB_INSTANCE" \
  --query 'DBInstanceAutomatedBackups[0].RestoreWindow.EarliestTime' --output text 2>/dev/null || echo unknown)"
REQUESTED_AT="$(iso_now)"
LAG_SEC=$(( $(to_epoch "$REQUESTED_AT") - $(to_epoch "$RESTORE_TIME") ))

log "source $DB_INSTANCE ($CLASS, backup retention ${RETENTION} d, restore window $EARLIEST .. $LATEST)"
log "restore point $RESTORE_TIME = ${LAG_SEC}s before now -> new instance $TARGET_ID"

# shellcheck disable=SC2086 # SGS is a space-separated list on purpose
mutate aws rds restore-db-instance-to-point-in-time \
  --source-db-instance-identifier "$DB_INSTANCE" --target-db-instance-identifier "$TARGET_ID" \
  --restore-time "$RESTORE_TIME" --db-subnet-group-name "$SUBNET_GROUP" --vpc-security-group-ids $SGS \
  --db-instance-class "$CLASS" --no-multi-az --no-publicly-accessible --no-deletion-protection \
  --tags Key=purpose,Value=f4-drill Key=created-by,Value=loadtest \
  --query 'DBInstance.DBInstanceStatus' --output text
T0="$(epoch)"

if [[ "$DRY_RUN" == 1 ]]; then
  log "DRY_RUN: would poll describe-db-instances every ${POLL}s until available, then:"
  mutate aws rds delete-db-instance --db-instance-identifier "$TARGET_ID" --skip-final-snapshot --delete-automated-backups
  exit 0
fi

cleanup() {
  log "deleting $TARGET_ID"
  aws rds delete-db-instance --db-instance-identifier "$TARGET_ID" --skip-final-snapshot --delete-automated-backups \
    --query 'DBInstance.DBInstanceStatus' --output text || log "DELETE FAILED: delete $TARGET_ID by hand"
}
trap cleanup EXIT

STATUS=""; LAST=""
while true; do
  STATUS="$(aws rds describe-db-instances --db-instance-identifier "$TARGET_ID" --query 'DBInstances[0].DBInstanceStatus' --output text 2>/dev/null || echo pending)"
  [[ "$STATUS" != "$LAST" ]] && log "+$(( $(epoch) - T0 ))s $TARGET_ID: $STATUS"
  LAST="$STATUS"
  [[ "$STATUS" == available ]] && break
  [[ "$STATUS" == failed || "$STATUS" == incompatible-restore ]] && die "restore $STATUS"
  (( $(epoch) - T0 < 7200 )) || die "not available after 2 h"
  sleep "$POLL"
done
T1="$(epoch)"; AVAILABLE_AT="$(iso_now)"
ENDPOINT="$(aws rds describe-db-instances --db-instance-identifier "$TARGET_ID" --query 'DBInstances[0].Endpoint.Address' --output text)"

VERIFY_RESULT="null"
if [[ "${VERIFY:-0}" == 1 ]]; then
  log "VERIFY=1: SQL check on the restored copy through ECS Exec"
  if OUT="$(DB_HOST_OVERRIDE="$ENDPOINT" "$LOADTEST_DIR/scripts/nfr3-oversell-check.sh" 2>&1)"; then :; fi
  VERIFY_RESULT="$(printf '%s\n' "$OUT" | tr -d '\r' | grep -m1 '^OVERSELL_CHECK_RESULT ' | sed 's/^OVERSELL_CHECK_RESULT //' || echo null)"
  [[ -n "$VERIFY_RESULT" ]] || VERIFY_RESULT=null
fi

result_files nfr8-f4-pitr
jq -n --arg src "$DB_INSTANCE" --arg tgt "$TARGET_ID" --arg restore "$RESTORE_TIME" --arg latest "$LATEST" \
  --arg earliest "$EARLIEST" --arg requested "$REQUESTED_AT" --arg available "$AVAILABLE_AT" --arg class "$CLASS" \
  --argjson lag "$LAG_SEC" --argjson dur "$((T1 - T0))" --argjson retention "$RETENTION" --argjson verify "$VERIFY_RESULT" '
  {test: "nfr8-f4-pitr", source: $src, restoredInstance: $tgt, instanceClass: $class, backupRetentionDays: $retention,
   restoreWindow: {earliest: $earliest, latest: $latest}, restorePoint: $restore, requestedAt: $requested,
   restorePointLagSec: $lag, availableAt: $available, restoreDurationSec: $dur,
   restoreDurationMin: ($dur / 6 | round / 10), restoredCopyCheck: $verify, deleted: true}
  | .pass = (.restorePointLagSec <= 1800 and .restoreDurationSec <= 3600)' > "$RESULT_JSON"

jq -r '
  "# nfr8-f4-pitr: RDS point-in-time restore (\(.requestedAt))\n",
  "| Restore point | Latest restorable time | Data-loss window (RPO) | Restore requested | Available | Restore duration (RTO share) | RPO ≤ 30 min, RTO ≤ 1 h |",
  "| --- | --- | --- | --- | --- | --- | --- |",
  "| \(.restorePoint) | \(.restoreWindow.latest) | \(.restorePointLagSec / 60 * 10 | round / 10) min | \(.requestedAt) | \(.availableAt) | \(.restoreDurationMin) min | \(if .pass then "PASS" else "FAIL" end) |\n",
  "Source `\(.source)` (\(.instanceClass), \(.backupRetentionDays)-day retention, window from \(.restoreWindow.earliest)); restored to `\(.restoredInstance)`, then deleted.",
  (if .restoredCopyCheck then "Restored copy: \(.restoredCopyCheck.confirmed_orders) confirmed orders, \(.restoredCopyCheck.sold_seats) sold seats, oversell check \(if .restoredCopyCheck.pass then "PASS" else "FAIL" end)." else empty end)
' "$RESULT_JSON" | tee "$RESULT_MD"
log "written $RESULT_JSON and .md"
