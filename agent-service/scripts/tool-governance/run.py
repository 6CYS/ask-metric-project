"""经 web-access CDP Proxy 驱动已登录本地页面；不提取/落盘令牌或金额。"""
import argparse
import json
import time
import urllib.request
from pathlib import Path

parser = argparse.ArgumentParser()
parser.add_argument('--target', required=True)
parser.add_argument('--output', required=True)
parser.add_argument('--ids', default='')
args = parser.parse_args()
root = Path(__file__).resolve().parent
output = Path(args.output)
output.mkdir(parents=True, exist_ok=True)

def evaluate(code):
    request = urllib.request.Request('http://localhost:3456/eval?target=' + args.target,
                                     data=code.encode(), method='POST')
    response = json.load(urllib.request.urlopen(request, timeout=60))
    if 'error' in response:
        raise RuntimeError(response['error'])
    return response.get('value')

print(json.dumps(evaluate((root / 'browser.js').read_text()), ensure_ascii=False), flush=True)
cases = json.loads((root / 'cases.json').read_text())
if args.ids:
    by_id = {case['id']: case for case in cases}
    cases = [by_id[case_id] for case_id in args.ids.split(',')]
for case in cases:
    evaluate('__toolGovernance.start(' + json.dumps(case, ensure_ascii=False) + ')')
    started = time.monotonic()
    while True:
        try:
            state = evaluate('({running:__toolGovernance.state.running,active:__toolGovernance.state.active})')
        except Exception:
            # 浏览器临时连接失败只重读状态，不重复发送问题。
            time.sleep(3)
            state = evaluate('({running:__toolGovernance.state.running,active:__toolGovernance.state.active})')
        if not state['running']:
            break
        if time.monotonic() - started > 600:
            raise TimeoutError('单组超过10分钟，保留原会话，不自动重发')
        time.sleep(3)
    report = evaluate('__toolGovernance.state.results.at(-1)')
    (output / (case['id'] + '.json')).write_text(json.dumps(report, ensure_ascii=False, indent=2))
    print(json.dumps({'id': case['id'], 'passed': report['passed'], 'error': report.get('error'),
        'turns': [{'passed': t['passed'], 'tools': [x['name'] for x in t['tools']], 'errors': t['errors'],
                   'elapsed_ms': t['elapsed_ms']} for t in report['turns']]}, ensure_ascii=False), flush=True)

    if (output / 'stop-after-group').exists():
        print('按检查点停止，保留已完成用例。', flush=True)
        break
