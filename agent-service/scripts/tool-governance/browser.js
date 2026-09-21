/** 在已登录开发站点运行；使用正常 Cookie 恢复接口，令牌只存在浏览器闭包。 */
(async () => {
  const restored = await fetch('/api/v1/auth/session', {method: 'POST', headers: {'X-Ask-Metric-Session': '1'}});
  if (!restored.ok) throw new Error(`正常会话恢复失败 HTTP ${restored.status}`);
  const auth = await restored.json();
  const api = async (path, body, headers = {}) => {
    const target = path.startsWith('/agent-api/') ? path.replace('/agent-api', 'http://127.0.0.1:8022') : path;
    const response = await fetch(target, {method: body === undefined ? 'GET' : 'POST',
      headers: {Authorization: `Bearer ${auth.access_token}`, 'Content-Type': 'application/json', ...headers},
      ...(body === undefined ? {} : {body: JSON.stringify(body)})});
    if (!response.ok) throw new Error(`HTTP ${response.status}: ${path}`);
    return response;
  };
  const json = async (path, body) => (await api(path, body)).json();
  const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const sameSet = (a, b) => equal([...(a ?? [])].sort(), [...(b ?? [])].sort());
  const hash = async text => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)))].map(b => b.toString(16).padStart(2, '0')).join('');
  const state = {running: false, results: [], active: null};
  globalThis.__toolGovernance = {
    state,
    start(test) {
      if (state.running) throw new Error('上组尚未结束');
      state.running = true;
      state.active = {id: test.id, turn: 0};
      void (async () => {
        const report = {id: test.id, category: test.category, turns: [], passed: false};
        try {
          const session = await json('/agent-api/sessions', {});
          report.session_id = session.session_id;
          let previousMessages = 0;
          const queryTasks = [];
          for (const [index, turn] of test.turns.entries()) {
            state.active.turn = index + 1;
            await new Promise(resolve => setTimeout(resolve, 12_000));
            const started = performance.now();
            const requestId = `governance-${test.id}-${crypto.randomUUID()}`;
            const response = await api(`/agent-api/sessions/${session.session_id}/prompt`, {protocol_version: 3, request_id: requestId, message: turn.question});
            const stream = await response.text();
            const events = stream.split('\n\n').flatMap(frame => {
              const data = frame.split('\n').find(line => line.startsWith('data:'));
              if (!data) return [];
              try {return [JSON.parse(data.slice(5))];} catch {return [];}
            });
            const terminal = events.findLast(event => event.run_status);
            const snapshot = events.findLast(event => Array.isArray(event.messages));
            const messages = (snapshot?.messages ?? []).slice(previousMessages);
            previousMessages = snapshot?.messages?.length ?? previousMessages;
            const tools = messages.filter(message => message.role === 'tool');
            const answer = messages.findLast(message => message.role === 'assistant' && !message.tools?.length)?.text ?? '';
            const errors = [];
            if (terminal?.run_status !== 'completed') errors.push(`运行未完成:${terminal?.run_status ?? 'missing'}`);
            if (!answer) errors.push('无最终正文');
            if (/本轮工具调用参数连续|尚未取得可核验|自动核验仍未完成/.test(answer)) errors.push('最终交付失败');
            const details = tools.map(tool => tool.details).filter(Boolean);
            const target = details.findLast(d => turn.kind === 'coverage' ? d.kind === 'data_availability' && d.status === 'succeeded'
              : turn.kind === 'query' || turn.kind === 'read' ? ['metric_ask', 'metric_query_structured', 'metric_read'].includes(d.kind) && d.status === 'succeeded'
              : turn.kind === 'clarify' ? ['clarification_required', 'context_required'].includes(d.status)
              : turn.kind === 'catalog' ? d.kind === 'metric_catalog_overview' : false);
            if (['query','read','coverage','clarify','catalog'].includes(turn.kind) && !target) errors.push(`缺少预期回执:${turn.kind}`);
            if (turn.action && !tools.some(t => t.tool === 'metric_ask')) errors.push('缺少目标动作工具:metric_ask');
            if (turn.tool && !tools.some(t => t.tool === turn.tool)) errors.push(`缺少目标工具:${turn.tool}`);
            if (turn.noQuery && tools.some(t => ['metric_ask','metric_query_structured','metric_calculate'].includes(t.tool))) errors.push('不应执行数值查询');
            const result = {index: index + 1, request_id: requestId, expected: turn, elapsed_ms: Math.round(performance.now() - started),
              tools: tools.map(t => ({name: t.tool, id: t.tool_call_id, error: t.is_error, status: t.details?.status,
                task_id: t.details?.task_id, result_id: t.details?.result_id, error_code: t.details?.error_code})),
              terminal: terminal?.run_status, timings_ms: terminal?.timings_ms, errors, passed: false};
            report.turns.push(result);
            if (target && turn.kind === 'coverage') {
              result.request = target.request;
              for (const key of ['dimension','start','end','page','page_size']) if (turn[key] !== undefined && target.request?.[key] !== turn[key]) errors.push(`覆盖条件错误:${key}`);
              if (turn.orgs && !sameSet(target.request?.org_codes, turn.orgs)) errors.push('覆盖机构错误');
              const reference = await json('/api/v1/data-availability', target.request);
              if (!equal(reference.items, target.items) || !equal(reference.groups, target.groups)) errors.push('覆盖回执与实时只读接口不一致');
              result.coverage_checked = true;
            }
            if (target && ['query','read'].includes(turn.kind)) {
              const page = await json(`/api/v1/query-tasks/${target.task_id}/result?offset=0&limit=100`);
              const dsl = page.evidence?.logical_dsl;
              result.query = dsl;
              result.task_id = target.task_id;
              result.row_count = page.row_count;
              result.truncated = page.truncated;
              // 只导出事实指纹与条件，原始金额留在受鉴权业务记录中。
              result.facts_hash = await hash(JSON.stringify((page.facts ?? []).map(f => [f.metric_code,f.org_code,f.date,f.value,f.unit]).sort()));
              if (!dsl) errors.push('缺少正式执行条件');
              if (turn.orgs && !sameSet(dsl?.orgs, turn.orgs)) errors.push('取值机构错误');
              if (turn.metrics && !sameSet(dsl?.metrics, turn.metrics)) errors.push('取值指标错误');
              if (turn.start && dsl?.time?.start !== turn.start) errors.push('起始日期错误');
              if (turn.end && dsl?.time?.end !== turn.end) errors.push('结束日期错误');
              if (turn.hasRows && page.row_count < 1) errors.push('预期真实有值但返回零行');
              if (turn.empty && page.row_count !== 0) errors.push('预期无数据');
              if (turn.readIndex !== undefined && target.task_id !== queryTasks[turn.readIndex]) errors.push('回读来源错误');
              if (turn.kind === 'read' && tools.some(t => ['metric_ask','metric_query_structured'].includes(t.tool))) errors.push('回读被变成重新取数');
              queryTasks.push(target.task_id);
            }
            if (turn.kind === 'unsupported' && !/不支持|(?:未|不|暂不)提供|无法.*(?:分析|预测)|不能.*(?:分析|预测)/.test(answer)) errors.push('未明确说明能力边界');
            if (turn.kind === 'confirm' && !/明确|确认|请.*(?:补充|说明)|[？?]/.test(answer)) errors.push('应先明确上下文');
            if (turn.kind === 'confirm' && tools.some(t => t.details?.status === 'succeeded' && ['metric_ask','metric_query_structured'].includes(t.tool))) errors.push('失败后静默回退取数');
            // 模拟刷新读取：验证 HTTP 历史与本轮最终快照一致。
            const reopened = await json(`/agent-api/sessions/${session.session_id}`);
            const replayAnswer = reopened.messages?.findLast(m => m.role === 'assistant' && !m.tools?.length)?.text;
            result.history_restored = replayAnswer === answer;
            if (!result.history_restored) errors.push('历史恢复正文不一致');
            result.passed = errors.length === 0;
          }
          report.passed = report.turns.every(turn => turn.passed);
        } catch (error) {report.error = error instanceof Error ? error.message : String(error);}
        state.results.push(report);
        state.running = false;
        state.active = null;
      })();
      return {started: test.id};
    },
  };
  return {ready: true};
})()
