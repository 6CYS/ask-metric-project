from fastapi import Request

from ask_metric.core.errors import ApplicationError


def require_query_ready(request: Request) -> None:
    """服务端就绪门禁：即使绕过前端按钮，也不能在预热未完成时发起问数。"""
    state = request.app.state.query_initialization.snapshot()
    if state["status"] != "ready":
        code = ("QUERY_INITIALIZING" if state["status"] == "initializing"
                else "QUERY_INITIALIZATION_FAILED")
        raise ApplicationError(
            code, state["message"], status_code=503,
        )
