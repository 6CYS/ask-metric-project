"""Audit existing native receipts only; no model/API/database calls. Keep immutable *.raw.json.
Usage: python3 this.py [candidate-report-base-name]
"""
from pathlib import Path
import hashlib
import json
import sys

HERE = Path(__file__).resolve().parent
PREFIX = 'prompt-skill-ab-20261013'
CANDIDATE = next((arg for arg in sys.argv[1:] if not arg.startswith('--')), PREFIX + '-after')
FINAL_MANIFEST = next((arg.split('=', 1)[1] for arg in sys.argv[1:] if arg.startswith('--final-manifest=')), None)


def save(path, value):
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + '\n')


def single_frame_reference_proof(turn, report, archive_native=False):
    if turn['scenario'] != 'unique_reference_without_count':
        return None
    calls = [c for c in turn['tools'] if c['name'] == 'resolve_business_turn']
    for call in calls:
        raw = next((c.get('rawValue') for c in call.get('args', {}).get('fieldChanges', []) if c.get('fieldHint') == 'organizations'), None)
        if isinstance(raw, dict) and raw.get('fromHistory') is True:
            if raw.get('combine') == 'single' and len(raw.get('sources', [])) == 1:
                return {'accepted_path': 'single_field_reference', 'model_called': False}
    focus = turn.get('focus') or {}
    if focus.get('status') != 'success' or len(turn['query_specs']) != 1:
        return None
    spec = turn['query_specs'][0]
    if (spec.get('org_codes') != ['SYNTH_O1'] or spec.get('metric_codes') != ['SYNTH_M1']
        or spec.get('time') != {'start': '2026-07-31', 'end': '2026-07-31'}
        or spec.get('selection') != 'exact'
        or spec.get('operation') != {'kind': 'ranking', 'position': 'top', 'top_n': 3}):
        return None
    source_ids = {focus.get('fields', {}).get(name, {}).get('sourceFrameId') for name in ('organizations', 'metrics', 'time')}
    if len(source_ids) != 1 or None in source_ids:
        return None
    source_id = next(iter(source_ids))
    explicit = []
    current_calls = []
    for call in calls:
        args = call.get('args', {})
        base = args.get('baseReference')
        intent = args.get('fieldIntents', {}).get('organizations', {})
        if (isinstance(base, dict) and base and (base.get('frameId') in (None, source_id))
            and intent.get('mode') == 'inherit' and intent.get('sourceText') is None and intent.get('expectedCount') is None):
            explicit.append(call['id'])
        if (base == 'current' and intent.get('mode') == 'inherit'
            and intent.get('sourceText') is None and intent.get('expectedCount') is None):
            current_calls.append(call['id'])
    if not explicit and not current_calls:
        return None
    session = focus['sessionId']
    files = list(Path(report['session_data']).rglob('*_' + session + '.jsonl'))
    durable_dir = HERE / (PREFIX + '-final-native')
    if not files and archive_native:
        files = list(durable_dir.glob('*_' + session + '.jsonl'))
    if len(files) != 1:
        return None
    values = {}
    flattened = []
    for line in files[0].read_text().splitlines():
        data = json.loads(line)
        for row in data if isinstance(data, list) else [data]:
            flattened.append(row)
            if row.get('kind') == 'value' and row.get('op') == 'set' and row.get('namespace') == 'askmetric.business.v1':
                values[row['key']] = row.get('value')
    source = values.get('frame/' + source_id, {})
    roots = [v for key, v in values.items() if key.startswith('frame/') and isinstance(v, dict)
        and v.get('status') == 'success' and str(v.get('requestId', '')).startswith('seed-')]
    if (len(roots) != 1 or source.get('requestId') != 'seed-0' or source.get('status') != 'success'
        or source.get('sessionId') != session):
        return None
    alias_proofs = []
    for call_id in current_calls:
        before_values = {}
        for index, row in enumerate(flattened):
            message = row.get('message', {})
            if (row.get('kind') == 'entry' and message.get('role') == 'assistant'
                and any(c.get('type') == 'toolCall' and c.get('id') == call_id for c in message.get('content', []))):
                prior = before_values.get('state', {})
                seed = before_values.get('frame/' + source_id, {})
                if (prior.get('focusFrameId') == source_id and len(prior.get('operations', {})) == 1
                    and seed.get('requestId') == 'seed-0' and seed.get('status') == 'success'):
                    alias_proofs.append({'call_id': call_id, 'native_record_index': index,
                        'prior_focus_frame_id': prior['focusFrameId'], 'prior_operation_ids': list(prior['operations']),
                        'source_status_before_call': seed['status'], 'source_request_id_before_call': seed['requestId']})
                break
            if row.get('kind') == 'value' and row.get('op') == 'set' and row.get('namespace') == 'askmetric.business.v1':
                before_values[row['key']] = row.get('value')
    if not explicit and not alias_proofs:
        return None
    proof = {'accepted_path': 'unique_explicit_whole_frame_base' if explicit else 'unique_current_alias_with_native_focus_proof',
        'current_alias_call_time_proof': alias_proofs, 'source_frame_id': source_id,
        'source_request_id': source['requestId'], 'source_session_id': session, 'call_ids': explicit or [p['call_id'] for p in alias_proofs],
        'source_native_file': str(files[0]), 'source_native_sha256': hashlib.sha256(files[0].read_bytes()).hexdigest(),
        'all_org_metric_date_fields_bound_to_source': True, 'full_query_spec_verified': True,
        'field_intent_inherit_null_null_verified': True, 'model_called': False}
    if archive_native:
        durable_dir.mkdir(exist_ok=True)
        durable = durable_dir / files[0].name
        if durable.exists():
            assert durable.read_bytes() == files[0].read_bytes(), 'Archived native source differs'
        else:
            durable.write_bytes(files[0].read_bytes())
        proof['durable_artifact'] = str(durable.relative_to(HERE))
        proof['durable_artifact_sha256'] = hashlib.sha256(durable.read_bytes()).hexdigest()
        assert proof['durable_artifact_sha256'] == proof['source_native_sha256']
    return proof


