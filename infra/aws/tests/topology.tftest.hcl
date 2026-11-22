mock_provider "aws" {
  override_during = plan
}

variables {
  aws_region  = "us-east-1"
  name_prefix = "p3-test"

  availability_zones = {
    application = "us-east-1a"
    database_a  = "us-east-1a"
    database_b  = "us-east-1b"
  }

  network_cidrs = {
    vpc         = "10.31.0.0/16"
    application = "10.31.0.0/24"
    database_a  = "10.31.1.0/24"
    database_b  = "10.31.2.0/24"
  }

  application_ami_id             = "ami-00000000000000001"
  application_instance_type      = "t3.micro"
  database_engine_version        = "17.4"
  database_instance_class        = "db.t4g.micro"
  database_allocated_storage_gib = 20

  application_secret_arns = [
    "arn:aws:secretsmanager:us-east-1:111122223333:secret:p3-test/demo-AbCd12",
    "arn:aws:secretsmanager:us-east-1:111122223333:secret:p3-test/runtime-EfGh34",
  ]
}

override_resource {
  target          = aws_security_group.application
  override_during = plan
  values          = { id = "sg-00000000000000001" }
}

override_resource {
  target          = aws_security_group.database
  override_during = plan
  values          = { id = "sg-00000000000000002" }
}

override_resource {
  target          = aws_subnet.database["database_a"]
  override_during = plan
  values          = { id = "subnet-00000000000000001" }
}

override_resource {
  target          = aws_subnet.database["database_b"]
  override_during = plan
  values          = { id = "subnet-00000000000000002" }
}

override_resource {
  target          = aws_route_table.application
  override_during = plan
  values          = { id = "rtb-00000000000000001" }
}

override_resource {
  target          = aws_route_table.database
  override_during = plan
  values          = { id = "rtb-00000000000000002" }
}

override_resource {
  target          = aws_db_instance.catalog
  override_during = plan
  values = {
    master_user_secret = [{
      secret_arn = "arn:aws:secretsmanager:us-east-1:111122223333:secret:rds!db-DUMMYMASTER-AbCd56"
    }]
  }
}

