WITH requested_periods AS (
    SELECT periods.period_start, periods.period_end
    FROM JSON_TABLE(
        :periods_json,
        '$[*]' COLUMNS (
            period_start DATE PATH '$.start',
            period_end DATE PATH '$.end'
        )
    ) AS periods
),
ranked_values AS (
    SELECT mv.metric_code, mv.metric_name, mv.org_name, mv.metric_value, mv.stat_date,
           ROW_NUMBER() OVER (
               PARTITION BY periods.period_start, periods.period_end,
                            mv.metric_code, mv.org_name
               ORDER BY mv.stat_date DESC
           ) AS row_number
    FROM requested_periods AS periods
    JOIN metric_values AS mv
      ON mv.stat_date >= periods.period_start
     AND mv.stat_date <= periods.period_end
    WHERE mv.metric_code IN :metric_codes
      AND (:filter_orgs = FALSE OR mv.org_name IN :org_names)
),
selected_values AS (
    SELECT DISTINCT metric_code, metric_name, org_name, metric_value, stat_date
    FROM ranked_values
    WHERE row_number = 1
)
SELECT selected.metric_code,
       COALESCE(mt.metric_name, selected.metric_name) AS metric_name,
       mt.unit, selected.org_name, selected.metric_value, selected.stat_date
FROM selected_values AS selected
LEFT JOIN metric_terms AS mt ON mt.metric_code = selected.metric_code
ORDER BY selected.stat_date, selected.metric_code, selected.org_name
LIMIT :limit
