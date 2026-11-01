# nfr8-f4-pitr: RDS point-in-time restore drill (F4)

Run 2026-10-31 by `loadtest/scripts/nfr8-f4-pitr.sh`; the script's session ended before it recorded the end state,
so the timeline below is from the RDS event log (`aws rds describe-events --source-identifier
ticketmastery-dev-postgres-f4-10311627`) and the script log. The restored instance was deleted on 2026-11-01 02:5x UTC
(`delete-db-instance --skip-final-snapshot --delete-automated-backups`).

| Step | Time (UTC) | Since restore request |
| --- | --- | --- |
| Latest restorable point used (`LatestRestorableTime`) | 16:24:32 | 168 s **before** the request (data loss window) |
| Restore requested (`restore-db-instance-to-point-in-time`) | 16:27:20 | 0 |
| Instance created (`InstanceCreateTime`) | 16:29:53 | 2 min 33 s |
| "Restored from DB instance ticketmastery-dev-postgres to 2026-10-31 16:24:32" | 16:36:08 | 8 min 48 s |
| "DB instance restarted" (accepting connections with the restored data) | 16:36:34 | 9 min 14 s |
| "Backing up DB instance" (automatic first backup) | 16:38:12 | 10 min 52 s |
| "Finished DB Instance backup" (status `available`) | 16:55:48 | 28 min 28 s |

Restored copy: `db.t4g.micro`, ap-southeast-1b, `PubliclyAccessible = false`, `StorageEncrypted = true`, same DB
subnet group and security group as the source.

| NFR | Target | Measured | Result |
| --- | --- | --- | --- |
| NFR-8 RPO, data corruption | ≤ 30 min | 168 s (2.8 min): the restore point was 168 s before the request; RDS keeps `LatestRestorableTime` about 5 min behind | PASS |
| NFR-9 RTO, data corruption | ≤ 1 h | 9 min 14 s until the restored database accepted connections; 28 min 28 s until the instance reported `available`. Pointing the API at it (`db_host` + apply, ≈ 2–3 min for a new task) is not included | PASS |

The source instance has 1-day backup retention in dev (`db_backup_retention_period = 1`); the HA design uses 7 days.
