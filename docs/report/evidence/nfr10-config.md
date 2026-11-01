# nfr10-config (2026-10-31T16:17:02Z)

| Check | Evidence | OK |
| --- | --- | --- |
| RDS not publicly accessible | `ticketmastery-dev-postgres` PubliclyAccessible = false | yes |
| RDS encrypted at rest | StorageEncrypted = true (KMS a558de72-7981-44bc-9552-815fc7ce535b) | yes |
| DB subnets private | ticketmastery-dev-private-ap-southeast-1b (ap-southeast-1b, IGW route: false), ticketmastery-dev-private-ap-southeast-1a (ap-southeast-1a, IGW route: false); ingress only from sg-0e61c4517fde25c0c | yes |
| ALB internal | Scheme = internal; listeners HTTP:80 → forward | yes |
| CloudFront HTTPS | default redirect-to-https; /api/* redirect-to-https, /health redirect-to-https; origins s3 (OAC, HTTPS), https-only | yes |
| API Gateway HTTPS | https://veft7waoye.execute-api.ap-southeast-1.amazonaws.com; throttling 100.0 rps / burst 200 | yes |
| WAF on CloudFront | AWSManagedCommonRules, RateLimit (2000 / 300 s / IP) | yes |
| S3 encrypted, public access blocked | ticketmastery-dev-etickets-20261031155736195500000001: AES256, block public true; ticketmastery-dev-frontend-20261022123512597400000001: AES256, block public true | yes |
| SQS encrypted | join-queue-dlq.fifo: SQS-managed, join-queue.fifo: SQS-managed, ticketmastery-dev-ticket-dlq: SQS-managed, ticketmastery-dev-ticket-queue: SQS-managed | yes |

NFR-10: PASS
