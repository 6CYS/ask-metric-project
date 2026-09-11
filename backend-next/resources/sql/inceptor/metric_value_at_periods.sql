WITH requested_periods AS (
    SELECT 0 AS period_no, CAST(:period_start_0 AS DATE) AS period_start,
           CAST(:period_end_0 AS DATE) AS period_end WHERE :period_count > 0
    UNION ALL SELECT 1, CAST(:period_start_1 AS DATE), CAST(:period_end_1 AS DATE) WHERE :period_count > 1
    UNION ALL SELECT 2, CAST(:period_start_2 AS DATE), CAST(:period_end_2 AS DATE) WHERE :period_count > 2
    UNION ALL SELECT 3, CAST(:period_start_3 AS DATE), CAST(:period_end_3 AS DATE) WHERE :period_count > 3
    UNION ALL SELECT 4, CAST(:period_start_4 AS DATE), CAST(:period_end_4 AS DATE) WHERE :period_count > 4
    UNION ALL SELECT 5, CAST(:period_start_5 AS DATE), CAST(:period_end_5 AS DATE) WHERE :period_count > 5
    UNION ALL SELECT 6, CAST(:period_start_6 AS DATE), CAST(:period_end_6 AS DATE) WHERE :period_count > 6
    UNION ALL SELECT 7, CAST(:period_start_7 AS DATE), CAST(:period_end_7 AS DATE) WHERE :period_count > 7
    UNION ALL SELECT 8, CAST(:period_start_8 AS DATE), CAST(:period_end_8 AS DATE) WHERE :period_count > 8
    UNION ALL SELECT 9, CAST(:period_start_9 AS DATE), CAST(:period_end_9 AS DATE) WHERE :period_count > 9
    UNION ALL SELECT 10, CAST(:period_start_10 AS DATE), CAST(:period_end_10 AS DATE) WHERE :period_count > 10
    UNION ALL SELECT 11, CAST(:period_start_11 AS DATE), CAST(:period_end_11 AS DATE) WHERE :period_count > 11
),
normalized AS (
    SELECT f.{{fact_metric_code_field}} AS metric_code,
           f.{{fact_org_code_field}} AS org_code,
           f.{{fact_data_date_field}} AS stat_date,
           CASE
             WHEN TRIM(f.{{fact_value_field}}) RLIKE '^[+-]?[0-9]+([.][0-9]+)?$'
              AND CAST(TRIM(f.{{fact_value_field}}) AS DECIMAL(38, 10)) <> CAST(-999.999 AS DECIMAL(38, 10))
             THEN CAST(TRIM(f.{{fact_value_field}}) AS DECIMAL(38, 10))
             ELSE NULL
           END AS metric_value,
           CASE
             WHEN f.{{fact_increment_field}} IS NOT NULL
              AND CAST(f.{{fact_increment_field}} AS DECIMAL(38, 10)) <> CAST(-999.999 AS DECIMAL(38, 10))
             THEN CAST(f.{{fact_increment_field}} AS DECIMAL(38, 10))
             ELSE NULL
           END AS metric_increment,
           ROW_NUMBER() OVER (
             PARTITION BY f.{{fact_org_code_field}}, f.{{fact_metric_code_field}}, f.{{fact_data_date_field}}
             ORDER BY {{batch_order}}
           ) AS version_rank
    FROM {{fact_table}} AS f
    WHERE f.{{fact_metric_code_field}} IN :metric_codes
      AND (:filter_orgs = FALSE OR f.{{fact_org_code_field}} IN :org_codes)
      AND f.{{fact_data_date_field}} BETWEEN CAST(:start_date AS DATE) AND CAST(:end_date AS DATE)
),
facts AS (
    SELECT metric_code, org_code, stat_date, metric_value, metric_increment
    FROM normalized
    WHERE version_rank = 1 AND metric_value IS NOT NULL
),
ranked AS (
    SELECT p.period_no, f.*,
           ROW_NUMBER() OVER (
             PARTITION BY p.period_no, f.metric_code, f.org_code
             ORDER BY f.stat_date DESC
           ) AS period_rank
    FROM requested_periods AS p
    JOIN facts AS f ON f.stat_date BETWEEN p.period_start AND p.period_end
)
SELECT metric_code, org_code, metric_value, stat_date, metric_increment
FROM ranked
WHERE period_rank = 1
ORDER BY period_no, metric_code, org_code
LIMIT :limit
