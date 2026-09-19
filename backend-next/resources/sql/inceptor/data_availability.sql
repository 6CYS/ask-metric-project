WITH pairs AS (
    SELECT DISTINCT f.{{fact_metric_code_field}} AS metric_code, f.{{fact_org_code_field}} AS org_code, f.{{fact_data_date_field}} AS stat_date
    FROM {{fact_table}} f
    WHERE f.{{fact_org_code_field}} IN :org_codes
      AND (:filter_metrics = FALSE OR f.{{fact_metric_code_field}} IN :metric_codes)
      AND f.{{fact_data_date_field}} IS NOT NULL
      AND (:start_date IS NULL OR f.{{fact_data_date_field}} >= CAST(:start_date AS DATE))
      AND (:end_date IS NULL OR f.{{fact_data_date_field}} <= CAST(:end_date AS DATE))
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
