"""离线解析本次 pi 原生记录，并用开发库只读 SQL 独立核对完整结果。"""
import argparse
import hashlib
import json
import re
import statistics
from decimal import Decimal
from pathlib import Path

from sqlalchemy import bindparam, create_engine, text
from sqlalchemy.engine import make_url
from ask_metric.core.config import get_settings

parser = argparse.ArgumentParser()
parser.add_argument('--reports', required=True)
parser.add_argument('--native', required=True)
parser.add_argument('--log', help='agent_tool_call 阶段日志，默认与 native 目录同级的 service.log')
args = parser.parse_args()
settings = get_settings()
assert settings.app_env in {'development', 'test'}
assert all(make_url(url).host in {'localhost','127.0.0.1','::1'} for url in [settings.app_database_url,settings.query_database_url])
app = create_engine(settings.app_database_url)
query = create_engine(settings.query_database_url)
cases={case['id']:case for case in json.loads((Path(__file__).parent/'cases.json').read_text())}
reports = []
log_path=Path(args.log) if args.log else Path(args.native).parent.parent/'service.log'
audit_stages={}
if log_path.exists():
    for line in log_path.read_text().splitlines():
        try:event=json.loads(line)
        except ValueError:continue
        if isinstance(event,dict) and event.get('event')=='agent_tool_call':
            audit_stages.setdefault(event['tool_call_id'],set()).add(event['stage'])

def digest(value):
    return hashlib.sha256(json.dumps(value,sort_keys=True,ensure_ascii=False,default=str).encode()).hexdigest()

def rows(path):
    result = []
    for line in path.read_text().splitlines():
        value = json.loads(line)
        result.extend(value if isinstance(value,list) else [value])
    return result

def logical_calls(calls):
    for call in calls:
        name, arguments = call['name'], call['arguments']
        if name == 'catalog' and arguments.get('action') == 'search':
            for query in arguments.get('queries', []):
                yield {**call, 'name': 'metric_catalog_search' if query.get('entity') == 'metric' else 'org_catalog_search', 'arguments': query}
        elif name == 'catalog' and arguments.get('action') == 'overview':
            yield {**call, 'name': 'metric_catalog_overview', 'arguments': {}}
        elif name == 'read':
            yield {**call, 'name': 'metric_read' if arguments.get('kind') in {'task', 'result'} else 'session_history_read'}
        else:
            yield call

