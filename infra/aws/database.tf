resource "aws_db_subnet_group" "catalog" {
  name       = "${var.name_prefix}-catalog"
  subnet_ids = [for subnet in aws_subnet.database : subnet.id]

  tags = { Name = "${var.name_prefix}-catalog" }
}

resource "aws_db_instance" "catalog" {
  identifier                  = "${var.name_prefix}-catalog"
  engine                      = "postgres"
  engine_version              = var.database_engine_version
  instance_class              = var.database_instance_class
  allocated_storage           = var.database_allocated_storage_gib
  storage_type                = "gp3"
  storage_encrypted           = true
  port                        = 5432
  db_subnet_group_name        = aws_db_subnet_group.catalog.name
  vpc_security_group_ids      = [aws_security_group.database.id]
  publicly_accessible         = false
  multi_az                    = false
  username                    = "catalog_admin"
  manage_master_user_password = true
  backup_retention_period     = 7
  deletion_protection         = true
  skip_final_snapshot         = false
  final_snapshot_identifier   = "${var.name_prefix}-catalog-final"

  depends_on = [aws_route_table_association.database]

  tags = { Name = "${var.name_prefix}-catalog" }
}
