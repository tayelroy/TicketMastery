# quicksight

UC5 internal reporting in Amazon QuickSight (now sold as *Amazon Quick Sight*) over the five read-only `report_*`
views in RDS ([`0003`](../../../services/ticketmastery-api/migrations/0003_uc5_reporting_views.sql), described in
[docs/reporting.md](../../../docs/reporting.md)). QuickSight connects as the database role `reporting_ro`
([`0004`](../../../services/ticketmastery-api/migrations/0004_uc5_reporting_role.sql)), which can read those views
and nothing else.

**Status:** module written and validated (`terraform validate`; dataset SQL rendered and checked against the view
columns). Not applied. Wired into `envs/dev` by [`quicksight.tf`](../../envs/dev/quicksight.tf) behind
`enable_quicksight = false`, so a plain apply subscribes to nothing.

```
QuickSight dashboard "TicketMastery sales" ──▶ 5 DIRECT_QUERY datasets (custom SQL on report_* views)
  ──▶ data source POSTGRESQL (credentials: Secrets Manager secret <name>/quicksight/reporting-ro)
  ──▶ VPC connection: ENIs in the private subnets, SG <name>-quicksight-sg
  ──5432, TLS──▶ RDS SG <name>-rds-sg ──▶ RDS PostgreSQL, role reporting_ro (SELECT on report_* only)
```

| File | Contents |
|---|---|
| `main.tf` | Enterprise account subscription, account settings (termination protection off), admin user |
| `network.tf` | security group + egress rule, RDS ingress rule, VPC connection and its IAM execution role |
| `datasets.tf` | secret lookup (ARN only), PostgreSQL data source, one dataset per view |
| `dashboard.tf` | the Sales dashboard |

## What it creates

| Resource | Name / id | Notes |
|---|---|---|
| `aws_quicksight_account_subscription` | `account_name` | `ENTERPRISE`, `IAM_AND_QUICKSIGHT`. Enterprise is needed for VPC connections. Not importable; a change to `account_name` replaces it (deletes every QuickSight asset). |
| `aws_quicksight_account_settings` | account | `termination_protection_enabled = false`, so `terraform destroy` can delete the subscription. |
| `aws_quicksight_user` | IAM user from `admin_iam_arn` (`elroy`) | `ADMIN`, identity type `IAM`; signs in through the AWS console. Owns everything below. Skipped when `register_admin_user = false`. |
| `aws_security_group` + egress rule | `<name>-quicksight-sg` | No inbound rules; outbound only `db_port` to the RDS SG. |
| `aws_vpc_security_group_ingress_rule` | on `rds_sg_id` | `db_port` from the QuickSight SG. Lives here, so the `security` module is unchanged. |
| `aws_iam_role` + inline policy | `<name>-quicksight-vpc` | Trusted by `quicksight.amazonaws.com`; the five EC2 actions AWS documents for VPC connection ENIs. |
| `aws_quicksight_vpc_connection` | `<name>-rds` | In `subnet_ids` (the two private subnets; at least two are required). The ENIs need no internet access. |
| `aws_quicksight_data_source` | `<name>-postgres` | `POSTGRESQL`, host/port/database of RDS, SSL on, through the VPC connection, credentials by secret ARN. |
| `aws_quicksight_data_set` × 5 | `<name>-confirmed-orders`, `-sales-by-concert`, `-sales-by-ticket-type`, `-sales-by-day`, `-seat-status` | `DIRECT_QUERY`: no SPICE, no refresh schedule; every visual queries the views live. |
| `aws_quicksight_dashboard` | `<name>-sales` | Sheet **Sales**. |

The data source, datasets and dashboard are only created with `secret_access_granted = true` (step 4 below).

### Datasets

Custom SQL rather than a plain table reference, so that `uuid` and enum columns (`concert_status`) reach QuickSight
as text, and each `*_cents` column gets a dollars column next to it (`gross_revenue = gross_revenue_cents / 100.0`,
DECIMAL). Column types follow the view definitions: `count()` and `sum()` of the integer cents columns are `bigint`
(INTEGER), `timestamptz` and `date` are DATETIME. The views and columns are in `local.views` in `datasets.tf`; a new
column in a view needs a new entry there.

