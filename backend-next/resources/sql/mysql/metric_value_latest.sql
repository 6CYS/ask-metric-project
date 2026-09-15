SELECT ranked.metric_code,
       COALESCE(mt.metric_name, ranked.metric_name) AS metric_name,
       mt.unit, ranked.org_name, ranked.metric_value, ranked.stat_date
FROM (
    SELECT metric_code, metric_name, org_name, metric_value, stat_date,
           ROW_NUMBER() OVER (
               PARTITION BY metric_code, org_name ORDER BY stat_date DESC
           ) AS row_number
    FROM metric_values
    WHERE metric_code IN :metric_codes
      AND (:filter_orgs = FALSE OR org_code IN :org_codes)
) AS ranked
LEFT JOIN metric_terms AS mt ON mt.metric_code = ranked.metric_code
WHERE ranked.row_number = 1
ORDER BY ranked.metric_code, ranked.org_name
LIMIT :limit
