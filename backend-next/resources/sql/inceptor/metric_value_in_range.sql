WITH normalized AS (
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
selected AS (
 SELECT *, ROW_NUMBER() OVER (
   PARTITION BY metric_code, org_code ORDER BY stat_date DESC
 ) AS date_rank FROM facts
)
SELECT metric_code, org_code, metric_value, stat_date, metric_increment
FROM selected WHERE date_rank = 1
ORDER BY metric_code, org_code
LIMIT :limit
