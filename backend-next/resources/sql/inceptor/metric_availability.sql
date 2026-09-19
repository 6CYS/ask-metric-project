WITH normalized AS (
  SELECT
    f.{{fact_metric_code_field}} AS metric_code,
    f.{{fact_org_code_field}} AS org_code,
    f.{{fact_data_date_field}} AS stat_date,
    CASE
      WHEN TRIM(f.{{fact_value_field}}) RLIKE '^[+-]?[0-9]+([.][0-9]+)?$'
      AND CAST(TRIM(f.{{fact_value_field}}) AS DECIMAL(38, 10)) <> CAST(-999.999 AS DECIMAL(38, 10))
      THEN CAST(TRIM(f.{{fact_value_field}}) AS DECIMAL(38, 10))
      ELSE NULL
    END AS metric_value,
    CASE
      WHEN NOT f.{{fact_increment_field}} IS NULL
      AND CAST(f.{{fact_increment_field}} AS DECIMAL(38, 10)) <> CAST(-999.999 AS DECIMAL(38, 10))
      THEN CAST(f.{{fact_increment_field}} AS DECIMAL(38, 10))
      ELSE NULL
    END AS metric_increment,
    ROW_NUMBER() OVER (
      PARTITION BY f.{{fact_org_code_field}}, f.{{fact_metric_code_field}}, f.{{fact_data_date_field}}
      ORDER BY {{batch_order}}
    ) AS version_rank
  FROM {{fact_table}} AS f
  WHERE
    f.{{fact_metric_code_field}} IN :metric_codes
    AND (
      :filter_orgs = FALSE OR f.{{fact_org_code_field}} IN :org_codes
    )
    AND (
      :filter_dates = FALSE
      OR f.{{fact_data_date_field}} BETWEEN CAST(:start_date AS DATE) AND CAST(:end_date AS DATE)
    )
), facts AS (
  SELECT
    metric_code,
    org_code,
    stat_date,
    metric_value,
    metric_increment
  FROM normalized
  WHERE
    version_rank = 1 AND NOT metric_value IS NULL
), available_periods AS (
  SELECT
    metric_code,
    org_code,
    CASE
      WHEN :grain = 'month'
      THEN SUBSTRING(CAST(stat_date AS STRING), 1, 7)
      ELSE SUBSTRING(CAST(stat_date AS STRING), 1, 10)
    END AS available_period,
    MIN(stat_date) AS first_date,
    MAX(stat_date) AS last_date
  FROM facts
  GROUP BY
    metric_code,
    org_code,
    CASE
      WHEN :grain = 'month'
      THEN SUBSTRING(CAST(stat_date AS STRING), 1, 7)
      ELSE SUBSTRING(CAST(stat_date AS STRING), 1, 10)
    END
), availability_bounds AS (
  SELECT
    *,
    MIN(available_period) OVER (PARTITION BY metric_code, org_code) AS earliest_period,
    MAX(available_period) OVER (PARTITION BY metric_code, org_code) AS latest_period
  FROM available_periods
)
SELECT
  metric_code,
  org_code,
  available_period,
  first_date,
  last_date
FROM availability_bounds
WHERE
  :selection = 'all'
  OR (
    :selection = 'earliest' AND available_period = earliest_period
  )
  OR (
    :selection = 'latest' AND available_period = latest_period
  )
ORDER BY
  metric_code,
  org_code,
  available_period
LIMIT :limit
