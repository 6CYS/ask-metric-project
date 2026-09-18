WITH available AS (
    SELECT DISTINCT f.{{fact_metric_code_field}} AS metric_code
    FROM {{fact_table}} f
    WHERE f.{{fact_org_code_field}} IN :org_codes AND f.{{fact_metric_code_field}} IN :metric_codes
      AND f.{{fact_data_date_field}} IS NOT NULL
      AND (:start_date IS NULL OR f.{{fact_data_date_field}} >= CAST(:start_date AS DATE))
      AND (:end_date IS NULL OR f.{{fact_data_date_field}} <= CAST(:end_date AS DATE))
), stats AS (
    SELECT COUNT(*) AS metric_count FROM available
), ranked AS (
    SELECT metric_code, ROW_NUMBER() OVER (ORDER BY metric_code) AS rn FROM available
)
SELECT s.metric_count, r.metric_code
FROM stats s LEFT JOIN ranked r ON r.rn > :offset AND r.rn <= :page_end
ORDER BY r.metric_code
