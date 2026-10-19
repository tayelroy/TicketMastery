variable "name" {
  description = "Name prefix for all network resources, e.g. ticketmastery-dev."
  type        = string
}

variable "vpc_cidr" {
  description = "CIDR block for the VPC. Subnets are carved as /24s: public x.x.0-1.0/24, private x.x.10-11.0/24."
  type        = string
  default     = "10.20.0.0/16"

  validation {
    condition     = can(cidrhost(var.vpc_cidr, 0)) && tonumber(split("/", var.vpc_cidr)[1]) <= 16
    error_message = "vpc_cidr must be a valid IPv4 CIDR of /16 or larger."
  }
}

variable "enable_nat_gateway" {
  description = "Create NAT gateway(s) so private subnets (ECS tasks in the HA design, VPC Lambdas) get outbound internet access. ~USD 43/month per NAT (USD 0.059/h in ap-southeast-1) plus USD 0.059/GB processed."
  type        = bool
  default     = true
}

variable "single_nat_gateway" {
  description = "When NAT is enabled, use one shared NAT in the first AZ (cheaper, not AZ-redundant) instead of one NAT per AZ."
  type        = bool
  default     = true
}

variable "enable_gateway_endpoints" {
  description = "Create S3 and DynamoDB gateway endpoints on the private route tables. Free; keeps S3/DynamoDB traffic off the NAT. ECR image layers are served from S3, so this is required for image pulls by private-subnet tasks when NAT is disabled."
  type        = bool
  default     = true
}

variable "enable_vpc_endpoints" {
  description = "Create interface endpoints (ecr.api, ecr.dkr, logs, secretsmanager, sqs) in the private subnets. Lets Fargate run without NAT, but each endpoint costs ~USD 0.013/hour per AZ (~USD 95/month for all 5 across 2 AZs)."
  type        = bool
  default     = false
}

variable "interface_endpoint_services" {
  description = "AWS service short names for interface endpoints when enable_vpc_endpoints = true."
  type        = list(string)
  default     = ["ecr.api", "ecr.dkr", "logs", "secretsmanager", "sqs"]
}
