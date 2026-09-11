WITH target_dates AS (
    SELECT metric_code, MAX(stat_date) AS stat_date
    FROM metric_values
    WHERE metric_code IN :metric_codes
      AND (:filter_orgs = FALSE OR org_name IN :org_names)
      AND stat_date <= CAST(:end_date AS DATE)
    GROUP BY metric_code
)
SELECT mv.metric_code, COALESCE(mt.metric_name, mv.metric_name) AS metric_name,
       mt.unit, mv.org_name, mv.metric_value, mv.stat_date
FROM metric_values AS mv
LEFT JOIN metric_terms AS mt ON mt.metric_code = mv.metric_code
JOIN target_dates AS td
  ON td.metric_code = mv.metric_code AND td.stat_date = mv.stat_date
WHERE (:filter_orgs = FALSE OR mv.org_name IN :org_names)
ORDER BY mv.metric_code, mv.org_name
LIMIT :limit
