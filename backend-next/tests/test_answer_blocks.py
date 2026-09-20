"""回答正文结构化块（answer_blocks）契约测试。

覆盖：各模板并行产出 blocks 且 message 逐字符不变；关键数值片段 bold；
period/entity 对比表头与对齐；异常行降级段落；flatten_blocks 拍平一致性；
QueryExecutionResult/TaskResultPage 透传与旧快照 None 兼容。
"""

from datetime import UTC, datetime
from typing import Any

from ask_metric.application.requests import ActorContext
from ask_metric.application.result_answering import (
    _format_value,
    flatten_blocks,
    render_fact_answer,
)
from ask_metric.application.task_results import TaskResultPage
from ask_metric.application.task_service import QueryTaskApplicationService
from ask_metric.domain.query_execution import (
    QueryExecutionPlan,
    QueryExecutionResult,
    QueryTemplateId,
    SupportedQueryShape,
)
from ask_metric.domain.task import QueryTaskState
from ask_metric.infrastructure.db.models import QueryTask

ACTOR = ActorContext(
    subject="user-1", user_id="user-1", authentication_method="test", trust_level="authenticated"
)


def _plan(
    shape: SupportedQueryShape,
    template: QueryTemplateId,
    *,
    parameters: dict[str, Any] | None = None,
) -> QueryExecutionPlan:
    return QueryExecutionPlan(
        shape=shape,
        template=template,
        dialect="mysql",
        dsl={},
        parameters=parameters or {},
    )


def _block_texts(block: dict[str, Any]) -> str:
    if block["type"] == "paragraph":
        return "".join(segment["text"] for segment in block["segments"])
    if block["type"] == "list":
        return "\n".join(
            "".join(segment["text"] for segment in item) for item in block["items"]
        )
    raise AssertionError(f"unexpected block type {block['type']}")


class TestStandardFactsBlocks:
    def test_single_metric_value_message_unchanged_and_bold_value(self) -> None:
        plan = _plan(SupportedQueryShape.METRIC_VALUE, QueryTemplateId.METRIC_VALUE_EXACT)
        rows = [{
            "stat_date": "2025-03-31",
            "org_name": "无锡分行",
            "metric_name": "存款日均",
            "metric_value": "12345.6",
            "unit": "",
        }]
        rendered = render_fact_answer(plan, rows, [])
        value_text = _format_value("12345.6", "", "存款日均")
        assert rendered.template_id == "single_metric_value"
        assert rendered.message == f"2025年03月31日，无锡分行存款日均为{value_text}。"
        assert len(rendered.blocks) == 1
        block = rendered.blocks[0]
        assert block["type"] == "paragraph"
        bold_texts = [s["text"] for s in block["segments"] if s["bold"]]
        assert bold_texts == [value_text]
        assert flatten_blocks(rendered.blocks) == rendered.message

    def test_multi_dimension_result_groups_paragraphs_by_date(self) -> None:
        plan = _plan(SupportedQueryShape.METRIC_VALUE, QueryTemplateId.METRIC_VALUE_AT_DATES)
        rows = [
            {"stat_date": "2025-03-31", "org_name": "甲行", "metric_name": "存款余额",
             "metric_value": "100", "unit": ""},
            {"stat_date": "2025-03-31", "org_name": "乙行", "metric_name": "存款余额",
             "metric_value": "200", "unit": ""},
            {"stat_date": "2025-04-30", "org_name": "甲行", "metric_name": "存款余额",
             "metric_value": "300", "unit": ""},
        ]
        rendered = render_fact_answer(plan, rows, [])
        assert rendered.template_id == "multi_dimension_result"
        assert rendered.message == (
            "2025年03月31日：甲行存款余额为100；乙行存款余额为200。"
            "2025年04月30日：甲行存款余额为300。"
        )
        assert [block["type"] for block in rendered.blocks] == ["paragraph", "paragraph"]
        first = rendered.blocks[0]
        bold_texts = [s["text"] for s in first["segments"] if s["bold"]]
        assert bold_texts == ["100", "200"]
        assert flatten_blocks(rendered.blocks) == "\n".join(
            _block_texts(block) for block in rendered.blocks
        )
        for token in ("甲行", "乙行", "100", "200", "300", "2025年03月31日", "2025年04月30日"):
            assert token in flatten_blocks(rendered.blocks)
            assert token in rendered.message

    def test_ranking_marks_rank_and_value_bold(self) -> None:
        plan = _plan(
            SupportedQueryShape.METRIC_RANKING, QueryTemplateId.METRIC_RANKING_EXACT_DESC
        )
        rows = [
            {"stat_date": "2025-03-31", "org_name": "甲行", "metric_name": "存款余额",
             "metric_value": "300", "unit": "", "rank": 1},
            {"stat_date": "2025-03-31", "org_name": "乙行", "metric_name": "存款余额",
             "metric_value": "200", "unit": "", "rank": 2},
        ]
        rendered = render_fact_answer(plan, rows, [])
        assert rendered.template_id == "ranking_top_n"
        assert rendered.message == (
            "2025年03月31日：第1名甲行存款余额为300；第2名乙行存款余额为200。"
        )
        block = rendered.blocks[0]
        bold_texts = [s["text"] for s in block["segments"] if s["bold"]]
        assert bold_texts == ["第1名", "300", "第2名", "200"]


