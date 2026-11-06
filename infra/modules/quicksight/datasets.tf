# Data source and datasets. Created only once QuickSight may read the reporting secret (secret_access_granted).

# Metadata only: Terraform state holds the secret's ARN, never its value.
data "aws_secretsmanager_secret" "reporting" {
  count = var.secret_access_granted ? 1 : 0

  name = var.reporting_secret_name
}

locals {
  data_source_actions = [
    "quicksight:DescribeDataSource",
    "quicksight:DescribeDataSourcePermissions",
    "quicksight:PassDataSource",
    "quicksight:UpdateDataSource",
    "quicksight:DeleteDataSource",
    "quicksight:UpdateDataSourcePermissions",
  ]
  data_set_actions = [
    "quicksight:DescribeDataSet",
    "quicksight:DescribeDataSetPermissions",
    "quicksight:PassDataSet",
    "quicksight:DescribeIngestion",
    "quicksight:ListIngestions",
    "quicksight:UpdateDataSet",
    "quicksight:DeleteDataSet",
    "quicksight:CreateIngestion",
    "quicksight:CancelIngestion",
    "quicksight:UpdateDataSetPermissions",
  ]

  # One dataset per report_* view (migration 0003), column types from the view definitions. Custom SQL instead of
  # a plain table so uuid and enum columns arrive as text, and each *_cents column gets a dollars column next to it.
  # sum() of integer columns is bigint, so every count and cents column is INTEGER.
  views = {
    confirmed_orders = {
      title = "Confirmed orders"
      columns = [
        { name = "order_id", type = "STRING", sql = "order_id::text" },
        { name = "concert_id", type = "STRING", sql = "concert_id::text" },
        { name = "organiser_id", type = "STRING" },
        { name = "currency", type = "STRING", sql = "currency::text" },
        { name = "seats", type = "INTEGER" },
        { name = "ticket_revenue_cents", type = "INTEGER" },
        { name = "booking_fee_cents", type = "INTEGER" },
        { name = "gross_revenue_cents", type = "INTEGER" },
        { name = "confirmed_at", type = "DATETIME" },
        { name = "sale_date_sgt", type = "DATETIME" },
      ]
    }
    sales_by_concert = {
      title = "Sales by concert"
      columns = [
        { name = "concert_id", type = "STRING", sql = "concert_id::text" },
        { name = "organiser_id", type = "STRING" },
        { name = "concert_title", type = "STRING" },
        { name = "artist", type = "STRING" },
        { name = "venue_name", type = "STRING" },
        { name = "concert_starts_at", type = "DATETIME" },
        { name = "concert_status", type = "STRING", sql = "concert_status::text" },
        { name = "currency", type = "STRING", sql = "currency::text" },
        { name = "confirmed_orders", type = "INTEGER" },
        { name = "seats_sold", type = "INTEGER" },
        { name = "ticket_revenue_cents", type = "INTEGER" },
        { name = "booking_fee_cents", type = "INTEGER" },
        { name = "gross_revenue_cents", type = "INTEGER" },
      ]
    }
    sales_by_ticket_type = {
      title = "Sales by ticket type"
      columns = [
        { name = "concert_id", type = "STRING", sql = "concert_id::text" },
        { name = "organiser_id", type = "STRING" },
        { name = "concert_title", type = "STRING" },
        { name = "ticket_type_id", type = "STRING", sql = "ticket_type_id::text" },
        { name = "ticket_type_name", type = "STRING" },
        { name = "ticket_type_sort_order", type = "INTEGER" },
        { name = "currency", type = "STRING", sql = "currency::text" },
        { name = "confirmed_orders", type = "INTEGER" },
        { name = "seats_sold", type = "INTEGER" },
        { name = "ticket_revenue_cents", type = "INTEGER" },
      ]
    }
    sales_by_day = {
      title = "Sales by day"
      columns = [
        { name = "sale_date", type = "DATETIME" },
        { name = "concert_id", type = "STRING", sql = "concert_id::text" },
        { name = "organiser_id", type = "STRING" },
        { name = "concert_title", type = "STRING" },
        { name = "currency", type = "STRING", sql = "currency::text" },
        { name = "confirmed_orders", type = "INTEGER" },
        { name = "seats_sold", type = "INTEGER" },
        { name = "ticket_revenue_cents", type = "INTEGER" },
        { name = "booking_fee_cents", type = "INTEGER" },
        { name = "gross_revenue_cents", type = "INTEGER" },
      ]
    }
    seat_status = {
      title = "Seat status"
      columns = [
        { name = "concert_id", type = "STRING", sql = "concert_id::text" },
        { name = "organiser_id", type = "STRING" },
        { name = "concert_title", type = "STRING" },
        { name = "concert_starts_at", type = "DATETIME" },
        { name = "concert_status", type = "STRING", sql = "concert_status::text" },
        { name = "available", type = "INTEGER" },
        { name = "held", type = "INTEGER" },
        { name = "sold", type = "INTEGER" },
        { name = "total", type = "INTEGER" },
      ]
    }
  }

  # Final column list per dataset: the view's columns, then <x> = <x>_cents / 100.0 (numeric, DECIMAL) per cents column.
  data_set_columns = {
    for key, view in local.views : key => concat(
      [for c in view.columns : { name = c.name, type = c.type, sql = try(c.sql, c.name) }],
      [for c in view.columns : { name = trimsuffix(c.name, "_cents"), type = "DECIMAL", sql = "${c.name} / 100.0" } if endswith(c.name, "_cents")],
    )
  }
}

