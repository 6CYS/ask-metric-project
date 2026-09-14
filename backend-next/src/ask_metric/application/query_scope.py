"""旧跨任务草稿只读兼容；历史结果读取不调用此执行边界。"""

from typing import Any

from ask_metric.core.errors import ApplicationError


def require_current_query_scope(raw: dict[str, Any]) -> None:
    """升级后不恢复旧追问候选，避免历史状态绕过当前独立问数入口。"""
    debug = raw.get("debug") or {}
    shadow = debug.get("multiturn_shadow") or {}
    clarification = raw.get("clarification") or {}
    route = debug.get("execution_route") or {}
    retired_act = shadow.get("conversation_act") in {
        "FOLLOW_UP", "REFERENCE_ACTION", "CLARIFICATION_ANSWER",
    }
    retired_route = route.get("selected_pipeline") in {
        "MULTITURN_CONTEXT", "MULTITURN_CLARIFICATION", "LEGACY_GRAY_MULTITURN_OVERRIDE",
    }
    if (
        raw.get("multiturn_execution")
        or retired_act
        or retired_route
        or clarification.get("type") in {"multiturn_context", "result_reference"}
        or debug.get("context_clarification_pending")
    ):
        raise ApplicationError(
            "CROSS_TASK_CONTEXT_RETIRED",
            "跨任务追问已停用，此记录仅供查看。请新建问题并补充指标、机构和日期。",
            status_code=409,
        )