with app.connect() as ac, query.connect() as qc:
    ac.execute(text('SET TRANSACTION READ ONLY'))
    qc.execute(text('SET TRANSACTION READ ONLY'))
    enabled_metrics=set(ac.execute(text('SELECT metric_code FROM metric_terms WHERE enabled=1')).scalars())
    for report_path in sorted(Path(args.reports).glob('[0-9][0-9].json')):
        report = json.loads(report_path.read_text())
        files = list(Path(args.native).rglob('*'+report.get('session_id','missing')+'.jsonl'))
        if not files:
            report['audit_error'] = '原生记录缺失'
            reports.append(report)
            continue
        records = rows(files[0])
        entries = {r['id']:r for r in records if r.get('kind') == 'entry'}
        actual = {}
        for record in records:
            state = record.get('value',{})
            if record.get('namespace') != 'pi.op.state' or not isinstance(state,dict) or state.get('at') != 'tools':
                continue
            batch = state['batch']
            assistant = entries.get(batch['assistantEntryId'],{}).get('message',{})
            for call in batch['calls']:
                block = assistant.get('content',[])[call['sourceIndex']]
                key = f"{record['key']}:{batch['turnId']}:{call['sourceIndex']}"
                actual[key] = block['id']
        executed = {actual[r['key']]:r['value'] for r in records if r.get('namespace') == 'pi.op.tool_args' and r.get('op')=='set' and r['key'] in actual}
        turns=[]
        for entry in entries.values():
            message=entry.get('message',{})
            if message.get('role')=='user':turns.append({'calls':[],'results':{},'model_calls':0,'tokens':0,'model_errors':[]})
            if not turns:continue
            current=turns[-1]
            if message.get('role')=='assistant':
                current['answer']=''.join(block.get('text','') for block in message.get('content',[]) if block['type']=='text')
                current['model_calls']+=1
                if message.get('errorMessage'):
                    error=message['errorMessage'].lower()
                    current['model_errors'].append('rate_limited' if '429' in error or 'rate' in error else 'timeout' if 'timeout' in error or 'timed out' in error else 'provider_error')
                current['tokens']+=message.get('usage',{}).get('totalTokens',0)
                for block in message.get('content',[]):
                    if block['type']=='toolCall':current['calls'].append(block)
            if message.get('role')=='toolResult':current['results'][message['toolCallId']]=message
        prior_task=None
        waiting_task=None
        for index, turn in enumerate(report['turns']):
            native=turns[index]
            expected=turn['expected']
            spec=cases[report['id']]['turns'][index]
            if spec['question']!=expected['question']:raise ValueError('案例问题发生变化，不能覆盖旧验收标准')
            expected={**expected,**spec}
            turn['expected']=expected
            if expected.get('page_size') and turn.get('request',{}).get('page_size')!=expected['page_size']:
                turn['errors'].append('覆盖每页数量错误');turn['passed']=False
            primary=[call for call in logical_calls(native['calls']) if call['name'] not in {'business_skill_read','org_catalog_search','metric_catalog_search','session_history_read','answer_evidence_check'}
                and not (call['name']=='metric_read' and call['arguments'].get('kind')=='task')]
            tool=expected.get('tool') or {'coverage':'data_availability','query':'metric_ask','read':'metric_read','clarify':'metric_ask','catalog':'metric_catalog_overview'}.get(expected['kind'])
            first=primary[0] if primary else None
            if expected['kind']=='search':
                first=next((c for c in logical_calls(native['calls']) if c['name'] not in {'business_skill_read','org_catalog_search','session_history_read','answer_evidence_check'}),None)
            correct=None if tool is None else bool(first and first['name']==tool)
            if correct and expected.get('action'):correct=first['arguments'].get('action')==expected['action']
            if expected['kind']=='unsupported' and '未明确说明能力边界' in turn['errors']:
                assistant_text=native.get('answer','')
                if re.search(r'不支持|(?:未|不|暂不)提供|无法.*(?:分析|预测)|不能.*(?:分析|预测)',assistant_text):
                    turn['errors'].remove('未明确说明能力边界')
                    turn['passed']=not turn['errors']
            turn['first_target_called']=first is not None
            turn['first_choice_correct']=correct
            failed=[]
            for call in native['calls']:
                result=native['results'].get(call['id'],{})
                details=result.get('details') or {}
                if result.get('isError') or details.get('retryable') or details.get('status')=='reference_mismatch':failed.append(call['id'])
            turn['backend_error_codes']=sorted({t['error_code'] for t in turn['tools'] if t.get('error_code')})
            turn['correction_count']=len(set(failed))
            turn['model_calls']=native['model_calls']
            turn['tokens']=native['tokens']
            turn['call_trace']=[{'id':c['id'],'tool':c['name'],'proposed':c['arguments'],
                'admitted':executed.get(c['id']), 'executed':executed.get(c['id']) if 'executed' in audit_stages.get(c['id'],set()) else None,
                'stages':sorted(audit_stages.get(c['id'],set())), 'rewritten':c['id'] in executed and executed[c['id']]!=c['arguments']} for c in native['calls']]
            parameters=correct and bool(first) and first['id'] not in failed
            if first and correct:
                a=dict(first['arguments'])
                for key in ['target','source']:
                    if isinstance(a.get(key),str):
                        try:a[key]=json.loads(a[key])
                        except ValueError:a[key]={}
                if expected['kind']=='read':
                    previous=[t['task_id'] for t in report['turns'][:index] if t.get('task_id')]
                    parameters=parameters and a.get('kind')=='result' and len(previous)>expected['readIndex'] and a.get('task_id')==previous[expected['readIndex']]
                if a.get('action')=='followup' and prior_task:parameters=parameters and a.get('source',{}).get('task_id')==prior_task
                if a.get('action')=='clarify' and waiting_task:parameters=parameters and a.get('target',{}).get('task_id')==waiting_task
                for key,field in [('org_codes','orgs'),('metric_codes','metrics')]:
                    if key in a and field in expected:parameters=parameters and sorted(a[key])==sorted(expected[field])
                for key in ['start','end','dimension','page','page_size']:
                    if key in a and key in expected:parameters=parameters and a[key]==expected[key]
            turn['first_parameters_correct']=bool(parameters) if correct is not None else None
            if expected.get('action'):
                actions=[executed[c['id']].get('action') for c in native['calls'] if c['name']=='metric_ask' and c['id'] in executed and (native['results'].get(c['id'],{}).get('details') or {}).get('status') in {'succeeded','clarification_required','context_required'}]
                turn['final_action_correct']=bool(actions) and actions[-1]==expected['action']
                if not turn['final_action_correct']:turn['errors'].append('最终执行动作不符合预期');turn['passed']=False
            for result in native['results'].values():
                details=result.get('details') or {}
                if details.get('status')=='clarification_required':waiting_task=details.get('task_id')
            if expected['kind']=='search' and expected.get('metrics'):
                confirmed=set()
                for result in native['results'].values():
                    if result.get('toolName') not in {'metric_catalog_search', 'catalog'} or result.get('isError'):continue
                    try:payload=json.loads(''.join(b.get('text','') for b in result.get('content',[]) if b.get('type')=='text'))
                    except ValueError:continue
                    searches = [payload] if result.get('toolName') == 'metric_catalog_search' else [r for r in payload.get('results', []) if r.get('entity') == 'metric' and r.get('status') == 'succeeded']
                    for search in searches:
                        confirmed.update(item['metric_code'] for item in search.get('items',[]) if item.get('match_type')=='exact')
                turn['catalog_exact_correct']=set(expected['metrics']).issubset(confirmed)
                if not turn['catalog_exact_correct']:turn['errors'].append('未精确确认用户完整指标名称');turn['passed']=False
            if expected['kind']=='coverage' and turn.get('request'):
                spec=turn['request']
                metric_codes=spec.get('metric_codes') or list(enabled_metrics)
                conditions=['org_code IN :orgs','stat_date IS NOT NULL']
                if spec['dimension']=='metrics' or spec.get('metric_codes'):conditions.append('metric_code IN :metrics')
                params={'orgs':spec['org_codes'],'metrics':metric_codes}
                if spec.get('start'):conditions.append('stat_date>=:start');params['start']=spec['start']
                if spec.get('end'):conditions.append('stat_date<=:end');params['end']=spec['end']
                field='metric_code' if spec['dimension']=='metrics' else 'stat_date'
                statement=text(f'SELECT DISTINCT {field} FROM metric_values WHERE '+ ' AND '.join(conditions)+f' ORDER BY {field} '+('DESC' if field=='stat_date' else 'ASC'))
                statement=statement.bindparams(bindparam('orgs',expanding=True))
                if 'metric_code IN :metrics' in conditions:statement=statement.bindparams(bindparam('metrics',expanding=True))
                values=[str(v)[:10] if field=='stat_date' else v for v in qc.execute(statement,params).scalars()]
                page=spec.get('page',1);size=spec.get('page_size',10);wanted=values[(page-1)*size:page*size]
                receipt=next((m.get('details') for m in reversed(list(native['results'].values()))
                    if (m.get('details') or {}).get('kind')=='data_availability' and (m.get('details') or {}).get('status')=='succeeded'),None)
                if receipt:
                    observed=[item['metric_code'] for item in receipt.get('items',[])] if field=='metric_code' else receipt['groups'][0]['dates']
                    total=receipt['metric_count'] if field=='metric_code' else receipt['groups'][0]['date_count']
                    turn['coverage_sql_matches']=observed==wanted and total==len(values)
                    if not turn['coverage_sql_matches']:turn['errors'].append('覆盖分页/总量与独立SQL不一致');turn['passed']=False
            expected_source=prior_task
            task=turn.get('task_id')
            if task:
                state=ac.execute(text('SELECT state_json FROM query_tasks WHERE id=:id'),{'id':task}).scalar_one()
                if isinstance(state,str):state=json.loads(state)
                artifact=state['result_artifact']
                dsl=artifact['logical_dsl']
                reference=state.get('query_reference') or {}
                turn['backend_source_task_id']=reference.get('source_task_id')
                result=artifact['result']
                # 本套用例为原值 exact/all_in_range；独立 SQL 不调用查询计划或业务取数 API。
                sql=text('SELECT metric_code,org_code,stat_date,metric_value FROM metric_values '
                    'WHERE metric_code IN :metrics AND org_code IN :orgs AND stat_date BETWEEN :start AND :end')
                sql=sql.bindparams(bindparam('metrics',expanding=True),bindparam('orgs',expanding=True))
                wanted=qc.execute(sql,{'metrics':expected.get('metrics',dsl['metrics']),
                    'orgs':expected.get('orgs',dsl['orgs']),'start':expected.get('start',dsl['time']['start']),
                    'end':expected.get('end',dsl['time']['end'])}).mappings().all()
                def normalize(row):
                    amount=row.get('metric_value')
                    return (row['metric_code'],row['org_code'],str(row['stat_date'])[:10],None if amount is None else str(Decimal(str(amount)).normalize()))
                observed=sorted([normalize(r) for r in result['rows']],key=str)
                wanted=sorted([normalize(r) for r in wanted],key=str)
                turn['sql_checked']=True
                turn['sql_matches']=observed==wanted and result['row_count']==len(wanted) and not result.get('truncated')
                turn['sql_expected_rows']=len(wanted)
                turn['sql_result_fingerprint']=digest(observed)
                if not turn['sql_matches']:
                    turn['errors'].append('完整结果与独立只读SQL不一致')
                    turn['passed']=False
                prior_task=task
                waiting_task=None
            source_correct=expected.get('action')!='followup' or turn.get('backend_source_task_id')==expected_source
            turn['parameters_and_reference_correct']=turn['passed'] and source_correct
            if task and not source_correct:
                turn['errors'].append('后端追问来源未正确继承')
                turn['passed']=False
        for turn,native in zip(report['turns'],turns):
            turn['model_errors']=native['model_errors']
        report['passed']=bool(report['turns']) and all(t['passed'] for t in report['turns']) and not report.get('error')
        reports.append(report)