resource "aws_quicksight_data_source" "postgres" {
  count = var.secret_access_granted ? 1 : 0

  data_source_id = "${var.name}-postgres"
  name           = "TicketMastery RDS (reporting_ro)"
  type           = "POSTGRESQL"

  parameters {
    postgresql {
      host     = var.db_host
      port     = var.db_port
      database = var.db_name
    }
  }

  # QuickSight reads username/password from the secret at query time (role aws-quicksight-secretsmanager-role-v0).
  credentials {
    secret_arn = data.aws_secretsmanager_secret.reporting[0].arn
  }

  vpc_connection_properties {
    vpc_connection_arn = aws_quicksight_vpc_connection.this.arn
  }

  # RDS for PostgreSQL 15+ enforces TLS (rds.force_ssl = 1).
  ssl_properties {
    disable_ssl = false
  }

  permission {
    principal = local.admin_principal
    actions   = local.data_source_actions
  }
}

# DIRECT_QUERY: every visual queries the views live, so there is no SPICE capacity or refresh schedule to manage.
resource "aws_quicksight_data_set" "this" {
  for_each = { for key, view in local.views : key => view.title if var.secret_access_granted }

  data_set_id = "${var.name}-${replace(each.key, "_", "-")}"
  name        = each.value
  import_mode = "DIRECT_QUERY"

  physical_table_map {
    physical_table_map_id = replace(each.key, "_", "-")

    custom_sql {
      data_source_arn = aws_quicksight_data_source.postgres[0].arn
      name            = "report_${each.key}"
      sql_query       = "SELECT ${join(", ", [for c in local.data_set_columns[each.key] : c.sql == c.name ? c.name : "${c.sql} AS ${c.name}"])} FROM ${var.db_schema}.report_${each.key}"

      dynamic "columns" {
        for_each = local.data_set_columns[each.key]
        content {
          name = columns.value.name
          type = columns.value.type
        }
      }
    }
  }

  # Declared, not left to QuickSight's default, so plans stay empty after apply.
  logical_table_map {
    logical_table_map_id = replace(each.key, "_", "-")
    alias                = "report_${each.key}"

    source {
      physical_table_id = replace(each.key, "_", "-")
    }
  }

  permissions {
    principal = local.admin_principal
    actions   = local.data_set_actions
  }
}
