resource "aws_iam_role" "application" {
  name = "${var.name_prefix}-application"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Action    = "sts:AssumeRole"
      Principal = { Service = "ec2.amazonaws.com" }
    }]
  })
}

resource "aws_iam_role_policy" "session_manager" {
  name = "session-manager-agent"
  role = aws_iam_role.application.name
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect = "Allow"
      Action = [
        "ssm:UpdateInstanceInformation",
        "ssmmessages:CreateControlChannel",
        "ssmmessages:CreateDataChannel",
        "ssmmessages:OpenControlChannel",
        "ssmmessages:OpenDataChannel",
      ]
      # Wildcard resource scope applies only to these agent actions.
      Resource = "*"
    }]
  })
}

resource "aws_iam_role_policy" "application_secrets" {
  name = "application-secret-read"
  role = aws_iam_role.application.name
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = "secretsmanager:GetSecretValue"
      Resource = sort(tolist(var.application_secret_arns))
    }]
  })
}

resource "aws_iam_role_policy" "deny_database_master_secret" {
  name = "deny-database-master-secret-read"
  role = aws_iam_role.application.name
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Deny"
      Action   = "secretsmanager:GetSecretValue"
      Resource = aws_db_instance.catalog.master_user_secret[0].secret_arn
    }]
  })
}

resource "aws_iam_instance_profile" "application" {
  name = "${var.name_prefix}-application"
  role = aws_iam_role.application.name
}

resource "aws_instance" "application" {
  ami                         = var.application_ami_id
  instance_type               = var.application_instance_type
  subnet_id                   = aws_subnet.application.id
  associate_public_ip_address = true
  vpc_security_group_ids      = [aws_security_group.application.id]
  iam_instance_profile        = aws_iam_instance_profile.application.name

  # Attach the intended policies and route before the agent can start.
  depends_on = [
    aws_iam_role_policy.session_manager,
    aws_iam_role_policy.application_secrets,
    aws_iam_role_policy.deny_database_master_secret,
    aws_route_table_association.application,
  ]

  metadata_options {
    http_endpoint               = "enabled"
    http_tokens                 = "required"
    http_put_response_hop_limit = 1
  }

  root_block_device {
    encrypted = true
  }

  tags = { Name = "${var.name_prefix}-application" }
}