flat=[t for r in reports for t in r['turns']]
choice=[t for t in flat if t['first_choice_correct'] is not None]
summary={'groups':len(reports),'groups_passed':sum(r['passed'] for r in reports),'turns':len(flat),
 'turns_passed':sum(t['passed'] for t in flat),'first_choice_denominator':len(choice),
 'first_choice_correct':sum(t['first_choice_correct'] for t in choice),
 'first_target_called':sum(t['first_target_called'] for t in choice),
 'first_parameters_correct':sum(t['first_parameters_correct'] for t in choice),
 'corrections':sum(t['correction_count'] for t in flat),'sql_checked':sum(t.get('sql_checked',False) for t in flat),
 'sql_matches':sum(t.get('sql_matches',False) for t in flat),'model_calls':sum(t['model_calls'] for t in flat),
 'coverage_sql_checked':sum('coverage_sql_matches' in t for t in flat),
 'coverage_sql_matches':sum(t.get('coverage_sql_matches',False) for t in flat),
 'tokens':sum(t['tokens'] for t in flat),'median_elapsed_ms':round(statistics.median(t['elapsed_ms'] for t in flat)) if flat else None,
 'turns_with_model_error':sum(bool(t.get('model_errors')) for t in flat),
 'failed_groups':[r['id'] for r in reports if not r['passed']]}
output={'environment':'configured_real_model_local_development_database','summary':summary,'cases':reports}
(Path(args.reports)/'audit.json').write_text(json.dumps(output,ensure_ascii=False,indent=2))
print(json.dumps(summary,ensure_ascii=False))