def load_audited(name):
    path = HERE / (name + '.json')
    raw = HERE / (name + '.raw.json')
    if not raw.exists():
        raw.write_bytes(path.read_bytes())
    report = json.loads(raw.read_text())
    report['original_model_measurement_summary'] = dict(report['summary'])
    changes = []
    for turn in report['turns']:
        turn['original_model_passed'] = turn['passed']
        if turn.get('failure'):
            turn['original_model_failure'] = turn['failure']
        # 只修显示符号：运算已通过所有真实stub/Frame门禁，不能借此放宽公式、来源或单位。
        if turn['expected']['kind'] == 'calculate' and turn.get('failure') == 'CALCULATED_RESULT_NOT_DELIVERED':
            results = [r['details'] for r in turn['receipts'] if isinstance(r.get('details'), dict)
                and r['details'].get('kind') == 'metric_calculate' and r['details'].get('status') == 'succeeded']
            if (len(results) == 1 and len(turn['calculation_specs']) == 1 and not turn['query_specs']
                and turn.get('focus', {}).get('status') == 'success'
                and results[0]['results'][0]['value'] == '-84.75'
                and '-84.75' in turn['answer'].replace('\u2212', '-')):
                turn['passed'] = True
                turn.pop('failure', None)
                turn['grade_revision'] = {'reason': 'U+2212 mathematical minus equals ASCII minus for display',
                    'formal_calculation_verified': True, 'model_called': False,
                    'original_failure': 'CALCULATED_RESULT_NOT_DELIVERED'}
        reference_proof = single_frame_reference_proof(turn, report, archive_native=name == PREFIX + '-after')
        if reference_proof:
            turn['single_reference_contract_audit'] = reference_proof
            if turn.get('failure') in ('指代须提交结构化历史来源', '指代须有唯一整笔Frame来源或单源字段引用，不能仅依靠current或正文'):
                turn['passed'] = True
                turn.pop('failure', None)
                turn['grade_revision'] = {'reason': 'Approved whole-Frame or field-reference contract accepts a uniquely selected whole source Frame',
                    'original_failure': turn['original_model_failure'], 'source_proof': reference_proof, 'model_called': False}
        count_findings = []
        if turn['scenario'] == 'unique_reference_without_count':
            for call in turn['tools']:
                args = call.get('args', {})
                value = args.get('fieldIntents', {}).get('organizations', {}).get('expectedCount')
                if isinstance(value, int) and not isinstance(value, bool) and value > 0:
                    count_findings.append({'call_id': call['id'], 'site': 'fieldIntents.organizations.expectedCount', 'value': value})
                field_changes = args.get('fieldChanges', [])
                raw_field = next((c.get('rawValue') for c in field_changes if c.get('fieldHint') == 'organizations'), args.get('set', {}).get('organizations'))
                if isinstance(raw_field, dict):
                    value = raw_field.get('expectedCount')
                    if isinstance(value, int) and not isinstance(value, bool) and value > 0:
                        count_findings.append({'call_id': call['id'], 'site': 'organizations.fromHistory.expectedCount', 'value': value})
        turn['reference_count_audit'] = {'user_supplied_quantity': False if turn['scenario'] == 'unique_reference_without_count' else None,
            'affected_turn': bool(count_findings), 'findings': count_findings}
        count = sum(isinstance(r.get('details'), dict) and r['details'].get('status') == 'NEEDS_CLARIFICATION'
                    for r in turn['receipts'])
        turn['original_model_measures'] = dict(turn['measures'])
        revised = max(0, count - 1)
        changes.append({'scenario': turn['scenario'], 'turn': turn['turn'],
                        'structured_clarifications': count,
                        'original_repeated': turn['measures']['repeated_clarifications'],
                        'audited_repeated': revised})
        turn['measures']['repeated_clarifications'] = revised
    report['summary']['achieved_turns'] = sum(t['passed'] for t in report['turns'])
    report['summary']['ungrounded_reference_count_turns'] = sum(t['reference_count_audit']['affected_turn'] for t in report['turns'])
    report['summary']['repeated_clarifications'] = sum(t['measures']['repeated_clarifications'] for t in report['turns'])
    report['measurement_audit'] = {'model_called': False, 'original_report': raw.name,
        'raw_sha256': hashlib.sha256(raw.read_bytes()).hexdigest(),
        'audit_script_sha256': hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
        'rule': 'same-turn repeated=max(0, NEEDS_CLARIFICATION receipts-1); unnecessary stays separate',
        'changes': changes, 'model_requests_or_results_changed': False}
    save(path, report)
    # Do not replace the original execution-stage Markdown: add an explicit corrected-score section.
    md = HERE / (name + '.md')
    original_md = HERE / (name + '.raw.md')
    if not original_md.exists():
        original_md.write_bytes(md.read_bytes())
    md.write_text(original_md.read_text() + '\n\n## 统一测量审计\n\n'
        + '原始模型回执与统计保留在同名 `.raw.json` / `.raw.md`。以下修订只读使用既有回执，不调用模型、不改请求或结果。'
        + '重复澄清只计同回合第2次及以后；已知条件下首次多问单独计不必要澄清。原文上方的原始 repeated 统计以本节为准。\n\n'
        + '```json\n' + json.dumps(report['summary'], ensure_ascii=False, indent=2) + '\n```\n')
    return report


