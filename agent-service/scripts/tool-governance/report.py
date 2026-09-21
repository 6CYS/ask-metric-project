"""将脱敏审计结果转换为可检查的 Markdown，不读取凭据或业务金额。"""
import argparse
import json
from pathlib import Path

parser = argparse.ArgumentParser()
parser.add_argument('--audit', required=True)
parser.add_argument('--output', required=True)
args = parser.parse_args()
audit = json.loads(Path(args.audit).read_text())
s = audit['summary']
def ratio(numerator, denominator):
    return f'{numerator}/{denominator}（{numerator / denominator:.1%}）' if denominator else '未取得可评样本'

lines = [
    '# 工具调用真实多轮验收结果', '',
    '环境：当前配置真实模型、本地开发后端与数据库。通过浏览器正常会话恢复取得授权，在浏览器内完成 HTTP/SSE 调用；未导出登录令牌。', '',
    '用例依据真实目录与已知边界编写，不是历史用户会话。每组使用独立会话；组内连续追问。取值与覆盖回执使用独立只读 SQL 核对。', '',
    '| 指标 | 结果 |', '| --- | --- |',
    f"| 整组通过 | {ratio(s['groups_passed'], s['groups'])} |",
    f"| 最终轮次通过 | {ratio(s['turns_passed'], s['turns'])} |",
    f"| 首次目标工具/动作正确 | {ratio(s['first_choice_correct'], s['first_choice_denominator'])} |",
    f"| 首次参数与引用正确 | {ratio(s['first_parameters_correct'], s['first_choice_denominator'])} |",
    f"| 实际产生首次目标调用的轮数 | {s['first_target_called']} |",
    f"| 可纠正调用错误次数 | {s['corrections']} |",
    f"| 取值与独立 SQL 一致 | {ratio(s['sql_matches'], s['sql_checked'])} |",
    f"| 覆盖与独立 SQL 一致 | {ratio(s['coverage_sql_matches'], s['coverage_sql_checked'])} |",
    f"| 出现 Agent 模型错误的轮数（含重试成功） | {s['turns_with_model_error']} |",
    f"| Agent 模型请求数 / token | {s['model_calls']} / {s['tokens']} |",
    f"| 单轮耗时中位数 | {s['median_elapsed_ms']} ms |", '',
    '首次正确率分母包含未成功产生调用的目标轮；目录/方法读取等必要前置步骤不计目标调用。纠错后成功不算首次正确。Token 仅计 Agent 层，不含后端提槽模型。耗时含每次模型请求 5 秒的验收节流及原生重试，不作为生产性能对比。', '',
    '| 组 | 场景 | 通过轮数 | 结论与失败原因 |', '| --- | --- | --- | --- |',
]
for case in audit['cases']:
    errors = list(dict.fromkeys(error for turn in case['turns'] for error in turn['errors']))
    if case.get('error'):
        errors.append(case['error'])
    provider = sorted({error for turn in case['turns'] for error in turn.get('model_errors', [])})
    backend = sorted({error for turn in case['turns'] for error in turn.get('backend_error_codes', [])})
    detail = '通过' if case['passed'] else '未通过：' + '；'.join(errors)
    if provider or backend:
        detail += '；模型/后端错误：' + ', '.join(provider + backend)
    lines.append(f"| {case['id']} | {case['category']} | {sum(t['passed'] for t in case['turns'])}/{len(case['turns'])} | {detail} |")
lines += ['', '完整调用轨迹、Hook 处理前后参数、来源任务和事实指纹见同次 audit.json；报告不包含业务金额。失败记录保留，定向复测另存目录，不覆盖首轮统计。', '']
Path(args.output).write_text('\n'.join(lines))