run "demo_topology" {
  command = plan

  assert {
    condition = (
      length(aws_security_group.application.ingress) == 0 &&
      toset(aws_instance.application.vpc_security_group_ids) == toset([aws_security_group.application.id])
    )
    error_message = "The application instance must use only its security group with zero ingress rules."
  }

  assert {
    condition = (
      length(aws_security_group.application.egress) == 2 &&
      alltrue([
        for rule in aws_security_group.application.egress :
        rule.protocol == "tcp" && rule.from_port == rule.to_port &&
        try(length(rule.ipv6_cidr_blocks), 0) == 0 && try(length(rule.prefix_list_ids), 0) == 0 &&
        try(length(rule.security_groups), 0) == 0 && !coalesce(rule.self, false) && (
          (rule.from_port == 443 && toset(rule.cidr_blocks) == toset(["0.0.0.0/0"])) ||
          (rule.from_port == 5432 && toset(rule.cidr_blocks) == toset([
            var.network_cidrs.database_a, var.network_cidrs.database_b
          ]))
        )
      ]) &&
      toset([for rule in aws_security_group.application.egress : rule.from_port]) == toset([443, 5432])
    )
    error_message = "Application egress must be limited to IPv4 HTTPS and PostgreSQL to the database subnet ranges."
  }

  assert {
    condition = (
      one(aws_instance.application.metadata_options).http_endpoint == "enabled" &&
      one(aws_instance.application.metadata_options).http_tokens == "required" &&
      one(aws_instance.application.metadata_options).http_put_response_hop_limit == 1
    )
    error_message = "EC2 must require IMDSv2 and limit metadata response hops to one."
  }

  assert {
    condition = (
      !aws_db_instance.catalog.publicly_accessible &&
      !aws_db_instance.catalog.multi_az &&
      aws_db_instance.catalog.port == 5432 &&
      toset(aws_db_instance.catalog.vpc_security_group_ids) == toset([aws_security_group.database.id])
    )
    error_message = "RDS must run privately in one zone, on port 5432, using only the database security group."
  }

  assert {
    condition = length(aws_security_group.database.ingress) == 1 && alltrue([
      for rule in aws_security_group.database.ingress :
      rule.protocol == "tcp" && rule.from_port == 5432 && rule.to_port == 5432 &&
      toset(rule.security_groups) == toset([aws_security_group.application.id]) &&
      try(length(rule.cidr_blocks), 0) == 0 && try(length(rule.ipv6_cidr_blocks), 0) == 0 &&
      try(length(rule.prefix_list_ids), 0) == 0 && !coalesce(rule.self, false)
    ])
    error_message = "The sole database ingress rule must allow TCP 5432 only from the application security group."
  }

  assert {
    condition = (
      length(aws_subnet.database) == 2 &&
      length(toset([for subnet in aws_subnet.database : subnet.availability_zone])) == 2 &&
      aws_db_instance.catalog.db_subnet_group_name == aws_db_subnet_group.catalog.name &&
      toset(aws_db_subnet_group.catalog.subnet_ids) == toset([for subnet in aws_subnet.database : subnet.id])
    )
    error_message = "The RDS subnet group must contain exactly the two database subnets in different availability zones."
  }

  assert {
    condition = (
      length(aws_route_table.database.route) == 0 &&
      length(aws_route_table_association.database) == 2 &&
      alltrue([
        for key, association in aws_route_table_association.database :
        association.subnet_id == aws_subnet.database[key].id &&
        !aws_subnet.database[key].map_public_ip_on_launch &&
        association.route_table_id == aws_route_table.database.id &&
        association.route_table_id != aws_route_table.application.id
      ])
    )
    error_message = "Both database subnets must disable automatic public IPv4 and use the route table with no explicit routes."
  }

  assert {
    condition = (
      aws_db_instance.catalog.storage_encrypted &&
      aws_db_instance.catalog.manage_master_user_password &&
      aws_db_instance.catalog.backup_retention_period == 7 &&
      aws_db_instance.catalog.deletion_protection &&
      !aws_db_instance.catalog.skip_final_snapshot &&
      aws_db_instance.catalog.final_snapshot_identifier == "${var.name_prefix}-catalog-final"
    )
    error_message = "RDS must use encryption, managed master credentials, seven-day retention, deletion protection, and a final snapshot."
  }

  assert {
    condition = (
      aws_instance.application.iam_instance_profile == aws_iam_instance_profile.application.name &&
      aws_iam_instance_profile.application.role == aws_iam_role.application.name &&
      aws_iam_role_policy.application_secrets.role == aws_iam_role.application.name &&
      length(jsondecode(aws_iam_role_policy.application_secrets.policy).Statement) == 1 &&
      one(jsondecode(aws_iam_role_policy.application_secrets.policy).Statement).Effect == "Allow" &&
      one(jsondecode(aws_iam_role_policy.application_secrets.policy).Statement).Action == "secretsmanager:GetSecretValue" &&
      toset(one(jsondecode(aws_iam_role_policy.application_secrets.policy).Statement).Resource) == var.application_secret_arns
    )
    error_message = "The instance's secret allow policy must permit only GetSecretValue on exactly the configured application secret ARNs."
  }

  assert {
    condition = (
      aws_iam_role_policy.deny_database_master_secret.role == aws_iam_role.application.name &&
      length(jsondecode(aws_iam_role_policy.deny_database_master_secret.policy).Statement) == 1 &&
      one(jsondecode(aws_iam_role_policy.deny_database_master_secret.policy).Statement).Effect == "Deny" &&
      one(jsondecode(aws_iam_role_policy.deny_database_master_secret.policy).Statement).Action == "secretsmanager:GetSecretValue" &&
      one(jsondecode(aws_iam_role_policy.deny_database_master_secret.policy).Statement).Resource == aws_db_instance.catalog.master_user_secret[0].secret_arn
    )
    error_message = "The application role must explicitly deny reading the catalog master secret."
  }
}