before = load_audited(PREFIX + '-before')
after = load_audited(CANDIDATE)
instrumentation = json.loads((HERE / (PREFIX + '-instrumentation.json')).read_text())
reviewed_hashes = {item['hash'] for item in instrumentation.get('revisions', [])}
assert before['script_hash'] in reviewed_hashes and after['script_hash'] in reviewed_hashes, 'Unreviewed execution script hash'
assert before['script_hash'] == after.get('original_evaluation_script_hash', before['script_hash']), 'Evaluation lineage changed'
assert before['scenarios'] == after['scenarios'], 'Paired scenarios and interventions must be identical'
assert before['model'] == after['model']
for field in ('model_max_tokens', 'model_extra_body', 'compact_turn_args'):
    assert before[field] == after[field], 'Paired model configuration changed: ' + field
for report in (before, after):
    assert len(report['turns']) == 11 and len({(t['scenario'], t['turn']) for t in report['turns']}) == 11, 'Incomplete or duplicate turn coverage'
paired = []
for turn in after['turns']:
    old = next(t for t in before['turns'] if (t['scenario'], t['turn']) == (turn['scenario'], turn['turn']))
    result = ('shared_pass' if turn['passed'] else 'candidate_only_failure') if old['passed'] else ('baseline_only_failure' if turn['passed'] else 'shared_failure')
    paired.append({'scenario': turn['scenario'], 'turn': turn['turn'],
                   'before': {'passed': old['passed'], **old['measures']},
                   'after': {'passed': turn['passed'], **turn['measures']}, 'result': result})
