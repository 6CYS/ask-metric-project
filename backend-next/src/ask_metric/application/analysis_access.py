"""Revalidate all organization scopes in stored analysis before exposing it."""

from ask_metric.application.ports import PermissionDeniedError
from ask_metric.domain.analysis import AnalysisTarget


def authorize_analysis(raw, actor, permission_service):
    target = raw.get("analysis_target")
    if not target:
        return
    target = AnalysisTarget.model_validate(target)
    scopes = {(target.metric_code, target.org_code)}

    def collect(value):
        if isinstance(value, dict):
            if value.get("metric_code") and value.get("org_code"):
                scopes.add((value["metric_code"], value["org_code"]))
            for child in value.values():
                collect(child)
        elif isinstance(value, list):
            for child in value:
                collect(child)

    collect(raw.get("analysis_tools", {}))
    for metric, org in scopes:
        dsl = target.model_copy(update={"metric_code": metric, "org_code": org}).dsl()
        authorized = permission_service.authorize_logical_dsl(actor=actor, logical_dsl=dsl)
        if authorized.get("orgs") != dsl["orgs"]:
            raise PermissionDeniedError("分析证据机构范围已变化")
