WITH available AS (
    SELECT DISTINCT metric_code AS metric_code
    FROM metric_values
    WHERE org_code IN :org_codes AND metric_code IN :metric_codes
      AND stat_date IS NOT NULL
      AND (:start_date IS NULL OR stat_date >= CAST(:start_date AS DATE))
      AND (:end_date IS NULL OR stat_date <= CAST(:end_date AS DATE))
), stats AS (
    SELECT COUNT(*) AS metric_count FROM available
), ranked AS (
    SELECT metric_code, ROW_NUMBER() OVER (ORDER BY metric_code) AS rn FROM available
)
SELECT s.metric_count, r.metric_code
FROM stats s LEFT JOIN ranked r ON r.rn > :offset AND r.rn <= :page_end
ORDER BY r.metric_code