class TestAvailabilityBlocks:
    def test_groups_become_list_items(self) -> None:
        plan = _plan(
            SupportedQueryShape.METRIC_AVAILABILITY,
            QueryTemplateId.METRIC_AVAILABILITY,
            parameters={"selection": "all"},
        )
        rows = [
            {"org_name": "甲行", "metric_name": "存款余额", "available_period": "2025-03"},
            {"org_name": "甲行", "metric_name": "存款余额", "available_period": "2025-04"},
            {"org_name": "乙行", "metric_name": "贷款余额", "available_period": "2025-04"},
        ]
        rendered = render_fact_answer(plan, rows, [])
        assert rendered.template_id == "metric_availability"
        assert rendered.message == (
            "甲行的存款余额有数据的期间：2025-03、2025-04。\n"
            "乙行的贷款余额有数据的期间：2025-04。"
        )
        assert len(rendered.blocks) == 1
        block = rendered.blocks[0]
        assert block["type"] == "list"
        assert block["ordered"] is False
        assert len(block["items"]) == 2
        first_item_text = "".join(s["text"] for s in block["items"][0])
        assert first_item_text == "甲行的存款余额有数据的期间：2025-03、2025-04。"
        assert [s["text"] for s in block["items"][0] if s["bold"]] == ["2025-03、2025-04"]
        assert flatten_blocks(rendered.blocks) == rendered.message

    def test_empty_groups_fall_back_to_paragraph(self) -> None:
        plan = _plan(
            SupportedQueryShape.METRIC_AVAILABILITY,
            QueryTemplateId.METRIC_AVAILABILITY,
            parameters={"selection": "all"},
        )
        rendered = render_fact_answer(plan, [], [])
        # availability 无分组时降级为单段落块
        assert rendered.template_id == "metric_availability"
        assert rendered.message == "查询完成，暂无匹配的有值日期。"
        assert rendered.blocks == [{
            "type": "paragraph",
            "segments": [{"text": "查询完成，暂无匹配的有值日期。", "bold": False}],
        }]


