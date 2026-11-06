# One dashboard, sheet "Sales": two KPIs, revenue per concert, revenue per day, and a ticket-type table.
# Amounts are gross revenue (what fans paid) in dollars; every visual is filtered to var.currency.

locals {
  dashboard_data_sets = ["sales_by_concert", "sales_by_day", "sales_by_ticket_type"]

  kpis = {
    kpi-gross-revenue = { title = "Gross revenue (${var.currency})", column = "gross_revenue" }
    kpi-tickets-sold  = { title = "Tickets sold (${var.currency} orders)", column = "seats_sold" }
  }

  dashboard_actions = [
    "quicksight:DescribeDashboard",
    "quicksight:ListDashboardVersions",
    "quicksight:UpdateDashboardPermissions",
    "quicksight:QueryDashboard",
    "quicksight:UpdateDashboard",
    "quicksight:DeleteDashboard",
    "quicksight:DescribeDashboardPermissions",
    "quicksight:UpdateDashboardPublishedVersion",
  ]
}

resource "aws_quicksight_dashboard" "sales" {
  count = var.secret_access_granted ? 1 : 0

  dashboard_id        = "${var.name}-sales"
  name                = "TicketMastery sales"
  version_description = "Managed by Terraform (infra/modules/quicksight)"

  definition {
    dynamic "data_set_identifiers_declarations" {
      for_each = toset(local.dashboard_data_sets)
      content {
        identifier   = data_set_identifiers_declarations.key
        data_set_arn = aws_quicksight_data_set.this[data_set_identifiers_declarations.key].arn
      }
    }

    # One filter group per dataset: a filter only applies to visuals of its own dataset.
    dynamic "filter_groups" {
      for_each = toset(local.dashboard_data_sets)
      content {
        filter_group_id = "currency-${replace(filter_groups.key, "_", "-")}"
        cross_dataset   = "SINGLE_DATASET"
        status          = "ENABLED"

        filters {
          category_filter {
            filter_id = "currency-${replace(filter_groups.key, "_", "-")}-filter"
            column {
              data_set_identifier = filter_groups.key
              column_name         = "currency"
            }
            configuration {
              filter_list_configuration {
                match_operator  = "CONTAINS"
                category_values = [var.currency]
              }
            }
          }
        }

        scope_configuration {
          selected_sheets {
            sheet_visual_scoping_configurations {
              sheet_id = "sales"
              scope    = "ALL_VISUALS"
            }
          }
        }
      }
    }

    sheets {
      sheet_id = "sales"
      name     = "Sales"

      dynamic "visuals" {
        for_each = local.kpis
        content {
          kpi_visual {
            visual_id = visuals.key
            title {
              format_text {
                plain_text = visuals.value.title
              }
            }
            chart_configuration {
              field_wells {
                values {
                  numerical_measure_field {
                    field_id = "${visuals.key}-value"
                    column {
                      data_set_identifier = "sales_by_concert"
                      column_name         = visuals.value.column
                    }
                    aggregation_function {
                      simple_numerical_aggregation = "SUM"
                    }
                  }
                }
              }
            }
          }
        }
      }

      visuals {
        bar_chart_visual {
          visual_id = "revenue-by-concert"
          title {
            format_text {
              plain_text = "Gross revenue by concert (${var.currency})"
            }
          }
          chart_configuration {
            orientation = "HORIZONTAL"
            field_wells {
              bar_chart_aggregated_field_wells {
                category {
                  categorical_dimension_field {
                    field_id = "revenue-by-concert-title"
                    column {
                      data_set_identifier = "sales_by_concert"
                      column_name         = "concert_title"
                    }
                  }
                }
                values {
                  numerical_measure_field {
                    field_id = "revenue-by-concert-value"
                    column {
                      data_set_identifier = "sales_by_concert"
                      column_name         = "gross_revenue"
                    }
                    aggregation_function {
                      simple_numerical_aggregation = "SUM"
                    }
                  }
                }
              }
            }
          }
        }
      }

      visuals {
        line_chart_visual {
          visual_id = "revenue-by-day"
          title {
            format_text {
              plain_text = "Gross revenue by day, Singapore time (${var.currency})"
            }
          }
          chart_configuration {
            type = "LINE"
            field_wells {
              line_chart_aggregated_field_wells {
                category {
                  date_dimension_field {
                    field_id         = "revenue-by-day-date"
                    date_granularity = "DAY"
                    column {
                      data_set_identifier = "sales_by_day"
                      column_name         = "sale_date"
                    }
                  }
                }
                values {
                  numerical_measure_field {
                    field_id = "revenue-by-day-value"
                    column {
                      data_set_identifier = "sales_by_day"
                      column_name         = "gross_revenue"
                    }
                    aggregation_function {
                      simple_numerical_aggregation = "SUM"
                    }
                  }
                }
              }
            }
          }
        }
      }

      # Ticket types carry face value only: the booking fee is per order (docs/reporting.md).
      visuals {
        table_visual {
          visual_id = "sales-by-ticket-type"
          title {
            format_text {
              plain_text = "Sales by ticket type, face value (${var.currency})"
            }
          }
          chart_configuration {
            field_wells {
              table_aggregated_field_wells {
                group_by {
                  categorical_dimension_field {
                    field_id = "ticket-type-concert"
                    column {
                      data_set_identifier = "sales_by_ticket_type"
                      column_name         = "concert_title"
                    }
                  }
                }
                group_by {
                  categorical_dimension_field {
                    field_id = "ticket-type-name"
                    column {
                      data_set_identifier = "sales_by_ticket_type"
                      column_name         = "ticket_type_name"
                    }
                  }
                }
                values {
                  numerical_measure_field {
                    field_id = "ticket-type-seats"
                    column {
                      data_set_identifier = "sales_by_ticket_type"
                      column_name         = "seats_sold"
                    }
                    aggregation_function {
                      simple_numerical_aggregation = "SUM"
                    }
                  }
                }
                values {
                  numerical_measure_field {
                    field_id = "ticket-type-revenue"
                    column {
                      data_set_identifier = "sales_by_ticket_type"
                      column_name         = "ticket_revenue"
                    }
                    aggregation_function {
                      simple_numerical_aggregation = "SUM"
                    }
                  }
                }
              }
            }
          }
        }
      }

      # 36-column grid, filled in order: KPIs side by side, the two charts side by side, the table below.
      layouts {
        configuration {
          grid_layout {
            dynamic "elements" {
              for_each = [
                { id = "kpi-gross-revenue", columns = 18, rows = 6 },
                { id = "kpi-tickets-sold", columns = 18, rows = 6 },
                { id = "revenue-by-concert", columns = 18, rows = 12 },
                { id = "revenue-by-day", columns = 18, rows = 12 },
                { id = "sales-by-ticket-type", columns = 36, rows = 12 },
              ]
              content {
                element_id   = elements.value.id
                element_type = "VISUAL"
                column_span  = elements.value.columns
                row_span     = elements.value.rows
              }
            }
          }
        }
      }
    }
  }

  permissions {
    principal = local.admin_principal
    actions   = local.dashboard_actions
  }
}
