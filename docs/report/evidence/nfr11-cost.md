# nfr11-cost: spend against the USD 80 budget

Source: Cost Explorer, `aws ce get-cost-and-usage` (unblended cost, grouped by record type, by service and by day),
and `aws budgets describe-budgets`, read 2026-11-01 03:10 UTC. The stack was first applied on 22 Oct 2026; everything
before that was local development.

Daily usage before credits: 22 Oct 1.08 (partial day) · 23–26 Oct 2.26/day · 27 Oct 2.21 · 28–30 Oct 2.02/day (ALB
now internal, so its two public IPv4 addresses no longer bill) · 31 Oct 1.16 (not yet complete in Cost Explorer).

| Period | Usage (before credits) | Credits | Net charged |
| --- | --- | --- | --- |
| October 2026 | USD 22.92 | −22.92 | USD 0.00 |
| November 2026 (to date) | not yet reported by Cost Explorer | | |

October usage by service (unblended, services above USD 0.05):

| Service | USD |
| --- | --- |
| Elastic Load Balancing (ALB hours + LCUs) | 8.26 |
| RDS (`db.t4g.micro` + storage) | 6.21 |
| ECS (Fargate) | 3.34 |
| VPC (public IPv4 addresses) | 2.93 |
| WAF | 2.05 |
| Secrets Manager | 0.12 |
| Everything else (CloudFront, S3, API Gateway, Lambda, SQS, SNS, DynamoDB, CloudWatch, ECR, Cognito) | < 0.05 each |

AWS Budgets: `ticketmastery-dev-monthly-cost`, limit USD 80/month, notifications at USD 20 / 40 / 60 / 80 actual and
forecast > 80 to the team email. On 1 Nov: actual USD 0.00 (credits applied), forecast USD 2.00.

| NFR | Target | Measured | Result |
| --- | --- | --- | --- |
| NFR-11 | Total spend under USD 80 for the project | USD 22.92 of usage in October (≈ 9 days deployed), USD 0 charged after credits; Budgets alerts in place | PASS so far |