### Dashboard

All amounts are gross revenue (what fans paid), except the ticket-type table (face value: the booking fee is per
order). Every visual is filtered to `currency` (default `SGD`), because amounts are never added across currencies.

| Visual | Dataset | Shows |
|---|---|---|
| KPI | `sales_by_concert` | total gross revenue |
| KPI | `sales_by_concert` | tickets sold (`seats_sold`) |
| Horizontal bar | `sales_by_concert` | gross revenue per concert |
| Line | `sales_by_day` | gross revenue per Singapore calendar day |
| Table | `sales_by_ticket_type` | seats sold and face value per concert and ticket type |

Not built (design in [docs/reporting.md](../../../docs/reporting.md)): organiser Reader accounts and row-level
security on `organiser_id`. The dashboard is shared with the admin only.

## Credentials: no password in git or in Terraform

1. Migration `0004` creates `reporting_ro` **NOLOGIN** without a password (read-only sessions, connection limit 10,
   `USAGE` on the schema, `SELECT` on the five views only).
2. [`loadtest/scripts/reporting-user.sh`](../../../loadtest/scripts/reporting-user.sh) generates a random password
   locally into a `mktemp` file (mode 600, removed on exit), sets `LOGIN` and the password inside the VPC through
   ECS Exec into a running API task, then writes `{"username": "reporting_ro", "password": ...}` to the secret
   `<name>/quicksight/reporting-ro` with `file://`. Only a SCRAM-SHA-256 verifier (salted hash) crosses ECS Exec,
   because the ExecuteCommand call and its command line are recorded in CloudTrail. Re-running it rotates the
   password; QuickSight reads the new one on its next connection.
3. Terraform looks the secret up by name (`data "aws_secretsmanager_secret"`: metadata only) and passes its ARN as
   the data source's `credentials.secret_arn`. State holds the ARN, never the value.