class TestPeriodComparisonBlocks:
    def _plan(self) -> QueryExecutionPlan:
        return _plan(
            SupportedQueryShape.METRIC_PERIOD_COMPARE, QueryTemplateId.METRIC_PERIOD_COMPARE
        )

    def test_normal_rows_render_table(self) -> None:
        rows = [{
            "org_name": "甲行", "metric_name": "存款余额", "unit": "",
            "current_date": "2025-04-30", "base_date": "2025-03-31",
            "current_value": "120", "base_value": "100",
            "difference": "20", "change_rate": "0.2", "status": "ok",
        }]
        rendered = render_fact_answer(self._plan(), rows, [])
        assert rendered.template_id == "period_comparison"
        assert rendered.message == (
            "甲行存款余额2025年04月30日为120，2025年03月31日为100，"
            "较基期增加20，变动率为20%。"
        )
        assert len(rendered.blocks) == 1
        table = rendered.blocks[0]
        assert table["type"] == "table"
        assert [cell[0]["text"] for cell in table["header"]] == [
            "机构指标", "期间", "数值", "对比基期", "差额", "变动率",
        ]
        assert table["aligns"] == ["left", "left", "right", "left", "right", "right"]
        row = table["rows"][0]
        assert [cell[0]["text"] for cell in row] == [
            "甲行存款余额", "2025年04月30日", "120", "2025年03月31日为100", "增加20", "20%",
        ]
        assert [cell[0]["bold"] for cell in row] == [False, False, True, False, True, True]
        flattened = flatten_blocks(rendered.blocks)
        for token in ("甲行存款余额", "120", "100", "20%", "2025年04月30日"):
            assert token in flattened
            assert token in rendered.message

    def test_abnormal_status_degrades_to_paragraph(self) -> None:
        rows = [
            {"org_name": "甲行", "metric_name": "存款余额", "unit": "",
             "current_date": "2025-04-30", "base_date": "2025-03-31",
             "current_value": None, "base_value": "100", "status": "current_missing"},
            {"org_name": "乙行", "metric_name": "贷款余额", "unit": "",
             "current_date": "2025-04-30", "base_date": "2025-03-31",
             "current_value": "50", "base_value": None, "status": "base_missing"},
            {"org_name": "丙行", "metric_name": "客户数", "unit": "户",
             "current_date": "2025-04-30", "base_date": "2025-03-31",
             "current_value": "10", "base_value": "0", "difference": "10",
             "status": "base_zero"},
        ]
        rendered = render_fact_answer(self._plan(), rows, [])
        assert rendered.message == (
            "甲行存款余额未查询到2025年04月30日数据；"
            "乙行贷款余额2025年04月30日为50，未查询到2025年03月31日数据；"
            "丙行客户数2025年04月30日为10户，2025年03月31日为0户，"
            "差额为10户，因基期值为0无法计算变动率。"
        )
        assert [block["type"] for block in rendered.blocks] == [
            "paragraph", "paragraph", "paragraph",
        ]
        for block, expected in zip(
            rendered.blocks, rendered.message.rstrip("。").split("；"), strict=True
        ):
            assert block["segments"] == [{"text": expected, "bold": False}]

    def test_mixed_rows_table_then_degraded(self) -> None:
        rows = [
            {"org_name": "甲行", "metric_name": "存款余额", "unit": "",
             "current_date": "2025-04-30", "base_date": "2025-03-31",
             "current_value": "120", "base_value": "100",
             "difference": "20", "change_rate": "0.2", "status": "ok"},
            {"org_name": "乙行", "metric_name": "贷款余额", "unit": "",
             "current_date": "2025-04-30", "base_date": "2025-03-31",
             "current_value": "50", "base_value": None, "status": "base_missing"},
        ]
        rendered = render_fact_answer(self._plan(), rows, [])
        assert [block["type"] for block in rendered.blocks] == ["table", "paragraph"]
        assert len(rendered.blocks[0]["rows"]) == 1
        assert rendered.blocks[1]["segments"][0]["text"] == (
            "乙行贷款余额2025年04月30日为50，未查询到2025年03月31日数据"
        )