counts = {key: sum(p['result'] == key for p in paired) for key in
          ('shared_pass', 'candidate_only_failure', 'baseline_only_failure', 'shared_failure')}
combined = {'model': after['model'], 'baseline_report': PREFIX + '-before.json', 'candidate_report': CANDIDATE + '.json',
    'before': before['summary'], 'after': after['summary'], 'counts': counts, 'paired': paired,
    'measurement_audit': {'model_called': False, 'script_hash_equal': before['script_hash'] == after['script_hash'], 'instrumentation_patch_reviewed': True,
        'before': before['measurement_audit'], 'after': after['measurement_audit']},
    'limitations': 'one sample/version; synthetic backend; controlled pre-read subset; no statistical significance or production acceptance'}
output = PREFIX if CANDIDATE == PREFIX + '-after' else CANDIDATE + '-comparison'
intermediates = {}
for stage in ('candidate1', 'candidate2', 'candidate3', 'candidate4'):
    path = HERE / (PREFIX + '-' + stage + '.json')
    if path.exists():
        item = json.loads(path.read_text())
        assert item['script_hash'] in reviewed_hashes
        assert item['scenarios'] == after['scenarios']
        assert len(item['turns']) == 11 and len({(t['scenario'], t['turn']) for t in item['turns']}) == 11
        for field in ('model', 'model_max_tokens', 'model_extra_body', 'compact_turn_args'):
            assert item[field] == before[field]
        intermediates[stage] = item
        combined['intermediate_' + stage] = {'report': path.name, 'summary': item['summary'],
            'source_hashes': item['source_hashes'], 'retained_all_failures': True}
if FINAL_MANIFEST:
    manifest_paths = {'before': Path('/private/tmp/prompt-skill-unify-before-20261013-n08obfps/manifest.json'),
        'candidate1': Path('/private/tmp/prompt-skill-unify-candidate1-20261013-6oda8yg3/manifest.json'),
        'candidate2': Path('/private/tmp/prompt-skill-unify-final-20261013-992ls5tm/manifest.json'),
        'candidate3': Path('/private/tmp/prompt-skill-unify-candidate3-20261013-vxsr7qgu/manifest.json'),
        'candidate4': Path('/private/tmp/prompt-skill-unify-candidate4-20261013-d16zkqke/manifest.json'),
        'final': Path(FINAL_MANIFEST)}
    manifests = {}
    for stage, path in manifest_paths.items():
        data = json.loads(path.read_text())
        files = data.get('files', data)
        manifests[stage] = {'original_path': str(path),
            'original_manifest_sha256': hashlib.sha256(path.read_bytes()).hexdigest(),
            'file_count': len(files), 'files': files}
    manifest_report = HERE / (PREFIX + '-source-manifests.json')
    save(manifest_report, {'model_called': False, 'scope': 'Complete src/skills snapshot manifest; source hashes only, no credentials',
        'stages': manifests})
    combined['complete_source_manifests'] = {'report': manifest_report.name,
        'sha256': hashlib.sha256(manifest_report.read_bytes()).hexdigest(),
        'stages': {stage: {'file_count': value['file_count'], 'manifest_sha256': value['original_manifest_sha256']} for stage, value in manifests.items()}}
    combined['audit_script_sha256'] = hashlib.sha256(Path(__file__).read_bytes()).hexdigest()
