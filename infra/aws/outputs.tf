output "vpc_id" {
  description = "Identifier of the demo VPC."
  value       = aws_vpc.advisor.id
}

output "application_instance_id" {
  description = "EC2 instance identifier for a future authorized Session Manager session."
  value       = aws_instance.application.id
}

output "database_address" {
  description = "Private RDS DNS hostname for a future approved runtime configuration."
  value       = aws_db_instance.catalog.address
}

output "database_port" {
  description = "PostgreSQL TCP port."
  value       = aws_db_instance.catalog.port
}