class TestEntityComparisonBlocks:
    def test_table_structure_and_message_unchanged(self) -> None:
        plan = _plan(
            SupportedQueryShape.METRIC_VALUE, QueryTemplateId.METRIC_VALUE_COMPARE_AS_OF
        )
        rows = [{"metric_code": "M1", "metric_name": "存款余额"}]
        comparisons = [{
            "metric_code": "M1", "stat_date": "2025-03-31", "unit": "",
            "left_org": "甲行", "right_org": "乙行",
            "left_value": "300", "right_value": "200",
            "difference": "100", "ratio": "1.5", "higher_org": "甲行",
        }]
        rendered = render_fact_answer(plan, rows, comparisons)
        assert rendered.template_id == "entity_comparison"
        assert rendered.message == (
            "2025年03月31日，甲行存款余额为300，乙行为200，"
            "差额为100，前者为后者的1.5倍，甲行较高。"
        )
        assert len(rendered.blocks) == 1
        table = rendered.blocks[0]
        assert table["type"] == "table"
        assert [cell[0]["text"] for cell in table["header"]] == [
            "日期", "指标", "机构", "数值", "对比机构", "对比数值", "差额", "倍数", "较高机构",
        ]
        assert table["aligns"] == [
            "left", "left", "left", "right", "left", "right", "right", "right", "left",
        ]
        row = table["rows"][0]
        assert [cell[0]["text"] for cell in row] == [
            "2025年03月31日", "存款余额", "甲行", "300", "乙行", "200", "100", "1.5倍", "甲行",
        ]
        flattened = flatten_blocks(rendered.blocks)
        for token in ("甲行", "乙行", "300", "200", "100", "1.5倍", "存款余额"):
            assert token in flattened
            assert token in rendered.message

    def test_missing_ratio_and_higher_org_leave_empty_cells(self) -> None:
        plan = _plan(
            SupportedQueryShape.METRIC_VALUE, QueryTemplateId.METRIC_VALUE_COMPARE_AS_OF
        )
        rows = [{"metric_code": "M1", "metric_name": "存款余额"}]
        comparisons = [{
            "metric_code": "M1", "stat_date": None, "unit": "",
            "left_org": "甲行", "right_org": "乙行",
            "left_value": "100", "right_value": "100", "difference": "0",
        }]
        rendered = render_fact_answer(plan, rows, comparisons)
        assert rendered.message == "甲行存款余额为100，乙行为100，差额为0。"
        row = rendered.blocks[0]["rows"][0]
        assert [cell[0]["text"] for cell in row] == [
            "", "存款余额", "甲行", "100", "乙行", "100", "0", "", "",
        ]


class TestSummaryBlocks:
    def test_no_data_single_paragraph(self) -> None:
        plan = _plan(SupportedQueryShape.METRIC_VALUE, QueryTemplateId.METRIC_VALUE_EXACT)
        rendered = render_fact_answer(plan, [], [])
        assert rendered.template_id == "no_data"
        assert rendered.message == "查询完成，暂无匹配数据。"
        assert rendered.blocks == [{
            "type": "paragraph",
            "segments": [{"text": "查询完成，暂无匹配数据。", "bold": False}],
        }]
        assert flatten_blocks(rendered.blocks) == rendered.message

    def test_large_result_summary_single_paragraph(self) -> None:
        plan = _plan(SupportedQueryShape.METRIC_VALUE, QueryTemplateId.METRIC_VALUE_IN_RANGE)
        rows = [
            {"stat_date": "2025-03-31", "org_name": f"机构{i}", "metric_name": "存款余额",
             "metric_value": str(i), "unit": ""}
            for i in range(21)
        ]
        rendered = render_fact_answer(plan, rows, [])
        assert rendered.template_id == "large_result_summary"
        assert rendered.message == "查询完成，共返回 21 行，具体结果请查看下方表格或下载明细。"
        assert rendered.blocks == [{
            "type": "paragraph",
            "segments": [{"text": rendered.message, "bold": False}],
        }]