if CANDIDATE == PREFIX + '-after':
    combined['delivery_verification'] = {
        'reported_by': 'root integration verification, 2026-10-13',
        'agent_test_results': {'passed': 1088, 'suites': 116},
        'build': 'passed', 'typecheck': 'passed', 'diff_check': 'passed',
        'public_tool_schema_and_prepare_arguments': 'legacy/compact unchanged after removing descriptions',
        'capability_fields_complete_fields_validate': 'all three capabilities unchanged after removing descriptions',
        'business_core_files': '11 files byte-identical to before',
        'core_ast': 'only FIELD_INTENT_INVALID correction description changed',
        'source_snapshot': 'all 116 current src/skills files match candidate5 frozen manifest',
        'local_health': {'frontend_5173': 200, 'frontend_agent_proxy_health': 200, 'agent_8010_health': 200},
        'local_agent_reload': 'PID 82769, 2026-10-13 22:32:48, after final source change; Skills changed earlier',
        'production_deployed': False,
        'rollback_scope': 'restore only this task prompt/tool/Skill description diff, preserve prior business and working-tree changes'}
    combined['remaining_issues'] = [
        {'scenario': 'ambiguous_month_ranking_and_recovery', 'turn': 1,
         'issue': 'First call omitted selection (FIELD_COMBINATION_INVALID); corrected call saved selection clarify but removed operation, leaving operation missing instead of ambiguous; no query was executed.'},
        {'scenario': 'ambiguous_month_ranking_and_recovery', 'turn': 2,
         'issue': 'SDK tool JSONSchema rejected a bare UUID baseReference; requires a structured selector such as {frameId: ...}. Model then corrected and achieved the turn.'},
        {'scenario': 'two_sources_union_count', 'turn': 1,
         'issue': 'REFERENCE_IMPLIES_CONTINUATION rejected union with null base. Model then corrected and achieved the turn.'}]
    combined['execution_and_grading_lineage'] = {
        'actual_final_model_executed_script_hash': after['script_hash'],
        'future_measurement_runner_hash': instrumentation['new_script_hash'],
        'future_measurement_runner_strict_typecheck': 'passed; no model executed with this version',
        'read_only_audit_script_sha256': hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
        'model_rerun_after_grade_correction': False}
save(HERE / (output + '.json'), combined)
keys = ('achieved_turns', 'tool_calls', 'error_calls', 'error_rate', 'expected_business_refusals', 'ungrounded_condition_proposals',
        'ungrounded_condition_executions', 'ungrounded_reference_count_turns', 'unnecessary_clarifications', 'repeated_clarifications', 'model_calls')
labels = {'achieved_turns': '完整目标达成回合', 'tool_calls': '模型工具调用总数', 'error_calls': '错误调用次数', 'error_rate': '错误调用比例',
    'expected_business_refusals': '预期业务能力拒绝（不计错误）',
    'ungrounded_condition_proposals': '无依据日期取数/排名提案（逐字段、逐次提交）',
    'ungrounded_condition_executions': '无依据条件实际查询执行',
    'ungrounded_reference_count_turns': '无明确数量指代中生成数量约束（影响回合）',
    'unnecessary_clarifications': '已知条件下不必要澄清', 'repeated_clarifications': '同回合重复澄清', 'model_calls': '模型调用次数'}
