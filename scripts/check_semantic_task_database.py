"""显式 --live 只读诊断当前配置数据库；覆盖目录、日历、来源、planner、SQL层。

不启动服务、不伪造登录身份、不更改账号/目录/业务数据；HTTP鉴权及浏览器不在本脚本验收范围。
报告只保留目录名称、状态、行数与日期，不保留业务数值或连接凭据。
"""
import argparse
import json
import sys
from datetime import date
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'backend-next/src'))
from ask_metric.core.config import get_settings
from ask_metric.infrastructure.db.unit_of_work import SqlAlchemyUnitOfWork
from ask_metric.infrastructure.db.session import get_query_engine
from ask_metric.application.field_resolution import resolve_catalog_field, resolve_date_field, source_organization_codes
from ask_metric.application.metric_candidates import MetricCandidateIndex
from ask_metric.application.goal_facts import inspect_goal
from ask_metric.application.analysis_selection import issue_selection, verify_selection
from ask_metric.api.routes.tasks import _verify_metric_coverage, SourceMetricBinding
from ask_metric.domain.basic_query import BasicQuerySpec
from ask_metric.domain.query_execution import QueryPlanner
from ask_metric.infrastructure.query.sql_builder import sql_builder_from_settings
from ask_metric.infrastructure.query.factory import create_data_source_adapter


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--live', action='store_true')
    parser.add_argument('--phase3', action='store_true')
    parser.add_argument('--report', type=Path, required=True)
    args = parser.parse_args()
    if not args.live:
        parser.error('必须使用 --live 明确连接当前项目数据库')
    result = {'environment': 'configured_project_database_readonly_contract_and_SQL', 'real_database': True,
              'model_called': False, 'http_authentication_verified': False, 'browser_verified': False, 'cases': []}
    try:
        settings = get_settings()
        with SqlAlchemyUnitOfWork() as uow:
            metrics = uow.metric_catalog.list_enabled()
            organizations = uow.organization_catalog.list_enabled()
        result['catalog_counts'] = {'metrics': len(metrics), 'organizations': len(organizations)}
        index = MetricCandidateIndex(metrics)
        question = '查询张家港农商行近5年的存款记录'
        org = resolve_catalog_field('organization', ['张家港农商行'], organizations)
        dates = [resolve_date_field('近5年', date(2026, 10, 14)) for _ in range(3)]
        assert dates[0] == dates[1] == dates[2] and dates[0]['status'] == 'ambiguous'
        assert org['status'] == 'resolved'
        result['cases'].append({'name': 'original_question_calendar_and_catalog', 'passed': True,
            'organization_status': org['status'], 'calendar_status': dates[0]['status'],
            'calendar_choices': [item['metadata']['calendar'] for item in dates[0]['candidates']],
            'metric_resolution_statuses': [item['resolution']['status'] for item in index.mentions(question)]})
        # 精确验收指标来自启用目录；本步骤为SQL契约诊断，不把泛“存款记录”自动改成这个指标。
        metric = next(item for item in metrics if '存款' in item.name and item.value_basis == '当日数')
        org_code, org_name = org['value']['codes'][0], org['value']['names'][0]
        source = f'查询{org_name}最近5个完整年度的{metric.name}全部数据'
        assert source_organization_codes(source, organizations) == [org_code]
        mentions = index.mentions(source)
        bindings = [SourceMetricBinding(start=item['start'], end=item['end'], text=item['text'], codes=item['resolution']['value']['codes']) for item in mentions]
        _verify_metric_coverage(source, [metric.code], metrics, bindings, [])
        calendar = dates[0]['candidates'][1]['metadata']['calendar']
        spec = BasicQuerySpec(metric_codes=[metric.code], org_codes=[org_code], time=calendar, selection='all_in_range')
        plan = QueryPlanner(dialect=settings.query_database_dialect, max_limit=1000).build(spec.to_logical_dsl(), spec.query_shape,
            org_names=[org_code], display_org_names=[org_name], display_metric_names=[metric.name])
        sql = sql_builder_from_settings(settings).build(plan)
        adapter = create_data_source_adapter(settings.query_database_dialect, get_query_engine(), statement_timeout_ms=30000)
        executed = adapter.execute_readonly(sql=sql, parameters=plan.parameters)
        result['cases'].append({'name': 'explicit_catalog_calendar_source_readonly_SQL', 'passed': True,
            'organization_name': org_name, 'metric_name': metric.name, 'calendar': calendar, 'selection': spec.selection,
            'row_count': len(executed.rows), 'latency_ms': executed.latency_ms,
            'returned_dates': sorted({str(row.get('stat_date')) for row in executed.rows if row.get('stat_date')})})
        if args.phase3:
            selected_orgs = organizations[:2]
            days = ['2026-05-31', '2026-06-30']
            bound_goal = '；'.join(f'查询{item.name}{day}的{metric.name}' for item, day in zip(selected_orgs, days))
            facts = inspect_goal(bound_goal, date(2026, 10, 14), metrics, organizations)
            assert len(facts['fragments']) == len(selected_orgs)
            cases = []
            for position, (organization, day) in enumerate(zip(selected_orgs, days)):
                fragment = facts['fragments'][position]
                assert fragment['organizations'] == [organization.code]
                assert fragment['calendar']['ranges'] == [{'start': day, 'end': day}]
                assert {code for mention in fragment['mentions'] for code in mention['resolution']['value']['codes']} == {metric.code}
                query = BasicQuerySpec(metric_codes=[metric.code], org_codes=[organization.code], time={'start': day, 'end': day}, selection='exact')
                scope = query.model_dump(mode='json', exclude_none=True)
                token = issue_selection(owner='readonly-contract', conversation='readonly-contract', session='readonly-contract', goal=bound_goal,
                    codes=query.metric_codes, scope=scope, catalog=metrics, secret=settings.jwt_secret)
                verify_selection(token, owner='readonly-contract', conversation='readonly-contract', codes=query.metric_codes, scope=scope, catalog=metrics, secret=settings.jwt_secret)
                planned = QueryPlanner(dialect=settings.query_database_dialect, max_limit=100).build(query.to_logical_dsl(), query.query_shape,
                    org_names=[organization.code], display_org_names=[organization.name], display_metric_names=[metric.name])
                statement = sql_builder_from_settings(settings).build(planned)
                rows = adapter.execute_readonly(sql=statement, parameters=planned.parameters)
                cases.append({'organization': organization.name, 'date': day, 'row_count': len(rows.rows), 'latency_ms': rows.latency_ms})
            result['cases'].append({'name': 'phase3_bound_goal_receipt_and_readonly_SQL', 'passed': True, 'targets': cases,
                'note': '只验证当前目录、日历、来源回执与SQL。真实HTTP身份和会话归属未在此脚本验证。'})
    except Exception as error:
        result['failure_type'] = type(error).__name__
        result['failure_code'] = getattr(error, 'code', None)
    finally:
        result['passed'] = 'failure_type' not in result
        args.report.parent.mkdir(parents=True, exist_ok=True)
        args.report.write_text(json.dumps(result, ensure_ascii=False, indent=2))
        print(json.dumps({'passed': result['passed'], 'cases': len(result['cases']), 'failure_type': result.get('failure_type')}, ensure_ascii=False))
    return 0 if result['passed'] else 1


if __name__ == '__main__':
    raise SystemExit(main())