class TestFlattenBlocks:
    def test_mixed_blocks(self) -> None:
        blocks = [
            {"type": "paragraph", "segments": [{"text": "提示", "bold": False}]},
            {"type": "list", "ordered": False, "items": [
                [{"text": "甲", "bold": False}, {"text": "1", "bold": True}],
                [{"text": "乙", "bold": False}],
            ]},
            {"type": "table",
             "header": [[{"text": "列", "bold": False}]],
             "rows": [[[{"text": "值", "bold": True}]]],
             "aligns": ["right"]},
        ]
        assert flatten_blocks(blocks) == "提示\n甲1\n乙\n列\n值"


def _succeeded_task_with_blocks(answer_blocks: Any, *, include_field: bool = True) -> QueryTask:
    result: dict[str, Any] = {
        "run_id": 7,
        "task_id": "task-1",
        "status": "succeeded",
        "query_shape": "metric_value",
        "columns": ["org_name", "metric_value"],
        "rows": [{"org_name": "甲行", "metric_value": "100"}],
        "comparisons": [],
        "row_count": 1,
        "truncated": False,
        "message": "2025年03月31日，甲行存款余额为100。",
        "task_version": 3,
        "task_status": "SUCCEEDED",
        "timings_ms": {},
        "evidence": {},
    }
    if include_field:
        result["answer_blocks"] = answer_blocks
    state = QueryTaskState()
    state.result_artifact = {
        "schema_version": 1,
        "result_id": "result:task-1",
        "task_id": "task-1",
        "conversation_id": "conv-1",
        "owner_user_id": "user-1",
        "source_run_id": 7,
        "operation": "QUERY",
        "created_at": datetime.now(UTC).isoformat(),
        "logical_dsl": {},
        "result": result,
    }
    return QueryTask(
        id="task-1",
        conversation_id="conv-1",
        original_question="查存款余额",
        status="SUCCEEDED",
        current_stage="RESULT_FORMATTING",
        version=3,
        state_json=state.model_dump(mode="json"),
    )


class _FakeTasks:
    def __init__(self, task: QueryTask) -> None:
        self.task = task

    def get_owned(self, task_id: str, user_id: str) -> QueryTask | None:
        if self.task.id != task_id or user_id != "user-1":
            return None
        return self.task


class _FakeUow:
    def __init__(self, task: QueryTask) -> None:
        self.tasks = _FakeTasks(task)

    def __enter__(self) -> "_FakeUow":
        return self

    def __exit__(self, *args: object) -> None:
        return None

    def commit(self) -> None:
        return None


class TestAnswerBlocksPassthrough:
    def test_query_execution_result_defaults_to_none(self) -> None:
        result = QueryExecutionResult(
            task_id="task-1", status="succeeded", query_shape="metric_value",
        )
        assert result.answer_blocks is None
        payload = result.model_dump(mode="json")
        assert payload["answer_blocks"] is None

    def test_result_page_passes_blocks_through(self) -> None:
        blocks = [{
            "type": "paragraph",
            "segments": [{"text": "2025年03月31日，甲行存款余额为100。", "bold": False}],
        }]
        task = _succeeded_task_with_blocks(blocks)
        uow = _FakeUow(task)
        service = QueryTaskApplicationService(uow_factory=lambda: uow)
        page = service.get_task_result("task-1", ACTOR)
        assert isinstance(page, TaskResultPage)
        assert page.answer_blocks == blocks

    def test_legacy_snapshot_without_blocks_reads_none(self) -> None:
        task = _succeeded_task_with_blocks(None, include_field=False)
        uow = _FakeUow(task)
        service = QueryTaskApplicationService(uow_factory=lambda: uow)
        page = service.get_task_result("task-1", ACTOR)
        assert page.answer_blocks is None
        result = QueryExecutionResult.model_validate(
            QueryTaskState.model_validate(task.state_json).result_artifact["result"]
        )
        assert result.answer_blocks is None
