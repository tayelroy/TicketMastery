# Reporting views on the live database (UC5)

Queried 2026-11-01 09:4x UTC inside the VPC through ECS Exec (`SELECT * FROM report_sales_by_concert ORDER BY gross_revenue_cents DESC`), after the NFR-3 runs and the functional walk-through. Amounts in currency units.

| Concert | Currency | Confirmed orders | Seats sold | Ticket revenue | Booking fees | Gross |
| --- | --- | --- | --- | --- | --- | --- |
| Load test 20261101T093411Z | SGD | 10 | 20 | 1,000.00 | 80.00 | 1,080.00 |
| Load test 20261101T092932Z | SGD | 10 | 20 | 1,000.00 | 80.00 | 1,080.00 |
| TicketMastery Demo Night | SGD | 1 | 2 | 176.00 | 8.00 | 184.00 |

The two load-test concerts match the NFR-3 runs (10 orders × 2 seats at SGD 50 + SGD 4 booking fee per seat); Demo Night is the walk-through purchase in `screens/uc4-*` (2 Standard seats, SGD 184.00). `report_sales_by_ticket_type` and `report_sales_by_day` returned the same totals per ticket type and per Singapore day.
