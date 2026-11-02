#!/usr/bin/env bash
# NFR-10 configuration evidence (read-only): HTTPS everywhere, encryption at rest, database only in private subnets.
# Prints the raw AWS answers and a summary table to results/nfr10-config-<ts>.{json,md}.
#
#   scripts/nfr10-config.sh
source "$(dirname "$0")/lib.sh"
require_aws

# --- RDS -------------------------------------------------------------------------------------------------------
RDS="$(aws rds describe-db-instances --db-instance-identifier "$DB_INSTANCE" --output json | jq '.DBInstances[0] | {
  DBInstanceIdentifier, PubliclyAccessible, StorageEncrypted, KmsKeyId, MultiAZ, AvailabilityZone,
  Endpoint: .Endpoint.Address, CACertificateIdentifier, BackupRetentionPeriod, DeletionProtection,
  DBSubnetGroup: .DBSubnetGroup.DBSubnetGroupName, Subnets: [.DBSubnetGroup.Subnets[].SubnetIdentifier],
  VpcId: .DBSubnetGroup.VpcId, SecurityGroups: [.VpcSecurityGroups[].VpcSecurityGroupId]}')"
VPC_ID="$(jq -r .VpcId <<<"$RDS")"

# A subnet is public if its route table (explicit association, else the VPC main table) sends 0.0.0.0/0 to an IGW.
ROUTES="$(aws ec2 describe-route-tables --filters Name=vpc-id,Values="$VPC_ID" --output json)"
SUBNETS="$(jq -c --argjson rt "$ROUTES" '[.Subnets[] as $s | {
    subnet: $s,
    table: (([$rt.RouteTables[] | select(any(.Associations[]?; .SubnetId == $s))] | first)
            // ([$rt.RouteTables[] | select(any(.Associations[]?; .Main == true))] | first))}
  | {subnet, igwRoute: any(.table.Routes[]?; .DestinationCidrBlock == "0.0.0.0/0" and ((.GatewayId // "") | startswith("igw-")))}]' <<<"$RDS")"
SUBNET_NAMES="$(aws ec2 describe-subnets --subnet-ids $(jq -r '.Subnets | join(" ")' <<<"$RDS") --output json |
  jq '[.Subnets[] | {subnet: .SubnetId, az: .AvailabilityZone, cidr: .CidrBlock, mapPublicIpOnLaunch: .MapPublicIpOnLaunch,
       name: ((.Tags // []) | map(select(.Key == "Name")) | first | .Value)}]')"
DB_SUBNETS="$(jq -n --argjson a "$SUBNETS" --argjson b "$SUBNET_NAMES" '[$a[] as $x | ($b[] | select(.subnet == $x.subnet)) + {igwRoute: $x.igwRoute}]')"
RDS_SG_INGRESS="$(aws ec2 describe-security-groups --group-ids $(jq -r '.SecurityGroups | join(" ")' <<<"$RDS") --output json |
  jq '[.SecurityGroups[].IpPermissions[] | {port: .FromPort, fromSecurityGroups: [.UserIdGroupPairs[].GroupId], fromCidrs: [.IpRanges[].CidrIp]}]')"

# --- ALB -------------------------------------------------------------------------------------------------------
ALB="$(aws elbv2 describe-load-balancers --names "$ALB_NAME" --output json | jq '.LoadBalancers[0] | {LoadBalancerName, Scheme, DNSName, LoadBalancerArn}')"
LISTENERS="$(aws elbv2 describe-listeners --load-balancer-arn "$(jq -r .LoadBalancerArn <<<"$ALB")" --output json |
  jq '[.Listeners[] | {Port, Protocol, SslPolicy, DefaultAction: .DefaultActions[0].Type, Redirect: .DefaultActions[0].RedirectConfig}]')"

# --- CloudFront + WAF ------------------------------------------------------------------------------------------
CF_ID="${CLOUDFRONT_ID:-$(aws cloudfront list-distributions --query "DistributionList.Items[?Comment=='$NAME frontend'].Id | [0]" --output text)}"
CF="$(aws cloudfront get-distribution-config --id "$CF_ID" --output json | jq --arg id "$CF_ID" '.DistributionConfig | {
  Id: $id, DefaultViewerProtocolPolicy: .DefaultCacheBehavior.ViewerProtocolPolicy,
  Behaviors: [(.CacheBehaviors.Items // [])[] | {PathPattern, ViewerProtocolPolicy}],
  Origins: [.Origins.Items[] | {DomainName, OriginProtocolPolicy: (.CustomOriginConfig.OriginProtocolPolicy // "s3 (OAC, HTTPS)"),
            OriginAccessControl: (.OriginAccessControlId != "")}],
  MinimumProtocolVersion: .ViewerCertificate.MinimumProtocolVersion,
  DefaultCertificate: .ViewerCertificate.CloudFrontDefaultCertificate, WebACLId}')"
WAF_ARN="$(jq -r .WebACLId <<<"$CF")"
WAF="null"
if [[ -n "$WAF_ARN" && "$WAF_ARN" != "null" ]]; then
  WAF_NAME="$(cut -d/ -f3 <<<"$WAF_ARN")"; WAF_UUID="$(cut -d/ -f4 <<<"$WAF_ARN")"
  WAF="$(aws wafv2 get-web-acl --region us-east-1 --scope CLOUDFRONT --name "$WAF_NAME" --id "$WAF_UUID" --output json |
    jq '.WebACL | {Name, Rules: [.Rules[] | {Name, Priority, RateLimit: .Statement.RateBasedStatement.Limit,
        Window: .Statement.RateBasedStatement.EvaluationWindowSec,
        Managed: .Statement.ManagedRuleGroupStatement.Name, Action: ((.Action // .OverrideAction) | keys[0])}]}')"
fi

# --- API Gateway -----------------------------------------------------------------------------------------------
API="$(aws apigatewayv2 get-apis --output json | jq --arg n "$HTTP_API_NAME" '.Items[] | select(.Name == $n) | {ApiId, ApiEndpoint, ProtocolType, DisableExecuteApiEndpoint}')"
STAGE="$(aws apigatewayv2 get-stages --api-id "$(jq -r .ApiId <<<"$API")" --output json |
  jq '[.Items[] | {StageName, Throttling: .DefaultRouteSettings | {ThrottlingRateLimit, ThrottlingBurstLimit}}]')"

# --- S3 / SQS encryption ---------------------------------------------------------------------------------------
BUCKETS="$(for b in $(aws s3api list-buckets --query "Buckets[?starts_with(Name, '$NAME-')].Name" --output text); do
  enc="$(aws s3api get-bucket-encryption --bucket "$b" --query 'ServerSideEncryptionConfiguration.Rules[0].ApplyServerSideEncryptionByDefault.SSEAlgorithm' --output text 2>/dev/null || echo none)"
  pab="$(aws s3api get-public-access-block --bucket "$b" --query 'PublicAccessBlockConfiguration' --output json 2>/dev/null || echo null)"
  jq -n --arg b "$b" --arg enc "$enc" --argjson pab "$pab" '{bucket: $b, encryption: $enc, blockAllPublicAccess: ($pab != null and ($pab | all))}'
done | jq -s .)"
QUEUES="$(for q in $(aws sqs list-queues --query 'QueueUrls[]' --output text); do
  aws sqs get-queue-attributes --queue-url "$q" --attribute-names SqsManagedSseEnabled KmsMasterKeyId --output json |
    jq --arg q "${q##*/}" '{queue: $q, sse: (if .Attributes.KmsMasterKeyId then "KMS" elif .Attributes.SqsManagedSseEnabled == "true" then "SQS-managed" else "none" end)}'
done | jq -s .)"

result_files nfr10-config
jq -n --argjson rds "$RDS" --argjson dbSubnets "$DB_SUBNETS" --argjson rdsIngress "$RDS_SG_INGRESS" --argjson alb "$ALB" \
  --argjson listeners "$LISTENERS" --argjson cf "$CF" --argjson waf "$WAF" --argjson api "$API" --argjson stages "$STAGE" \
  --argjson buckets "$BUCKETS" --argjson queues "$QUEUES" --arg at "$(iso_now)" '
  {test: "nfr10-config", checkedAt: $at, rds: ($rds + {subnets: $dbSubnets, ingress: $rdsIngress}), alb: ($alb + {listeners: $listeners}),
   cloudfront: $cf, waf: $waf, apiGateway: ($api + {stages: $stages}), s3: $buckets, sqs: $queues}
  | .checks = {
      rdsNotPublic: (.rds.PubliclyAccessible == false),
      rdsEncrypted: (.rds.StorageEncrypted == true),
      rdsPrivateSubnetsOnly: ([.rds.subnets[].igwRoute] | any | not),
      albInternal: (.alb.Scheme == "internal"),
      cloudfrontHttpsOnly: ((.cloudfront.DefaultViewerProtocolPolicy != "allow-all") and ([.cloudfront.Behaviors[].ViewerProtocolPolicy] | all(. != "allow-all"))),
      apiGatewayHttpsOnly: (.apiGateway.ApiEndpoint | startswith("https://")),
      s3Encrypted: ([.s3[].encryption] | all(. != "none")),
      sqsEncrypted: ([.sqs[].sse] | all(. != "none"))}
  | .pass = ([.checks[]] | all)' > "$RESULT_JSON"

jq -r '
  def yn: if . then "yes" else "NO" end;
  "# nfr10-config (\(.checkedAt))\n",
  "| Check | Evidence | OK |", "| --- | --- | --- |",
  "| RDS not publicly accessible | `\(.rds.DBInstanceIdentifier)` PubliclyAccessible = \(.rds.PubliclyAccessible) | \(.checks.rdsNotPublic | yn) |",
  "| RDS encrypted at rest | StorageEncrypted = \(.rds.StorageEncrypted) (KMS \(.rds.KmsKeyId | split("/") | last)) | \(.checks.rdsEncrypted | yn) |",
  "| DB subnets private | \([.rds.subnets[] | "\(.name // .subnet) (\(.az), IGW route: \(.igwRoute))"] | join(", ")); ingress only from \([.rds.ingress[].fromSecurityGroups[]] | join(", ")) | \(.checks.rdsPrivateSubnetsOnly | yn) |",
  "| ALB internal | Scheme = \(.alb.Scheme); listeners \([.alb.listeners[] | "\(.Protocol):\(.Port) → \(.DefaultAction)"] | join(", ")) | \(.checks.albInternal | yn) |",
  "| CloudFront HTTPS | default \(.cloudfront.DefaultViewerProtocolPolicy); \([.cloudfront.Behaviors[] | "\(.PathPattern) \(.ViewerProtocolPolicy)"] | join(", ")); origins \([.cloudfront.Origins[] | .OriginProtocolPolicy] | join(", ")) | \(.checks.cloudfrontHttpsOnly | yn) |",
  "| API Gateway HTTPS | \(.apiGateway.ApiEndpoint); throttling \([.apiGateway.stages[] | "\(.Throttling.ThrottlingRateLimit) rps / burst \(.Throttling.ThrottlingBurstLimit)"] | join(", ")) | \(.checks.apiGatewayHttpsOnly | yn) |",
  "| WAF on CloudFront | \(if .waf then [.waf.Rules[] | "\(.Name)\(if .RateLimit then " (\(.RateLimit) / \(.Window // 300) s / IP)" else "" end)"] | join(", ") else "none" end) | \((.waf != null) | yn) |",
  "| S3 encrypted, public access blocked | \([.s3[] | "\(.bucket): \(.encryption), block public \(.blockAllPublicAccess)"] | join("; ")) | \(.checks.s3Encrypted | yn) |",
  "| SQS encrypted | \([.sqs[] | "\(.queue): \(.sse)"] | join(", ")) | \(.checks.sqsEncrypted | yn) |",
  "\nNFR-10: \(if .pass then "PASS" else "FAIL" end)"
' "$RESULT_JSON" | tee "$RESULT_MD"
log "written $RESULT_JSON and .md"