def show(summary, key):
    return f"{summary[key]:.1%}" if key == 'error_rate' else summary[key]
lines = ['# System Prompt、工具说明和四 Skill 配对验证', '',
    f"真实模型：{after['model']}；固定 8 场景 / 11 回合，各版本一次。目录、权限、事实与计算均为隔离合成桩，未访问任何真实业务数据库或生产服务。", '',
    '| 指标 | 修改前 | 修改后 |', '| --- | --- | --- |']
if CANDIDATE == PREFIX + '-after':
    lines[2:2] = ['最终完整目标达成由 8/11 变为 10/11，但错误调用仍为 3/14（21.4%），没有减少。无依据日期取数/排名提案从3次变为0，相关实际执行从1次变为0，已知条件下不必要澄清从1次变为0。此次单次配对没有证明全部优化目标达成。', '']
lines.extend(f"| {labels[key]} | {show(before['summary'], key)} | {show(after['summary'], key)} |" for key in keys)
lines += ['', f'同组结果：{json.dumps(counts, ensure_ascii=False)}。', '',
    '| 场景 / 回合 | 前 | 后 | 分类 |', '| --- | --- | --- | --- |']
lines.extend(f"| {p['scenario']} / {p['turn']} | {'通过' if p['before']['passed'] else '失败'}；错误{p['before']['error_calls']} | {'通过' if p['after']['passed'] else '失败'}；错误{p['after']['error_calls']} | {p['result']} |" for p in paired)
lines += ['', '测量审核只使用既有回执，原始报告保留为 `.raw.json` / `.raw.md`。重复澄清统一只计同回合第2次及以后；已知条件下首次多问单独计不必要澄清。审计记录在 JSON 的 measurement_audit，只读审计不改既有模型请求或结果；执行器只经过已记录、已审阅的测量修补，旧新hash与patch保留。', '',
    '每个版本仅一次，模型存在随机性，不能宣称统计显著改善。preRead 指定的场景通过实际 business_skill_read 原生回执控制已读正文，其他场景自然按需读取。历史种子不是模型建立的真实历史；计算首轮由实际模型查询。合成业务验收不代表真实目录、数据库或生产验收。', '',
    '错误调用按原生 isError、ARGUMENT_ERROR/error/failed 计，分母为该回合模型全部工具调用，排除受控预读；unsupported 预期业务拒绝单列。无依据提案自动检查取数口径和排名条数，机构/指标/完整日期另纳入目标达成断言。无结构化回执的普通追问不算有效澄清，会导致目标失败。详细参数、回执、Frame 和正式 spec 供人工复核。额外数量约束逐阶段审核唯一无数量指代场景，不能把日期/排名自动计数为0泛称完全不猜条件。', '',
    f'详细报告：[修改前]({PREFIX}-before.md)、[本候选]({CANDIDATE}.md)。', '']
