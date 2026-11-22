locals {
  subnet_cidrs = {
    application = var.network_cidrs.application
    database_a  = var.network_cidrs.database_a
    database_b  = var.network_cidrs.database_b
  }
  vpc_prefix = try(tonumber(split("/", var.network_cidrs.vpc)[1]), 0)
  subnet_prefixes = {
    for name, cidr in local.subnet_cidrs : name => try(tonumber(split("/", cidr)[1]), 0)
  }
}

resource "aws_vpc" "advisor" {
  cidr_block           = var.network_cidrs.vpc
  enable_dns_support   = true
  enable_dns_hostnames = true

  tags = { Name = "${var.name_prefix}-vpc" }

  lifecycle {
    precondition {
      condition = alltrue([
        for name, cidr in local.subnet_cidrs : try(
          local.subnet_prefixes[name] >= local.vpc_prefix &&
          cidrhost("${cidrhost(cidr, 0)}/${local.vpc_prefix}", 0) == cidrhost(var.network_cidrs.vpc, 0),
          false
        )
      ])
      error_message = "Each subnet CIDR must be contained in the VPC CIDR."
    }

    precondition {
      condition = alltrue(flatten([
        for left, left_cidr in local.subnet_cidrs : [
          for right, right_cidr in local.subnet_cidrs : try(
            cidrhost("${cidrhost(left_cidr, 0)}/${min(local.subnet_prefixes[left], local.subnet_prefixes[right])}", 0) !=
            cidrhost("${cidrhost(right_cidr, 0)}/${min(local.subnet_prefixes[left], local.subnet_prefixes[right])}", 0),
            false
          ) if left != right
        ]
      ]))
      error_message = "Application and database subnet CIDRs must not overlap."
    }
  }
}

resource "aws_subnet" "application" {
  vpc_id                  = aws_vpc.advisor.id
  cidr_block              = var.network_cidrs.application
  availability_zone       = var.availability_zones.application
  map_public_ip_on_launch = false

  tags = { Name = "${var.name_prefix}-application" }
}

resource "aws_subnet" "database" {
  for_each = {
    database_a = var.availability_zones.database_a
    database_b = var.availability_zones.database_b
  }

  vpc_id                  = aws_vpc.advisor.id
  cidr_block              = local.subnet_cidrs[each.key]
  availability_zone       = each.value
  map_public_ip_on_launch = false

  tags = { Name = "${var.name_prefix}-${replace(each.key, "_", "-")}" }
}

resource "aws_internet_gateway" "application" {
  vpc_id = aws_vpc.advisor.id

  tags = { Name = "${var.name_prefix}-igw" }
}

resource "aws_route_table" "application" {
  vpc_id = aws_vpc.advisor.id

  route {
    cidr_block = "0.0.0.0/0"
    gateway_id = aws_internet_gateway.application.id
  }

  tags = { Name = "${var.name_prefix}-application" }
}

resource "aws_route_table" "database" {
  vpc_id = aws_vpc.advisor.id
  route  = []

  tags = { Name = "${var.name_prefix}-database" }
}

resource "aws_route_table_association" "application" {
  subnet_id      = aws_subnet.application.id
  route_table_id = aws_route_table.application.id
}

resource "aws_route_table_association" "database" {
  for_each = aws_subnet.database

  subnet_id      = each.value.id
  route_table_id = aws_route_table.database.id
}

resource "aws_security_group" "application" {
  name        = "${var.name_prefix}-application"
  description = "No inbound access for the application host"
  vpc_id      = aws_vpc.advisor.id
  ingress     = []

  egress {
    description = "Outbound HTTPS for Systems Manager and Secrets Manager"
    protocol    = "tcp"
    from_port   = 443
    to_port     = 443
    cidr_blocks = ["0.0.0.0/0"]
  }

  egress {
    description = "PostgreSQL to the database subnets"
    protocol    = "tcp"
    from_port   = 5432
    to_port     = 5432
    cidr_blocks = [local.subnet_cidrs.database_a, local.subnet_cidrs.database_b]
  }
}

resource "aws_security_group" "database" {
  name        = "${var.name_prefix}-database"
  description = "PostgreSQL from the application security group only"
  vpc_id      = aws_vpc.advisor.id
  egress      = []

  ingress {
    description     = "PostgreSQL from the application security group"
    protocol        = "tcp"
    from_port       = 5432
    to_port         = 5432
    security_groups = [aws_security_group.application.id]
  }
}
