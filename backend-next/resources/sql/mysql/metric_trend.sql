SELECT mv.metric_code, COALESCE(mt.metric_name, mv.metric_name) AS metric_name,
       mt.unit, mv.org_name, mv.metric_value, mv.stat_date
FROM metric_values AS mv
LEFT JOIN metric_terms AS mt ON mt.metric_code = mv.metric_code
WHERE mv.metric_code IN :metric_codes
  AND (:filter_orgs = FALSE OR mv.org_code IN :org_codes)
  AND mv.stat_date BETWEEN CAST(:start_date AS DATE) AND CAST(:end_date AS DATE)
ORDER BY mv.stat_date, mv.metric_code, mv.org_name
LIMIT :limit