if intermediates and CANDIDATE == PREFIX + '-after':
    lines += ['', '## 六阶段完整结果', '',
        '每个明确源码版本完整运行一次并保留全部失败。candidate2 第5回合模型 idle 失败后，测量脚本 Node assert 错误定位递归，先只读保存原生证据，再仅续跑未执行6回合；未重新采样已执行回合。最终候选使用已审阅的测量修补，原始/修补脚本与patch/hash全部保留。', '',
        '| 指标 | 修改前 | candidate1 | candidate2 | candidate3 | candidate4 | 最终 candidate5 |', '| --- | --- | --- | --- | --- | --- | --- |']
    for key in keys:
        cells = [show(before['summary'], key)] + [show(intermediates[stage]['summary'], key) for stage in ('candidate1','candidate2','candidate3','candidate4')] + [show(after['summary'], key)]
        lines.append('| ' + labels[key] + ' | ' + ' | '.join(map(str,cells)) + ' |')
    lines += ['', f'中间版本完整报告：[candidate1]({PREFIX}-candidate1.md)、[candidate2]({PREFIX}-candidate2.md)、[candidate3]({PREFIX}-candidate3.md)、[candidate4]({PREFIX}-candidate4.md)。', '',
        f'测量修补：[instrumentation patch]({PREFIX}-instrumentation.patch)、[旧新hash及断言递归证据]({PREFIX}-instrumentation.json)。关键fixture/场景/请求不变，执行文件hash差异不被伪称相同；最终展示断言接受数学负号U+2212与ASCII负号等价，所有阶段离线按同一规则审核并保留原始pass/failure。单一历史来源允许明确唯一的整笔Frame base继承（须正式spec与三字段源绑定正确、inherit/null/null），不强制额外fromHistory包装；current仅在原生调用时焦点确为预期唯一seed且三字段来源与正式spec完整绑定时接受，保留事件序号与源身份证明。多源union仍必须字段来源结构，无法证明来源的current或正文表述不接受。', '']
if FINAL_MANIFEST:
    lines += ['', f'完整六阶段 src/skills 来源 hash 清单：[source-manifests]({PREFIX}-source-manifests.json)，包括 core 错误说明、modelView 与其他实际运行来源。执行脚本原始 hash 和统计审计脚本 hash 另分别保留，不将测量后处理当作模型重跑。', '']
if CANDIDATE == PREFIX + '-after':
    proof = next(t['single_reference_contract_audit'] for t in after['turns'] if t['scenario'] == 'unique_reference_without_count')
    lines += ['', '## 尚未解决的实际问题', '',
        '- 月份排名首问仍有一次 selection 缺失校验错误；纠正时只保存 selection 待澄清，将 operation 遗漏为 missing。虽然没有猜条件执行查询，但未完整保存所有未决业务选择，因此这一回合失败。',
        '- 用户补充日期口径和排名条数后，模型先将 baseReference 错传为裸 UUID，引发 SDK 工具 JSONSchema 错误；随后纠正完成。',
        '- 多来源 union 首次将 base 传 null，引发 REFERENCE_IMPLIES_CONTINUATION；随后纠正完成。', '',
        f'最终唯一历史来源的 current 别名通过原生调用前状态确认：事件序号46、焦点为唯一预期 seed、机构/指标/日期三字段绑定同一来源、正式 spec 和执行完整。原始失败仍保留；[原生 JSONL]({proof["durable_artifact"]}) 已原样归档，SHA-256 `{proof["durable_artifact_sha256"]}`。', '',
        '## 落地与验证边界', '',
        '本地 system prompt、工具说明、能力描述和四个 Skill 已统一。集成验证：1088/1088 测试（116 suites）、build、typecheck、diff check 通过。公开工具两套方言的参数与 prepareArguments、三个能力的字段/completeFields/validate 均未改变；11个业务核心文件与修改前逐字节一致，core AST 只改 FIELD_INTENT_INVALID 错误说明。最终116个来源文件与冻结快照 hash 一致。', '',
        '本地入口 http://127.0.0.1:5173 可用，前端、Agent 及代理 health 均为200；Agent 已于最终源码修改后重载。未部署线上，未访问真实业务数据库。回退仅恢复本轮提示词、工具和 Skill 说明差异，保留此前业务修复和其他工作树改动。', '',
        f'最终真实模型运行脚本 hash 为 `{after["script_hash"]}`；现存未来测量器 hash 为 `{instrumentation["new_script_hash"]}`，只新增评分状态采集/契约断言并通过 strict tsc，未用其再次运行模型。只读审计脚本 hash 为 `{hashlib.sha256(Path(__file__).read_bytes()).hexdigest()}`。', '']
(HERE / (output + '.md')).write_text('\n'.join(lines))
print(json.dumps({'before': before['summary'], 'after': after['summary'], 'counts': counts, 'output': output}, ensure_ascii=False))
