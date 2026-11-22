variable "aws_region" {
  description = "Commercial AWS region for the demo foundation."
  type        = string
  nullable    = false

  validation {
    condition     = can(regex("^[a-z]{2}-[a-z]+-[1-9][0-9]*$", var.aws_region))
    error_message = "Use a commercial AWS region such as us-east-1."
  }
}

variable "name_prefix" {
  description = "Unique prefix for this demo foundation in the target account and region."
  type        = string
  nullable    = false

  validation {
    condition = (
      length(var.name_prefix) <= 24 &&
      can(regex("^[a-z]([a-z0-9]|-[a-z0-9])+$", var.name_prefix))
    )
    error_message = "Use 2–24 lowercase letters, digits, or single interior hyphens, starting with a letter."
  }
}

variable "availability_zones" {
  description = "Explicit app and database availability zones in the selected region."
  type = object({
    application = string
    database_a  = string
    database_b  = string
  })
  nullable = false

  validation {
    condition = (
      alltrue([for zone in values(var.availability_zones) : can(regex("^${var.aws_region}[a-z]$", zone))]) &&
      var.availability_zones.database_a != var.availability_zones.database_b
    )
    error_message = "Use standard availability zones in aws_region and two distinct database zones."
  }
}

variable "network_cidrs" {
  description = "Canonical IPv4 CIDRs for the VPC and its three subnets."
  type = object({
    vpc         = string
    application = string
    database_a  = string
    database_b  = string
  })
  nullable = false

  validation {
    condition = alltrue([
      for cidr in values(var.network_cidrs) : try(
        cidr == format("%s/%d", cidrhost(cidr, 0), tonumber(split("/", cidr)[1])) &&
        can(cidrnetmask(cidr)) &&
        tonumber(split("/", cidr)[1]) >= 16 &&
        tonumber(split("/", cidr)[1]) <= 28,
        false
      )
    ])
    error_message = "Use canonical IPv4 CIDRs with prefix lengths from /16 to /28."
  }
}

variable "application_ami_id" {
  description = "AMI ID in aws_region, selected for the application instance type and Session Manager agent."
  type        = string
  nullable    = false

  validation {
    condition     = can(regex("^ami-[0-9a-f]{17}$", var.application_ami_id))
    error_message = "Use an AMI ID with ami- followed by 17 lowercase hexadecimal characters."
  }
}

variable "application_instance_type" {
  description = "EC2 instance type compatible with the selected AMI."
  type        = string
  nullable    = false

  validation {
    condition     = can(regex("^[a-z][a-z0-9-]*\\.[a-z0-9]+$", var.application_instance_type))
    error_message = "Use an EC2 instance type such as t3.micro."
  }
}

variable "database_engine_version" {
  description = "Explicit PostgreSQL engine version offered by RDS in aws_region."
  type        = string
  nullable    = false

  validation {
    condition     = can(regex("^[1-9][0-9](\\.[0-9]+){1,2}$", var.database_engine_version))
    error_message = "Use a PostgreSQL version that includes a minor version, such as 17.4."
  }
}

variable "database_instance_class" {
  description = "RDS instance class compatible with the selected engine version and storage."
  type        = string
  nullable    = false

  validation {
    condition     = can(regex("^db\\.[a-z][a-z0-9-]*\\.[a-z0-9]+$", var.database_instance_class))
    error_message = "Use an RDS instance class such as db.t4g.micro."
  }
}

variable "database_allocated_storage_gib" {
  description = "Allocated General Purpose SSD (gp3) storage in GiB."
  type        = number
  nullable    = false

  validation {
    condition = (
      var.database_allocated_storage_gib >= 20 &&
      var.database_allocated_storage_gib <= 65536 &&
      floor(var.database_allocated_storage_gib) == var.database_allocated_storage_gib
    )
    error_message = "Use a whole number of GiB between 20 and 65536."
  }
}

variable "application_secret_arns" {
  description = "Exact existing Secrets Manager ARNs for application runtime credentials in the selected region."
  type        = set(string)
  nullable    = false

  validation {
    condition = length(var.application_secret_arns) > 0 && alltrue([
      for arn in var.application_secret_arns :
      can(regex("^arn:aws:secretsmanager:${var.aws_region}:[0-9]{12}:secret:[A-Za-z0-9/_+=.@-]+-[A-Za-z0-9]{6}$", arn))
    ])
    error_message = "Supply one or more full application secret ARNs in aws_region, with their generated suffixes and without wildcards or RDS-managed names."
  }
}
