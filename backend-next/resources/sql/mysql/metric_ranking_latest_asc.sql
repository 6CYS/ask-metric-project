WITH target_dates AS (
    SELECT metric_code, MAX(stat_date) AS stat_date
    FROM metric_values
    WHERE metric_code IN :metric_codes
      AND (:filter_orgs = FALSE OR org_code IN :org_codes)
    GROUP BY metric_code
),
ranked_values AS (
    SELECT mv.metric_code, COALESCE(mt.metric_name, mv.metric_name) AS metric_name,
           mt.unit, mv.org_name, mv.metric_value, mv.stat_date,
           ROW_NUMBER() OVER (
               PARTITION BY mv.metric_code ORDER BY mv.metric_value ASC, mv.org_name
           ) AS `rank`
    FROM metric_values AS mv
    LEFT JOIN metric_terms AS mt ON mt.metric_code = mv.metric_code
    JOIN target_dates AS td
      ON td.metric_code = mv.metric_code AND td.stat_date = mv.stat_date
    WHERE (:filter_orgs = FALSE OR mv.org_code IN :org_codes)
)
SELECT metric_code, metric_name, unit, org_name, metric_value, stat_date, `rank`
FROM ranked_values
WHERE `rank` <= :limit
ORDER BY metric_code, `rank`
