from fastapi import Request

from ask_metric.core.errors import ApplicationError


def require_query_ready(request: Request) -> None:
    state = request.app.state.query_initialization.snapshot()
    if state["status"] != "ready":
        code = ("QUERY_INITIALIZING" if state["status"] == "initializing"
                else "QUERY_INITIALIZATION_FAILED")
        raise ApplicationError(
            code, state["message"], status_code=503,
        )
