WITH available_periods AS (
  SELECT
    metric_code,
    org_code,
    CASE
      WHEN :grain = 'month'
      THEN DATE_FORMAT(stat_date, '%Y-%m')
      ELSE DATE_FORMAT(stat_date, '%Y-%m-%d')
    END AS available_period,
    MIN(stat_date) AS first_date,
    MAX(stat_date) AS last_date
  FROM metric_values
  WHERE
    metric_code IN :metric_codes
    AND (
      :filter_orgs = FALSE OR org_code IN :org_codes
    )
    AND NOT metric_value IS NULL
    AND (
      :filter_dates = FALSE
      OR stat_date BETWEEN CAST(:start_date AS DATE) AND CAST(:end_date AS DATE)
    )
  GROUP BY
    metric_code,
    org_code,
    CASE
      WHEN :grain = 'month'
      THEN DATE_FORMAT(stat_date, '%Y-%m')
      ELSE DATE_FORMAT(stat_date, '%Y-%m-%d')
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
