WITH pairs AS (
    SELECT DISTINCT metric_code AS metric_code, org_code AS org_code, stat_date AS stat_date
    FROM metric_values
    WHERE org_code IN :org_codes
      AND (:filter_metrics = FALSE OR metric_code IN :metric_codes)
      AND stat_date IS NOT NULL
      AND (:start_date IS NULL OR stat_date >= CAST(:start_date AS DATE))
      AND (:end_date IS NULL OR stat_date <= CAST(:end_date AS DATE))
), dates AS (
    SELECT stat_date FROM pairs GROUP BY stat_date
    HAVING :require_all = FALSE OR COUNT(*) = :combination_count
), stats AS (
    SELECT COUNT(*) AS date_count, MIN(stat_date) AS earliest, MAX(stat_date) AS latest FROM dates
), ranked AS (
    SELECT stat_date, ROW_NUMBER() OVER (ORDER BY stat_date DESC) AS rn FROM dates
)
SELECT CASE WHEN :require_all = TRUE THEN 'common' ELSE 'any' END AS scope,
       '' AS org_code, '' AS metric_code, s.date_count, s.earliest, s.latest, r.stat_date
FROM stats s LEFT JOIN ranked r ON r.rn > :offset AND r.rn <= :page_end
ORDER BY r.stat_date DESC
