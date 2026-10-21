data "aws_caller_identity" "current" {}

resource "aws_iam_openid_connect_provider" "github" {
  url = "https://token.actions.githubusercontent.com"

  client_id_list = [
    "sts.amazonaws.com"
  ]
}

data "aws_iam_policy_document" "github_trust" {
  statement {
    effect = "Allow"

    actions = [
      "sts:AssumeRoleWithWebIdentity"
    ]

    principals {
      type = "Federated"

      identifiers = [
        aws_iam_openid_connect_provider.github.arn
      ]
    }

    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:aud"

      values = [
        "sts.amazonaws.com"
      ]
    }

    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:sub"

      values = [
        "repo:${var.github_repository}:ref:refs/heads/main"
      ]
    }
  }
}

resource "aws_iam_role" "github_deploy" {
  name               = "${var.name}-github-deploy"
  assume_role_policy = data.aws_iam_policy_document.github_trust.json
}

data "aws_iam_policy_document" "deploy_permissions" {
  statement {
    sid = "ListFrontendBucket"

    effect = "Allow"

    actions = [
      "s3:ListBucket"
    ]

    resources = [
      var.frontend_bucket_arn
    ]
  }

  statement {
    sid = "ManageFrontendObjects"

    effect = "Allow"

    actions = [
      "s3:PutObject",
      "s3:DeleteObject"
    ]

    resources = [
      "${var.frontend_bucket_arn}/*"
    ]
  }

  statement {
    sid = "InvalidateCloudFront"

    effect = "Allow"

    actions = [
      "cloudfront:CreateInvalidation"
    ]

    resources = [
      var.cloudfront_distribution_arn
    ]
  }
}

resource "aws_iam_role_policy" "github_deploy" {
  name   = "${var.name}-github-deploy-policy"
  role   = aws_iam_role.github_deploy.id
  policy = data.aws_iam_policy_document.deploy_permissions.json
}
