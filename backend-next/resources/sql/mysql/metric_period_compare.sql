WITH requested_periods AS (
    SELECT CAST(:current_date AS DATE) AS stat_date, 'current' AS period
    UNION ALL
    SELECT CAST(:base_date AS DATE) AS stat_date, 'base' AS period
)
SELECT mv.metric_code, COALESCE(mt.metric_name, mv.metric_name) AS metric_name,
       mt.unit, mv.org_name, mv.metric_value, mv.stat_date, periods.period
FROM requested_periods AS periods
LEFT JOIN metric_values AS mv
  ON mv.stat_date = periods.stat_date
 AND mv.metric_code IN :metric_codes
 AND (:filter_orgs = FALSE OR mv.org_code IN :org_codes)
LEFT JOIN metric_terms AS mt ON mt.metric_code = mv.metric_code
WHERE mv.metric_code IS NOT NULL
ORDER BY mv.metric_code, mv.org_name, periods.period
LIMIT :limit
