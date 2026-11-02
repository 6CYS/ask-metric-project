import os
import re
import unittest
from unittest.mock import patch

from pydantic import ValidationError
from sqlglot import exp, parse_one

from ask_metric.core.config import Settings
from ask_metric.domain.query_execution import (
    QueryExecutionPlan,
    QueryPlanError,
    QueryTemplateId,
    SupportedQueryShape,
)
from ask_metric.infrastructure.query.sql_builder import SqlBuilder, sql_builder_from_settings


def plan_for(template, *, dialect="inceptor", shape=SupportedQueryShape.METRIC_VALUE):
    parameters = {
        "metric_codes": ["metric-a"],
        "org_codes": ["org-a"],
        "filter_orgs": True,
        "limit": 10,
        "stat_date": "2026-07-31",
        "stat_dates": ["2026-06-30", "2026-07-31"],
        "start_date": "2026-01-01",
        "end_date": "2026-07-31",
        "current_date": "2026-07-31",
        "base_date": "2026-06-30",
        "period_starts": ["2026-07-01"],
        "period_ends": ["2026-07-31"],
        "period_count": 1,
        "ordinal_metric_codes": [None],
        "filter_dates": True,
        "grain": "month",
        "selection": "all",
        "offset": 0,
        "page_end": 10,
        "filter_metrics": True,
        "require_all": False,
        "combination_count": 1,
        "rank_subject_codes": ["org-a"],
    }
    for index in range(12):
        parameters[f"period_start_{index}"] = "2026-07-01"
        parameters[f"period_end_{index}"] = "2026-07-31"
    return QueryExecutionPlan(
        shape=shape, template=template, dialect=dialect, dsl={}, parameters=parameters
    )


def settings_for(**overrides):
    values = {
        "sit_org_corporation_code_max": "134",
        "sit_org_excluded_corporation_code": "086",
        "sit_org_head_office_corporation_code": "000",
        "sit_org_legal_entity_hier_code": "3",
        "sit_org_head_office_hier_code": "1",
        "sit_org_expected_count": 61,
    }
    with patch.dict(os.environ, {}, clear=True):
        return Settings(_env_file=None, **(values | overrides))


class SitMySqlSqlTests(unittest.TestCase):
    def test_settings_enable_mysql_source_sql_without_switching_to_metric_values(self):
        settings = settings_for(query_database_dialect="inceptor", sit_sql_dialect="mysql")
        sql = sql_builder_from_settings(settings).build(
            plan_for(QueryTemplateId.METRIC_AVAILABILITY)
        )
        self.assertIn("CAST(stat_date AS CHAR)", sql)
        self.assertNotIn(" AS STRING)", sql)
        self.assertIn("ads_lake.adm_rmt_pub_gnrl_drv_indcr_tab", sql)
        self.assertNotIn("metric_values", sql)

    def test_default_inceptor_sql_keeps_hive_cast(self):
        sql = sql_builder_from_settings(settings_for(query_database_dialect="inceptor")).build(
            plan_for(QueryTemplateId.METRIC_AVAILABILITY)
        )
        self.assertIn("CAST(stat_date AS STRING)", sql)

    def test_mysql_metric_values_templates_ignore_sit_rendering_option(self):
        settings = settings_for(query_database_dialect="mysql", sit_sql_dialect="hive")
        sql = sql_builder_from_settings(settings).build(
            plan_for(QueryTemplateId.METRIC_VALUE_EXACT, dialect="mysql")
        )
        self.assertIn("metric_values", sql)
        self.assertNotIn("ads_lake", sql)

    def test_unknown_sit_sql_dialect_is_rejected(self):
        with self.assertRaises(ValidationError):
            settings_for(sit_sql_dialect="postgres")

    def test_mysql_template_cannot_be_rendered_as_hive(self):
        with self.assertRaises(QueryPlanError):
            SqlBuilder("mysql", output_dialect="hive")

    def test_unknown_output_dialect_is_rejected(self):
        with self.assertRaises(QueryPlanError):
            SqlBuilder("inceptor", output_dialect="postgres")

    def test_every_source_scenario_renders_readonly_mysql_with_bound_parameters(self):
        builder = SqlBuilder("inceptor", output_dialect="mysql")
        for template in QueryTemplateId:
            with self.subTest(template=template):
                sql = builder.build(plan_for(template))
                parsed = parse_one(sql, read="mysql")
                self.assertIsInstance(parsed, exp.Select)
                self.assertIn(
                    "adm_rmt_pub_gnrl_drv_indcr_tab",
                    {t.name for t in parsed.find_all(exp.Table)},
                )
                self.assertIn(":org_codes", sql)
                self.assertIn(":metric_codes", sql)
                self.assertNotIn("org-a", sql)
                self.assertNotIn("metric-a", sql)
                self.assertNotIn(" AS STRING)", sql)
                self.assertNotIn("metric_values", sql)

    def test_source_normalization_retains_latest_batch_and_numeric_guard(self):
        sql = SqlBuilder("inceptor", output_dialect="mysql").build(
            plan_for(QueryTemplateId.METRIC_VALUE_EXACT)
        )
        self.assertIn("REGEXP_LIKE(TRIM(f.indcvl)", sql)
        self.assertIn("CAST(-999.999 AS DECIMAL(38, 10))", sql)
        self.assertIn("ORDER BY f.etl_date DESC, f.btch_seq_no DESC", sql)
        self.assertIn("version_rank = 1 AND NOT metric_value IS NULL", sql)
        self.assertIn("f.data_dt = CAST(:stat_date AS DATE)", sql)

    def test_multiple_periods_keep_all_bound_dates(self):
        sql = SqlBuilder("inceptor", output_dialect="mysql").build(
            plan_for(QueryTemplateId.METRIC_VALUE_AT_PERIODS)
        )
        names = set(re.findall(r":(period_(?:start|end)_\d+)\b", sql))
        self.assertEqual(
            names,
            {f"period_{bound}_{i}" for bound in ("start", "end") for i in range(12)},
        )
        self.assertIn(":period_count", sql)

    def test_rank_position_keeps_population_metadata_and_subject_binding(self):
        sql = SqlBuilder("inceptor", output_dialect="mysql").build(
            plan_for(
                QueryTemplateId.METRIC_RANKING_EXACT_DESC,
                shape=SupportedQueryShape.METRIC_RANK_POSITION,
            )
        )
        self.assertIsInstance(parse_one(sql, read="mysql"), exp.Union)
        self.assertIn("org_code IN :rank_subject_codes", sql)
        self.assertIn("1 AS rank_metadata", sql)
        self.assertIn("rank_data_conflict", sql)


if __name__ == "__main__":
    unittest.main()