QuickSight reads the secret in two ways
([AWS guide](https://docs.aws.amazon.com/quick/latest/userguide/secrets-manager-integration.html)):

- **Creating or updating the data source** (Terraform): with the Terraform caller's own IAM permissions
  (`secretsmanager:GetSecretValue` on the secret).
- **Querying it** (opening the dashboard): through the IAM role `aws-quicksight-secretsmanager-role-v0`, which
  QuickSight creates when an admin grants it access to the secret in the console. That grant is a **console step**:
  the API can't set it, and an IAM role with the same name and policy created outside the console is not enough
  (data source creation fails with access denied). Hence the two applies below.

## Steps

From the repo root, with `AWS_PROFILE=ticketmastery-tf` (account 000246635159). Each `apply` is the usual
`terraform plan -out tfplan` → review → `terraform apply tfplan` in `infra/envs/dev`.

1. **Migration.** Deploy the API image that contains `0004_uc5_reporting_role.sql`; the first task to start
   applies it (`run_migrations_on_start = true`).
2. **Database login + secret.** Needs ECS Exec on the service, the session-manager-plugin, `node` and `jq` locally.
   It runs in a task of the organiser service (`ticketmastery-dev-organiser`); `SERVICE_KEY=<key>` picks another
   API service, `SERVICE=<full name>` any service.

   ```bash
   cd loadtest
   DRY_RUN=1 scripts/reporting-user.sh   # prints the ECS Exec and Secrets Manager calls
   scripts/reporting-user.sh             # expect a REPORTING_ROLE_RESULT line with "pass":true
   ```
3. **Subscribe.** Check who Terraform runs as: `aws sts get-caller-identity --profile ticketmastery-tf`. If that is
   `quicksight_admin_iam_arn` itself (`user/elroy`), set `quicksight_register_admin_user = false`: the subscription
   registers its caller as ADMIN, and registering it again fails (a `check` block warns at plan time). Then set
   `enable_quicksight = true` in `terraform.tfvars` and apply. This creates the subscription, the admin user, the
   security group and rules, the IAM role and the VPC connection. Check the connection:

   ```bash
   aws quicksight describe-vpc-connection --aws-account-id 000246635159 --vpc-connection-id ticketmastery-dev-rds \
     --query 'VPCConnection.[Status,AvailabilityStatus]'   # expect CREATION_SUCCESSFUL, AVAILABLE
   aws quicksight list-users --aws-account-id 000246635159 --namespace default \
     --query 'UserList[].[UserName,Role]'                   # every user here is billed (see Cost)
   ```
4. **Console grant (once).** Sign in to the AWS console as `elroy`, open QuickSight in ap-southeast-1, then: user
   icon (top right) → **Manage QuickSight** → **Security & permissions** → **Manage** under *QuickSight access to
   AWS resources* → **AWS Secrets Manager** → **Select secrets** → tick `ticketmastery-dev/quicksight/reporting-ro`
   → **Finish** → **Save**. QuickSight creates the IAM role `aws-quicksight-secretsmanager-role-v0`.
5. **Data source, datasets, dashboard.** Set `quicksight_secret_access_granted = true` and apply.
6. **Open the dashboard.** `terraform output -raw quicksight_dashboard_url`, signed in to the console as `elroy`.

## Cost

QuickSight is billed **per user per month** from subscription, whether or not anyone opens a dashboard. Prices:
[Amazon Quick Sight pricing](https://aws.amazon.com/quick/quicksight/pricing/); docs/reporting.md lists the prices
checked on 31 October 2026 (Author USD 24 per user per month). This module creates one ADMIN user (an Author with
account management); any other user in `list-users` (step 3), for example a role that ran the subscription, is
billed too: remove the ones you don't need with `aws quicksight delete-user`. No Pro users and no Q&A, which would
add the account infrastructure fee. The pricing page lists no charge for VPC connections; DIRECT_QUERY uses no
SPICE. The secret is billed by Secrets Manager ([pricing](https://aws.amazon.com/secrets-manager/pricing/)).

## Teardown

1. In `terraform.tfvars`: `quicksight_secret_access_granted = false` and `enable_quicksight = false`, then apply.
   Terraform deletes the dashboard, datasets, data source, VPC connection, IAM role, security group and rules, the
   admin user, and the subscription (`DeleteAccountSubscription`; possible because termination protection is off).
   Unsubscribing deletes every QuickSight user and asset in the account, including anything made in the console.
2. `cd loadtest && scripts/reporting-user.sh disable`: `reporting_ro` back to NOLOGIN without a password, and the
   secret deleted without a recovery window.
3. Optional: delete the IAM role `aws-quicksight-secretsmanager-role-v0` (and the policy QuickSight attached to
   it) left by the console grant; IAM roles are free.

## Inputs

| Variable | Default | Purpose |
|---|---|---|
| `name` | — | name prefix (`ticketmastery-dev`) |
| `account_name` | — | QuickSight account name, unique across AWS (envs/dev default: `<name>-<account id>`) |
| `notification_email` | — | subscription notices and the admin user's email (envs/dev: `contact_email`) |
| `admin_iam_arn` | — | IAM user registered as ADMIN |
| `register_admin_user` | `true` | `false` if `admin_iam_arn` runs Terraform (step 3) |
| `vpc_id`, `subnet_ids`, `rds_sg_id` | — | network (private subnets, RDS SG) |
| `db_host`, `db_port`, `db_name`, `db_schema` | —, `5432`, —, `public` | where the views are |
| `reporting_secret_name` | — | secret written by `reporting-user.sh` |
| `secret_access_granted` | `false` | create the data source, datasets and dashboard (step 5) |
| `currency` | `SGD` | currency the dashboard shows |

Outputs: `account_name`, `admin_principal_arn`, `security_group_id`, `vpc_connection_arn`, `data_source_arn`,
`data_set_arns`, `dashboard_id`, `dashboard_url`, `reporting_secret_name`. envs/dev re-exports the account name,
secret name, data source ARN and dashboard id/URL as `quicksight_*`.
