/** 《问数与多轮上下文重构研发说明》第 6 节验收（含 A1—A8 澄清与多轮续接回归）。
 *
 * 真实模型（loadConfig 读 .env）+ 真实 Python 目录解析/日历（clarification-acceptance-fixture.py）
 * + 隔离合成目录/机构/数据桩（固定业务日 2026-10-17），不连接真实业务库。
 * 统一语义入口后无独立准入链：basicQueries 只携带规范化 BasicQuerySpec，执行授权为 task.permit。
 * 默认不带 --live 只校验 fixture 合法性；带 --live 才调真实模型。
 * 同一用例失败可重跑至多 2 次以区分模型偶发偏离；持续失败如实记录为缺陷。
 */
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {mkdir, mkdtemp, readFile, writeFile} from 'node:fs/promises';
import {dirname, join, resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {BACKGROUND_CONTEXT} from '@earendil-works/pi-agent-core';
import type {BackendClient, BackendUser} from '../src/backendClient.js';
import {BackendApiError} from '../src/backendClient.js';
import type {SemanticFeedback} from '../src/semantic-task/feedback.js';

const LIVE = process.argv.includes('--live');
const arg = (key: string, fallback: string) => process.argv.find(x => x.startsWith(`--${key}=`))?.slice(key.length + 3) ?? fallback;
const selected = new Set(arg('cases', '').split(',').filter(Boolean));
const reportPath = resolve(arg('report', '../docs/verification/clarification-acceptance-20261017.json'));
const guardMs = Number(arg('guard-ms', '150000'));
const maxAttempts = Number(arg('attempts', '1'));
const fixture = join(import.meta.dirname, 'clarification-acceptance-fixture.py');
const pythonPath = resolve('../backend-next/.venv/bin/python');

const cache = new Map<string, any>();
function python(payload: Record<string, unknown>) {
  const key = JSON.stringify(payload);
  if (payload.action !== 'query' && cache.has(key)) return structuredClone(cache.get(key));
  const out = JSON.parse(execFileSync(pythonPath, [fixture], {input: key, encoding: 'utf8', timeout: 30000,
    maxBuffer: 8 * 1024 * 1024, env: {PATH: '/usr/bin:/bin:/opt/homebrew/bin'}}));
  if (!out.ok) throw new BackendApiError(422, out.message, out.error);
  if (payload.action !== 'query') cache.set(key, out.value);
  return out.value;
}

/** 与 fixture 一致的合成目录镜像（仅用于检索工具桩与标签→编码映射）。 */
const ORGS = [
  {code: 'SYNTH_WX', name: '无锡农商行', aliases: ['无锡']},
  {code: 'SYNTH_JY', name: '江阴农商行', aliases: ['江阴']},
  {code: 'SYNTH_QD', name: '启东农商行', aliases: ['启东']},
  {code: 'SYNTH_HA', name: '海安农商行', aliases: ['海安']},
  {code: 'SYNTH_HM', name: '海门农商行', aliases: ['海门']},
  {code: 'SYNTH_TX', name: '泰兴农商行', aliases: ['泰兴']},
  {code: 'SYNTH_TZ', name: '泰州农商行', aliases: ['泰州']},
  {code: 'SYNTH_ZJG', name: '张家港行', aliases: ['张家港', '张家港农商行']},
  {code: 'SYNTH_DF', name: '大丰农商行', aliases: ['大丰']},
  {code: 'SYNTH_ZJ', name: '紫金农商行', aliases: ['紫金']},
  {code: 'SYNTH_HU1', name: '华宁农商行', aliases: ['华宁']},
  {code: 'SYNTH_HU2', name: '华兴农商行', aliases: ['华兴']},
  {code: 'SYNTH_HU3', name: '华安农商行', aliases: ['华安']},
  {code: 'SYNTH_HU4', name: '华丰农商行', aliases: ['华丰']},
  {code: 'SYNTH_HU5', name: '华通农商行', aliases: ['华通']},
];
const METRICS = [
  {metric_code: 'SYNTH_DEP:D', metric_name: '对公协定存款余额当日数', unit: '元'},
  {metric_code: 'SYNTH_DEP:M', metric_name: '对公协定存款余额较上月', unit: '元'},
  {metric_code: 'SYNTH_PROFIT:D', metric_name: '净利润金额当日数', unit: '元'},
  {metric_code: 'SYNTH_DDA:D', metric_name: '个人活期存款余额当日数', unit: '元'},
  {metric_code: 'SYNTH_CREDIT:D', metric_name: '信贷客户数量当日数', unit: '户'},
];
const M = {DEP_D: 'SYNTH_DEP:D', DEP_M: 'SYNTH_DEP:M', PROFIT_D: 'SYNTH_PROFIT:D', DDA_D: 'SYNTH_DDA:D'};
const O = {WX: 'SYNTH_WX', JY: 'SYNTH_JY', QD: 'SYNTH_QD', HA: 'SYNTH_HA', HM: 'SYNTH_HM', TX: 'SYNTH_TX', ZJG: 'SYNTH_ZJG', DF: 'SYNTH_DF', HU1: 'SYNTH_HU1'};
const codeByName = (name: string) => ORGS.find(item => item.name === name)?.code;

function validateFixtures() {
  const wx = python({action: 'resolve', entity: 'organization', raw: ['无锡'], source: {business_date: '2026-10-17'}});
  assert.equal(wx.status, 'resolved'); assert.deepEqual(wx.value.codes, [O.WX]);
  const hai = python({action: 'resolve', entity: 'organization', raw: ['海'], source: {business_date: '2026-10-17'}});
  assert.equal(hai.status, 'ambiguous');
  assert.deepEqual(hai.candidates.map((c: any) => c.code).sort(), [O.HA, O.HM].sort());
  const hua = python({action: 'resolve', entity: 'organization', raw: ['华'], source: {business_date: '2026-10-17'}});
  assert.equal(hua.candidates.length, 5, '华 组须有 5 个候选以覆盖展示上限回归');
  const typo = python({action: 'resolve', entity: 'organization', raw: ['启动'], source: {business_date: '2026-10-17'}});
  assert.equal(typo.status, 'resolved'); assert.deepEqual(typo.value.codes, [O.QD]);
  assert.equal(typo.metadata.resolution_source, 'corrected');
  // 整句精确覆盖：’大聪明‘ 不产生大丰义务。
  const a4 = python({action: 'inspect', question: '张家港行今年3月末大聪明有多少？', business_date: '2026-10-17'});
  assert.deepEqual(a4.fragments[0].organizations, [O.ZJG]);
  assert.deepEqual(a4.fragments[0].calendar.ranges, [{start: '2026-03-31', end: '2026-03-31'}]);
  const mentions = python({action: 'mentions', question: '查询无锡2026年5月31日的对公协定存款余额。'});
  const group = mentions.mentions.find((m: any) => m.group?.base_name === '对公协定存款余额');
  assert(group, '基础名称须命中对公协定存款余额组');
  const day = python({action: 'resolve', entity: 'date', raw: ['2026年5月31日'], source: {business_date: '2026-10-17'}});
  assert.deepEqual(day.value, {start: '2026-05-31', end: '2026-05-31'});
  const rows = python({action: 'query', spec: {metric_codes: [M.DDA_D], org_codes: [O.ZJG],
    time: {start: '2021-12-31', end: '2026-09-30'}, selection: 'all_in_range', operation: {kind: 'value'}}});
  assert.equal(rows.rows.length, 21, '区间数据桩须覆盖全部已有记录日期');
  // 新场景依赖的数据桩：未知名称不得纠错到相近实体；无数据日期返回零行。
  const unknown = python({action: 'resolve', entity: 'organization', raw: ['临水农商行'],
    source: {business_date: '2026-10-17'}});
  assert.equal(unknown.status, 'not_found', `未知机构不得命中相近实体 got ${unknown.status}`);
  const empty = python({action: 'query', spec: {metric_codes: [M.DEP_D], org_codes: [O.WX],
    time: {start: '2026-09-30', end: '2026-09-30'}, selection: 'exact', operation: {kind: 'value'}}});
  assert.equal(empty.rows.length, 0, '无数据日期桩须返回零行');
  console.log(JSON.stringify({status: 'fixtures_valid', model_called: false,
    orgs: ORGS.length, metrics: METRICS.length, range_rows: rows.rows.length}));
}

// ---------------------------------------------------------------- live 模式

type QueryRow = {spec: any; result_ref?: string; row_count?: number};
type Ctx = {
  formal?: SemanticFeedback; answer: string; queries: QueryRow[];
  pendingFields: string[]; savedQuestions: import("../src/semantic-task/questions.js").PendingQuestion[];
  resolves: Array<{entity: string; raw: string[]; suggested?: unknown; result: any}>;
  receipts: Array<{name: string; details: unknown; is_error: boolean}>;
  /** 语义任务目标字段（含 resolvedValue），用于断言已保存条件的实际解析值而非展示原文。 */
  planFields?: Record<string, any>;
  /** 焦点 Frame 字段，澄清中间态解析值的兜底来源。 */
  frameFields?: Record<string, any>;
  state: Record<string, unknown>;
};
type ClickAnswer = {question_id: string; version: number; choice: {type: string; option_ids?: string[]}};
type Turn = {message: string | ((state: Record<string, unknown>) => string);
  /** 固定 request_id：与上一轮同 ID 同输入时宿主只回放原操作，用于同请求 ID 幂等断言。 */
  requestId?: string;
  /** 页面选项（click 通道）结构化回答；message 传空串时仅携带 answers。 */
  answers?: (state: Record<string, unknown>) => ClickAnswer[];
  expect: (ctx: Ctx) => void};
type Scenario = {id: string; refreshBefore?: number; turns: Turn[]};

const userFields = (formal?: SemanticFeedback) =>
  [...new Set((formal?.issues ?? []).filter((i: any) => i.remediation === 'user').map((i: any) => i.field))].sort();
const orgQuestions = (formal?: SemanticFeedback) =>
  (formal?.pending_questions ?? []).filter((q: any) => q.scope?.field === 'organizations');
const conditions = (formal: SemanticFeedback | undefined, field: string) =>
  (formal?.state.targets ?? []).flatMap(t => t.conditions).filter(c => c.field === field);
/** 已保存条件的实际解析值（机构 codes / 时间 start-end），展示原文不足以判定时以此为准。 */
const resolvedOf = (ctx: Ctx, field: string) =>
  ctx.planFields?.[field]?.resolvedValue ?? ctx.frameFields?.[field]?.resolvedValue;

function assertNoQuery(ctx: Ctx) {assert.equal(ctx.queries.length, 0, 'NO_QUERY_EXPECTED');}
function assertQuery(ctx: Ctx, exp: {metrics: string[]; orgs: string[]; start?: string; end?: string;
  dates?: string[]; selection?: string}, count = 1) {
  assert.equal(ctx.queries.length, count, `QUERY_COUNT expected ${count} got ${ctx.queries.length}`);
  const spec = ctx.queries[0]!.spec;
  assert.deepEqual([...spec.metric_codes].sort(), [...exp.metrics].sort(), 'METRIC_CODES');
  assert.deepEqual([...spec.org_codes].sort(), [...exp.orgs].sort(), 'ORG_CODES');
  if (exp.dates) assert.deepEqual(spec.time.dates, exp.dates, 'TIME_DATES');
  else {assert.equal(spec.time.start, exp.start, 'TIME_START'); assert.equal(spec.time.end, exp.end, 'TIME_END');}
  if (exp.selection) assert.equal(spec.selection, exp.selection, 'SELECTION');
}
function assertNeedsUser(ctx: Ctx) {assert.equal(ctx.formal?.status, 'needs_user', `NEEDS_USER got ${ctx.formal?.status}`);}
/** 多目标整批断言：逐笔核对 (指标, 机构, 日期) 绑定，全局集合相同但目标错位不能放行。 */
function assertQueries(ctx: Ctx, expected: Array<{metrics: string[]; orgs: string[]; start: string; end: string}>) {
  assert.equal(ctx.queries.length, expected.length, `QUERY_COUNT expected ${expected.length} got ${ctx.queries.length}`);
  const tuple = (q: {metrics: string[]; orgs: string[]; start: string; end: string}) =>
    JSON.stringify([[...q.metrics].sort(), [...q.orgs].sort(), q.start, q.end]);
  const actual = ctx.queries.map(q => tuple({metrics: q.spec.metric_codes, orgs: q.spec.org_codes,
    start: q.spec.time.start, end: q.spec.time.end}));
  assert.deepEqual(actual.sort(), expected.map(tuple).sort(), 'EXACT_BOUND_TARGETS');
}

const scenarios: Scenario[] = [
  {id: 'A1', turns: [
    {message: '查询无锡2026年5月31日的对公协定存款余额。', expect: ctx => {
      // 完整基础名称唯一命中：默认当日数，不追问口径；默认口径须向用户回显。
      assert.equal(ctx.formal?.status, 'succeeded', `DEFAULT_BASIS_MUST_QUERY got ${ctx.formal?.status}`);
      assertQuery(ctx, {metrics: [M.DEP_D], orgs: [O.WX], start: '2026-05-31', end: '2026-05-31'});
      assert(ctx.answer.includes('当日数'), `DEFAULT_BASIS_ECHOED: ${ctx.answer.slice(0, 200)}`);
    }},
    {message: '改成较上月，其他条件不变。', expect: ctx => {
      assert.equal(ctx.formal?.status, 'succeeded');
      assertQuery(ctx, {metrics: [M.DEP_M], orgs: [O.WX], start: '2026-05-31', end: '2026-05-31'});
    }},
    {message: '6月末呢？', expect: ctx => {
      assert.equal(ctx.formal?.status, 'succeeded');
      assertQuery(ctx, {metrics: [M.DEP_M], orgs: [O.WX], start: '2026-06-30', end: '2026-06-30'});
    }},
    // 开发回归：完成请求重放不重复取数。
    {message: '把刚才的查询结果再展示一次，不要重新查。', expect: ctx => {
      assertNoQuery(ctx);
      assert(['succeeded', 'reused'].includes(ctx.formal?.status ?? ''), `REPLAY_NO_REQUERY got ${ctx.formal?.status}`);
    }},
  ]},
  {id: 'A2', refreshBefore: 2, turns: [
    {message: '查询海、泰2026年5月31日的对公协定存款余额当日数。', expect: ctx => {
      assertNeedsUser(ctx); assertNoQuery(ctx);
      const questions = orgQuestions(ctx.formal);
      assert(questions.length >= 1, 'ORG_QUESTION_PUBLISHED');
      ctx.state.haiLabels = questions.flatMap((q: any) => q.options.map((o: any) => o.label));
      for (const name of ['海安', '海门']) assert(ctx.answer.includes(name), `CANDIDATE_${name}_IN_ANSWER`);
      // “泰”组候选（泰兴/泰州）也须以文字呈现。
      assert(ctx.answer.includes('泰兴') || ctx.answer.includes('泰州'), `TAI_GROUP_IN_ANSWER: ${ctx.answer}`);
    }},
    {message: '“海”这一组选海安和海门，“泰”先不选。', expect: ctx => {
      // 部分回答：保留海安、海门与未决“泰”组，不取数。
      assertNeedsUser(ctx); assertNoQuery(ctx);
      const questions = orgQuestions(ctx.formal);
      assert(questions.length >= 1, 'TAI_GROUP_STILL_OPEN');
      const text = questions.map((q: any) => `${q.prompt}\n${q.options.map((o: any) => o.label).join('\n')}`).join('\n') + ctx.answer;
      assert(text.includes('泰兴'), 'TAI_GROUP_KEPT');
    }},
    {message: '“泰”选泰兴。', expect: ctx => {
      assert.equal(ctx.formal?.status, 'succeeded', `AFTER_REFRESH_RESUME got ${ctx.formal?.status}`);
      assertQuery(ctx, {metrics: [M.DEP_D], orgs: [O.HA, O.HM, O.TX], start: '2026-05-31', end: '2026-05-31'});
    }},
  ]},
  {id: 'A3', turns: [
    {message: '查询海2026年5月31日的对公协定存款余额当日数。', expect: ctx => {
      assertNeedsUser(ctx); assertNoQuery(ctx);
      const questions = orgQuestions(ctx.formal);
      assert(questions.length >= 1 && questions[0]!.options.length >= 2, 'HAI_OPTIONS_PUBLISHED');
      ctx.state.displayed = questions[0]!.options.map((o: any) => o.label);
    }},
    {message: '日期改成2026年4月30日，机构还没选。', expect: ctx => {
      // 日期里的数字不作为选择序号；精确值由 t3 的正式查询回执复核。
      assertNeedsUser(ctx); assertNoQuery(ctx);
      const time = resolvedOf(ctx, 'time');
      const display = conditions(ctx.formal, 'time').map(c => c.display).join('；');
      const updated = (time?.start === '2026-04-30' && time?.end === '2026-04-30')
        || /2026年4月30日|2026-04-30/.test(display);
      assert(updated, `DATE_UPDATED got ${JSON.stringify(time ?? display)}`);
      assert(orgQuestions(ctx.formal).length >= 1, 'ORG_STILL_OPEN');
    }},
    {message: '不是第一个，是第二个。', expect: ctx => {
      const displayed = ctx.state.displayed as string[];
      assert(displayed?.length >= 2, 'DISPLAYED_LIST_CAPTURED');
      const second = codeByName(displayed[1]!);
      assert(second, `SECOND_ITEM_KNOWN ${displayed[1]}`);
      assert.equal(ctx.formal?.status, 'succeeded', `SECOND_PICK_QUERY got ${ctx.formal?.status}`);
      assertQuery(ctx, {metrics: [M.DEP_D], orgs: [second!], start: '2026-04-30', end: '2026-04-30'});
    }},
  ]},
  {id: 'A4', turns: [
    {message: '张家港行今年3月末大聪明有多少？', expect: ctx => {
      assertNeedsUser(ctx); assertNoQuery(ctx);
      assert.deepEqual(userFields(ctx.formal), ['metrics'], 'ONLY_METRIC_MISSING');
      // 机构/日期已保存；精确值由 t2 的正式查询回执复核。
      const orgs = (resolvedOf(ctx, 'organizations') as {codes?: string[]} | undefined)?.codes;
      const orgDisplay = conditions(ctx.formal, 'organizations').map(c => c.display).join('；');
      assert(orgs ? orgs.join() === [O.ZJG].join() : orgDisplay.includes('张家港'),
        `ORG_SAVED got ${JSON.stringify(orgs ?? orgDisplay)}`);
      const time = resolvedOf(ctx, 'time');
      const timeDisplay = conditions(ctx.formal, 'time').map(c => c.display).join('；');
      const dateSaved = (time?.start === '2026-03-31' && time?.end === '2026-03-31')
        || /2026年3月31日|2026-03-31|今年3月末/.test(timeDisplay);
      assert(dateSaved, `DATE_SAVED got ${JSON.stringify(time ?? timeDisplay)}`);
      assert(!JSON.stringify(ctx.formal).includes(O.DF) && !ctx.answer.includes('大丰'), 'NO_DAFENG_OBLIGATION');
    }},
    {message: '指标是净利润金额当日数', expect: ctx => {
      assert.equal(ctx.formal?.status, 'succeeded', `METRIC_CONTINUATION got ${ctx.formal?.status}`);
      assertQuery(ctx, {metrics: [M.PROFIT_D], orgs: [O.ZJG], start: '2026-03-31', end: '2026-03-31'});
    }},
  ]},
  {id: 'A5a', turns: [
    {message: '查询张家港行个人活期存款余额当日数，2021年末到2026年9月末的全部已有记录。', expect: ctx => {
      assert.equal(ctx.formal?.status, 'succeeded', `RANGE got ${ctx.formal?.status}`);
      assertQuery(ctx, {metrics: [M.DDA_D], orgs: [O.ZJG], start: '2021-12-31', end: '2026-09-30', selection: 'all_in_range'});
    }},
  ]},
  {id: 'A5b', turns: [
    {message: '查询张家港行个人活期存款余额当日数，从去年最后一天到今年九月底的全部已有记录。', expect: ctx => {
      assert.equal(ctx.formal?.status, 'succeeded', `RELATIVE_RANGE got ${ctx.formal?.status}`);
      assertQuery(ctx, {metrics: [M.DDA_D], orgs: [O.ZJG], start: '2025-12-31', end: '2026-09-30', selection: 'all_in_range'});
    }},
  ]},
  {id: 'A5c', turns: [
    {message: '查询张家港行个人活期存款余额当日数，2026年五月和九月的最后一天。', expect: ctx => {
      assert.equal(ctx.formal?.status, 'succeeded', `DISCRETE got ${ctx.formal?.status}`);
      assertQuery(ctx, {metrics: [M.DDA_D], orgs: [O.ZJG], dates: ['2026-05-31', '2026-09-30']});
    }},
  ]},
  {id: 'A5d', turns: [
    // 反例：只解释右端的表达应拒绝执行。
    {message: '查询张家港行个人活期存款余额当日数，到2026年9月末的全部已有记录。', expect: ctx => {
      assertNoQuery(ctx);
      assert.notEqual(ctx.formal?.status, 'succeeded', 'RIGHT_ONLY_RANGE_MUST_NOT_EXECUTE');
      assert(userFields(ctx.formal).includes('time'), 'TIME_MUST_BE_ASKED');
    }},
  ]},
  {id: 'A6', turns: [
    {message: '查询张家港行近5年存款记录。', expect: ctx => {
      assertNeedsUser(ctx); assertNoQuery(ctx);
      const missing = userFields(ctx.formal);
      assert(missing.includes('metrics') && missing.every(field => ['metrics', 'selection'].includes(field)), 'ONLY_ACTUAL_MISSING_FIELDS_ASKED');
      // “存款记录”可明确为全部记录；已确定时直接保留，不能为了满足旧预期再制造追问。
      if (!missing.includes('selection')) assert.equal(resolvedOf(ctx, 'selection'), 'all_in_range', 'RECORDS_MEAN_ALL_IN_RANGE');
      assert(conditions(ctx.formal, 'organizations').some(c => c.display.includes('张家港')), 'ORG_SAVED');
    }},
    {message: '指标用个人活期存款余额当日数，查询全部已有记录，范围改为2021年末到2026年9月末。', expect: ctx => {
      assert.equal(ctx.formal?.status, 'succeeded', `SUPPLEMENT_RESUME got ${ctx.formal?.status}`);
      assertQuery(ctx, {metrics: [M.DDA_D], orgs: [O.ZJG], start: '2021-12-31', end: '2026-09-30', selection: 'all_in_range'});
    }},
  ]},
  {id: 'A7', turns: [
    {message: '查询无锡、江阴、启东2026年5月31日的对公协定存款余额当日数。', expect: ctx => {
      assert.equal(ctx.formal?.status, 'succeeded');
      assertQuery(ctx, {metrics: [M.DEP_D], orgs: [O.WX, O.JY, O.QD], start: '2026-05-31', end: '2026-05-31'});
    }},
    {message: '只看江阴', expect: ctx => {
      assert.equal(ctx.formal?.status, 'succeeded');
      assertQuery(ctx, {metrics: [M.DEP_D], orgs: [O.JY], start: '2026-05-31', end: '2026-05-31'});
    }},
    {message: '只看启动', expect: ctx => {
      assert.equal(ctx.formal?.status, 'succeeded', `TYPO_CORRECTION got ${ctx.formal?.status}`);
      assertQuery(ctx, {metrics: [M.DEP_D], orgs: [O.QD], start: '2026-05-31', end: '2026-05-31'});
      // 纠错前原值保留“启动”，经纠错链路归属启东并向用户明示。
      const correction = ctx.resolves.find(r => r.entity === 'organization' && r.raw.includes('启动')
        && r.result?.status === 'resolved' && r.result.value?.codes?.includes(O.QD));
      assert(correction, `RAW_VALUE_启动_RETAINED ${JSON.stringify(ctx.resolves.map(r => ({raw: r.raw, status: r.result?.status})))}`);
      assert.equal(correction!.result.metadata?.resolution_source, 'corrected', 'CORRECTION_EXPLICIT');
      assert(ctx.answer.includes('启东'), 'CORRECTION_DISCLOSED_TO_USER');
    }},
    {message: '6月末呢？', expect: ctx => {
      assert.equal(ctx.formal?.status, 'succeeded');
      assertQuery(ctx, {metrics: [M.DEP_D], orgs: [O.QD], start: '2026-06-30', end: '2026-06-30'});
    }},
  ]},
  {id: 'A8', turns: [
    {message: '查询海2026年5月31日的对公协定存款余额当日数。', expect: ctx => {
      assertNeedsUser(ctx); assertNoQuery(ctx);
      ctx.state.displayed = orgQuestions(ctx.formal)[0]?.options.map((o: any) => o.label);
    }},
    {message: '都不是，改成江阴农商行，其他条件不变。', expect: ctx => {
      assert.equal(ctx.formal?.status, 'succeeded', `NONE_OF_THESE_REDIRECT got ${ctx.formal?.status}`);
      assertQuery(ctx, {metrics: [M.DEP_D], orgs: [O.JY], start: '2026-05-31', end: '2026-05-31'});
    }},
  ]},
  // 开发回归：候选 >4 项按相似度收敛展示 4 项；未展示项序号不可选；完整合法名称可独立解析。
  {id: 'R1-candidate-cap', turns: [
    {message: '查询华2026年5月31日的对公协定存款余额当日数。', expect: ctx => {
      assertNeedsUser(ctx); assertNoQuery(ctx);
      const question = orgQuestions(ctx.formal)[0];
      assert(question, 'HUA_QUESTION_PUBLISHED');
      assert(question!.options.length <= 4 && question!.options.length >= 1,
        `DISPLAY_CAP_4 got ${question!.options.length}`);
      const displayed = question!.options.map((o: any) => o.label);
      ctx.state.displayed = displayed;
      const all = python({action: 'resolve', entity: 'organization', raw: ['华'],
        source: {business_date: '2026-10-17'}}).candidates.map((c: any) => c.value as string);
      assert.equal(all.length, 5, 'FULL_CATALOG_KEPT');
      const unshown = all.filter(name => !displayed.includes(name));
      assert.equal(unshown.length, all.length - displayed.length, 'UNSHOWN_COMPUTABLE');
      ctx.state.unshown = unshown[0];
    }},
    {message: '选第五个', expect: ctx => {
      // 未展示项不能通过序号选中。
      assertNoQuery(ctx);
      // 解释越界选择可以直接回答；必须核对已保存问题仍待答，不能只要求某个工具状态码。
      assert(ctx.pendingFields.includes('organizations'), 'UNSHOWN_INDEX_STILL_PENDING');
      const saved = ctx.savedQuestions.find(question => question.scope.field === 'organizations');
      assert(saved, 'ORIGINAL_QUESTION_STILL_OPEN');
      assert.deepEqual(saved.options.map(option => option.label), ctx.state.displayed, 'DISPLAYED_OPTIONS_UNCHANGED');
      assert.notEqual(resolvedOf(ctx, 'organizations')?.codes?.length > 0, true, 'UNSHOWN_INDEX_NOT_APPLIED');
    }},
    {message: state => `那改成${state.unshown as string}。`, expect: ctx => {
      const code = codeByName(ctx.state.unshown as string);
      assert(code, 'UNSHOWN_NAME_KNOWN');
      assert.equal(ctx.formal?.status, 'succeeded', `FULL_NAME_INDEPENDENT_RESOLUTION got ${ctx.formal?.status}`);
      assertQuery(ctx, {metrics: [M.DEP_D], orgs: [code!], start: '2026-05-31', end: '2026-05-31'});
    }},
  ]},
  // 开发回归补充：未展示项的完整合法名称可独立解析（不经候选序号）。
  {id: 'R2-fullname-independent', turns: [
    {message: '查询华2026年5月31日的对公协定存款余额当日数。', expect: ctx => {
      assertNeedsUser(ctx); assertNoQuery(ctx);
      const question = orgQuestions(ctx.formal)[0];
      assert(question && question.options.length <= 4, 'DISPLAY_CAP_4');
      ctx.state.displayed = question!.options.map((o: any) => o.label);
      const all = python({action: 'resolve', entity: 'organization', raw: ['华'],
        source: {business_date: '2026-10-17'}}).candidates.map((c: any) => c.value as string);
      ctx.state.unshown = all.find(name => !(ctx.state.displayed as string[]).includes(name));
      assert(ctx.state.unshown, 'UNSHOWN_EXISTS');
    }},
    {message: state => `都不是，机构改成${state.unshown as string}。`, expect: ctx => {
      const code = codeByName(ctx.state.unshown as string);
      assert(code, 'UNSHOWN_NAME_KNOWN');
      assert.equal(ctx.formal?.status, 'succeeded', `FULL_NAME_INDEPENDENT_RESOLUTION got ${ctx.formal?.status}`);
      assertQuery(ctx, {metrics: [M.DEP_D], orgs: [code!], start: '2026-05-31', end: '2026-05-31'});
    }},
  ]},
  // —— 第 6 节补齐场景（B 系列）：单缺项、未知机构、集合变更、单字段替换、多目标绑定、
  // 未决修改续接、新问题、指代歧义、无数据重查与页面选项回答。 ——
  // 缺日期：机构+指标已给出，只追问日期；补齐后查询，再次续问继承。
  {id: 'B1-missing-date', turns: [
    {message: '查询无锡的对公协定存款余额当日数。', expect: ctx => {
      assertNeedsUser(ctx); assertNoQuery(ctx);
      assert.deepEqual(userFields(ctx.formal), ['time'], 'ONLY_TIME_MISSING');
      const orgs = (resolvedOf(ctx, 'organizations') as {codes?: string[]} | undefined)?.codes;
      const orgDisplay = conditions(ctx.formal, 'organizations').map(c => c.display).join('；');
      assert(orgs ? orgs.join() === [O.WX].join() : orgDisplay.includes('无锡'), `ORG_SAVED got ${JSON.stringify(orgs ?? orgDisplay)}`);
    }},
    {message: '日期用2026年5月31日。', expect: ctx => {
      assert.equal(ctx.formal?.status, 'succeeded', `DATE_SUPPLEMENT got ${ctx.formal?.status}`);
      assertQuery(ctx, {metrics: [M.DEP_D], orgs: [O.WX], start: '2026-05-31', end: '2026-05-31'});
    }},
    {message: '那6月末呢？', expect: ctx => {
      assert.equal(ctx.formal?.status, 'succeeded');
      assertQuery(ctx, {metrics: [M.DEP_D], orgs: [O.WX], start: '2026-06-30', end: '2026-06-30'});
    }},
  ]},
  // 缺机构：指标+日期已给出，只追问机构；补齐后查询，续问换机构其他条件保留。
  {id: 'B2-missing-org', turns: [
    {message: '查询2026年5月31日的对公协定存款余额当日数。', expect: ctx => {
      assertNeedsUser(ctx); assertNoQuery(ctx);
      assert.deepEqual(userFields(ctx.formal), ['organizations'], 'ONLY_ORG_MISSING');
    }},
    {message: '机构用无锡。', expect: ctx => {
      assert.equal(ctx.formal?.status, 'succeeded', `ORG_SUPPLEMENT got ${ctx.formal?.status}`);
      assertQuery(ctx, {metrics: [M.DEP_D], orgs: [O.WX], start: '2026-05-31', end: '2026-05-31'});
    }},
    {message: '换成江阴呢？', expect: ctx => {
      assert.equal(ctx.formal?.status, 'succeeded');
      assertQuery(ctx, {metrics: [M.DEP_D], orgs: [O.JY], start: '2026-05-31', end: '2026-05-31'});
    }},
  ]},
  // 机构名称不存在：不命中、不纠错到相近实体；用户给出正确名称后继续完成。
  {id: 'B3-unknown-org', turns: [
    {message: '查询临水农商行2026年5月31日的对公协定存款余额当日数。', expect: ctx => {
      assertNeedsUser(ctx); assertNoQuery(ctx);
      assert(userFields(ctx.formal).includes('organizations'), 'ORG_MUST_BE_ASKED');
      // 不能用相近实体替代用户机构。
      const orgs = (resolvedOf(ctx, 'organizations') as {codes?: string[]} | undefined)?.codes ?? [];
      assert.deepEqual(orgs, [], `NO_SUBSTITUTION got ${JSON.stringify(orgs)}`);
      assert(!ctx.answer.includes('大丰农商行是'), `NO_NEARBY_ENTITY_SUBSTITUTION: ${ctx.answer.slice(0, 200)}`);
    }},
    {message: '机构是大丰农商行。', expect: ctx => {
      assert.equal(ctx.formal?.status, 'succeeded', `CLARIFIED_ORG_QUERY got ${ctx.formal?.status}`);
      assertQuery(ctx, {metrics: [M.DEP_D], orgs: [O.DF], start: '2026-05-31', end: '2026-05-31'});
    }},
  ]},
  // 集合变更：三家 → 去掉一家+改月份 → 重复排除不阻断 → 加回成员取并集；指标不变。
  {id: 'B4-set-change', turns: [
    {message: '查询无锡、江阴、启东2026年5月31日的对公协定存款余额当日数。', expect: ctx => {
      assert.equal(ctx.formal?.status, 'succeeded');
      assertQuery(ctx, {metrics: [M.DEP_D], orgs: [O.WX, O.JY, O.QD], start: '2026-05-31', end: '2026-05-31'});
    }},
    {message: '去掉江阴，日期改成六月末。', expect: ctx => {
      assert.equal(ctx.formal?.status, 'succeeded', `EXCLUDE_AND_TIME_CHANGE got ${ctx.formal?.status}`);
      assertQuery(ctx, {metrics: [M.DEP_D], orgs: [O.WX, O.QD], start: '2026-06-30', end: '2026-06-30'});
    }},
    {message: '再去掉一次江阴。', expect: ctx => {
      // 重复排除：目标成员已不在集合，条件无变化，不阻断也不重复取数。
      assertNoQuery(ctx);
      assert(['succeeded', 'reused'].includes(ctx.formal?.status ?? ''), `REPEATED_EXCLUDE_NOT_BLOCKED got ${ctx.formal?.status}`);
      const orgs = (resolvedOf(ctx, 'organizations') as {codes?: string[]} | undefined)?.codes;
      if (orgs) assert.deepEqual([...orgs].sort(), [O.WX, O.QD].sort(), 'SET_UNCHANGED');
    }},
    {message: '把江阴再加回来。', expect: ctx => {
      assert.equal(ctx.formal?.status, 'succeeded', `ADD_BACK_UNION got ${ctx.formal?.status}`);
      assertQuery(ctx, {metrics: [M.DEP_D], orgs: [O.WX, O.JY, O.QD], start: '2026-06-30', end: '2026-06-30'});
    }},
  ]},
  // 单字段替换：三家 → 只看江阴 → 改成无锡；仅机构字段变化，指标与日期准确保留。
  {id: 'B5-single-replace', turns: [
    {message: '查询无锡、江阴、启东2026年5月31日的对公协定存款余额当日数。', expect: ctx => {
      assert.equal(ctx.formal?.status, 'succeeded');
      assertQuery(ctx, {metrics: [M.DEP_D], orgs: [O.WX, O.JY, O.QD], start: '2026-05-31', end: '2026-05-31'});
    }},
    {message: '只看江阴。', expect: ctx => {
      assert.equal(ctx.formal?.status, 'succeeded');
      assertQuery(ctx, {metrics: [M.DEP_D], orgs: [O.JY], start: '2026-05-31', end: '2026-05-31'});
    }},
    {message: '改成无锡。', expect: ctx => {
      assert.equal(ctx.formal?.status, 'succeeded', `REPLACE_SINGLE_ORG got ${ctx.formal?.status}`);
      assertQuery(ctx, {metrics: [M.DEP_D], orgs: [O.WX], start: '2026-05-31', end: '2026-05-31'});
    }},
  ]},
  // 多目标绑定：无锡五月、江阴六月 → 交换日期；全局日期集合相同也不能误放行，须逐目标核对。
  {id: 'B6-swap-dates', turns: [
    {message: '查询无锡2026年5月31日的对公协定存款余额当日数；江阴2026年6月30日的对公协定存款余额当日数。', expect: ctx => {
      assert.equal(ctx.formal?.status, 'succeeded', `BOUND_TARGETS got ${ctx.formal?.status}`);
      assertQueries(ctx, [
        {metrics: [M.DEP_D], orgs: [O.WX], start: '2026-05-31', end: '2026-05-31'},
        {metrics: [M.DEP_D], orgs: [O.JY], start: '2026-06-30', end: '2026-06-30'},
      ]);
    }},
    {message: '把无锡和江阴的日期交换一下。', expect: ctx => {
      assert.equal(ctx.formal?.status, 'succeeded', `SWAP_DATES got ${ctx.formal?.status}`);
      assertQueries(ctx, [
        {metrics: [M.DEP_D], orgs: [O.WX], start: '2026-06-30', end: '2026-06-30'},
        {metrics: [M.DEP_D], orgs: [O.JY], start: '2026-05-31', end: '2026-05-31'},
      ]);
    }},
  ]},
  // 未决修改续接：新机构未定 → 先改日期（其他字段）→ 补齐机构；不回退旧值执行，每项有效修改保留。
  {id: 'B7-pending-change', turns: [
    {message: '查询无锡2026年5月31日的对公协定存款余额当日数。', expect: ctx => {
      assert.equal(ctx.formal?.status, 'succeeded');
      assertQuery(ctx, {metrics: [M.DEP_D], orgs: [O.WX], start: '2026-05-31', end: '2026-05-31'});
    }},
    {message: '机构改成华。', expect: ctx => {
      // 新机构值未定：保存未决修改并追问，不得按旧机构执行。
      assertNeedsUser(ctx); assertNoQuery(ctx);
      assert(orgQuestions(ctx.formal).length >= 1, 'HUA_GROUP_OPEN');
    }},
    {message: '日期改成六月末。', expect: ctx => {
      // 未决机构未补齐前，修改其他字段只更新条件，不触发执行。
      assertNeedsUser(ctx); assertNoQuery(ctx);
      const time = resolvedOf(ctx, 'time');
      const display = conditions(ctx.formal, 'time').map(c => c.display).join('；');
      const updated = (time?.start === '2026-06-30' && time?.end === '2026-06-30')
        || /2026年6月30日|2026-06-30|六月末/.test(display);
      assert(updated, `DATE_UPDATED_WHILE_PENDING got ${JSON.stringify(time ?? display)}`);
      assert(orgQuestions(ctx.formal).length >= 1, 'ORG_STILL_PENDING');
    }},
    {message: '机构选华宁。', expect: ctx => {
      assert.equal(ctx.formal?.status, 'succeeded', `PENDING_RESUMED got ${ctx.formal?.status}`);
      assertQuery(ctx, {metrics: [M.DEP_D], orgs: [O.HU1], start: '2026-06-30', end: '2026-06-30'});
    }},
  ]},
  // 新问题明确不沿用：不带入旧指标/机构/日期，独立成新任务。
  {id: 'B8-new-question', turns: [
    {message: '查询无锡2026年5月31日的对公协定存款余额当日数。', expect: ctx => {
      assert.equal(ctx.formal?.status, 'succeeded');
      assertQuery(ctx, {metrics: [M.DEP_D], orgs: [O.WX], start: '2026-05-31', end: '2026-05-31'});
    }},
    {message: '换个问题：查海安2026年3月31日的净利润金额当日数，和之前的查询无关。', expect: ctx => {
      assert.equal(ctx.formal?.status, 'succeeded', `INDEPENDENT_NEW_QUESTION got ${ctx.formal?.status}`);
      assertQuery(ctx, {metrics: [M.PROFIT_D], orgs: [O.HA], start: '2026-03-31', end: '2026-03-31'});
    }},
  ]},
  // 指代歧义：两笔历史任务下“那一笔”无法唯一确定 → 追问并保留修改意图；指明后只改该笔。
  {id: 'B9-ambiguous-reference', turns: [
    {message: '查询无锡2026年5月31日的对公协定存款余额当日数。', expect: ctx => {
      assert.equal(ctx.formal?.status, 'succeeded');
      assertQuery(ctx, {metrics: [M.DEP_D], orgs: [O.WX], start: '2026-05-31', end: '2026-05-31'});
    }},
    {message: '另外新查江阴2026年3月31日的净利润金额当日数。', expect: ctx => {
      assert.equal(ctx.formal?.status, 'succeeded', `SECOND_TASK got ${ctx.formal?.status}`);
      assertQuery(ctx, {metrics: [M.PROFIT_D], orgs: [O.JY], start: '2026-03-31', end: '2026-03-31'});
    }},
    {message: '把那一笔的日期改成4月30日。', expect: ctx => {
      // “那一笔”有两个合理对象：追问而不擅选，不执行任何修改。
      assertNoQuery(ctx);
      assert.notEqual(ctx.formal?.status, 'succeeded', 'AMBIGUOUS_REFERENCE_MUST_NOT_EXECUTE');
      assert(ctx.answer.includes('哪') || ctx.answer.includes('无锡') || ctx.answer.includes('江阴'),
        `AMBIGUITY_ASKED: ${ctx.answer.slice(0, 200)}`);
    }},
    {message: '无锡那一笔。', expect: ctx => {
      assert.equal(ctx.formal?.status, 'succeeded', `DISAMBIGUATED got ${ctx.formal?.status}`);
      // 仅修改无锡这一笔；江阴任务不重新取数。
      assertQuery(ctx, {metrics: [M.DEP_D], orgs: [O.WX], start: '2026-04-30', end: '2026-04-30'});
    }},
  ]},
  // 无数据与重新查询：指定日期无数据不换日期、不伪造数值；明确重查产生新查询；同请求 ID 不重复执行。
  {id: 'B10-no-data-requery', turns: [
    {message: '查询无锡2026年9月30日的对公协定存款余额当日数。', expect: ctx => {
      assert.equal(ctx.queries.length, 1, `NO_DATA_ONE_QUERY got ${ctx.queries.length}`);
      const spec = ctx.queries[0]!.spec;
      assert.equal(spec.time.start, '2026-09-30', 'NO_DATA_KEEPS_REQUESTED_DATE');
      assert.equal(spec.time.end, '2026-09-30', 'NO_DATA_KEEPS_REQUESTED_DATE_END');
      assert.equal(ctx.queries[0]!.row_count, 0, `NO_DATA_ZERO_ROWS got ${ctx.queries[0]!.row_count}`);
      assert(/无数据|无记录|没有数据|没有记录|暂无匹配数据|无匹配数据|未查询到|0\s*[条行]/.test(ctx.answer),
        `NO_DATA_DISCLOSED_NOT_FABRICATED: ${ctx.answer.slice(0, 200)}`);
    }},
    {message: '按原条件重新查一次。', requestId: 'B10-requery', expect: ctx => {
      // 明确重新查询产生一次新执行，条件不变。
      assertQuery(ctx, {metrics: [M.DEP_D], orgs: [O.WX], start: '2026-09-30', end: '2026-09-30'});
    }},
    {message: '按原条件重新查一次。', requestId: 'B10-requery', expect: ctx => {
      // 同请求 ID 同输入：宿主只回放原操作，不重复执行。
      assertNoQuery(ctx);
      assert(['succeeded', 'reused'].includes(ctx.formal?.status ?? ''), `IDEMPOTENT_REPLAY got ${ctx.formal?.status}`);
    }},
  ]},
  // 页面选项回答：候选用 click 通道结构化 answers 选择，与文字回答对应同一候选身份。
  {id: 'B11-click-answer', turns: [
    {message: '查询海2026年5月31日的对公协定存款余额当日数。', expect: ctx => {
      assertNeedsUser(ctx); assertNoQuery(ctx);
      const question = orgQuestions(ctx.formal)[0];
      assert(question && question.options.length >= 2, 'HAI_OPTIONS_PUBLISHED');
      const haimen = question.options.find((o: any) => String(o.label).includes('海门'));
      assert(haimen, 'HAIMEN_OPTION_PRESENT');
      ctx.state.click = {question_id: question.question_id, version: question.version,
        option_id: haimen.option_id, label: haimen.label};
    }},
    {message: '', answers: state => {
      const click = state.click as {question_id: string; version: number; option_id: string};
      return [{question_id: click.question_id, version: click.version,
        choice: {type: 'select', option_ids: [click.option_id]}}];
    }, expect: ctx => {
      const click = ctx.state.click as {label: string};
      // 选项标签可能是全称或简称，按名称/别名映射回正式编码。
      const code = codeByName(click.label)
        ?? ORGS.find(o => click.label.includes(o.name) || o.aliases.some(a => click.label.includes(a)))?.code;
      assert(code, `CLICK_LABEL_KNOWN ${click.label}`);
      assert.equal(ctx.formal?.status, 'succeeded', `CLICK_ANSWER_QUERY got ${ctx.formal?.status}`);
      assertQuery(ctx, {metrics: [M.DEP_D], orgs: [code!], start: '2026-05-31', end: '2026-05-31'});
    }},
    {message: '那6月末呢？', expect: ctx => {
      assert.equal(ctx.formal?.status, 'succeeded');
      assertQuery(ctx, {metrics: [M.DEP_D], orgs: [O.HM], start: '2026-06-30', end: '2026-06-30'});
    }},
  ]},
  {id: 'B12-history-ordinal', turns: [
    {message: '查询无锡2026年5月31日的对公协定存款余额当日数。', expect: ctx => {
      assert.equal(ctx.formal?.status, 'succeeded');
      assertQuery(ctx, {metrics: [M.DEP_D], orgs: [O.WX], start: '2026-05-31', end: '2026-05-31'});
    }},
    {message: '另外单独查询江阴2026年6月30日的净利润金额当日数。', expect: ctx => {
      assert.equal(ctx.formal?.status, 'succeeded');
      assertQuery(ctx, {metrics: [M.PROFIT_D], orgs: [O.JY], start: '2026-06-30', end: '2026-06-30'});
    }},
    {message: '把第1次查询的日期改为2026年4月30日，其他条件不变。', expect: ctx => {
      assert.equal(ctx.formal?.status, 'succeeded');
      assertQuery(ctx, {metrics: [M.DEP_D], orgs: [O.WX], start: '2026-04-30', end: '2026-04-30'});
    }},
    {message: '只展示第2次查询的结果，不重新取数。', expect: ctx => {
      assertNoQuery(ctx);
      assert(ctx.answer.includes('江阴') && ctx.answer.includes('净利润'), 'EXPLICIT_HISTORY_RESULT');
      assert(/2026[-年]0?6[-月]30/.test(ctx.answer), 'HISTORICAL_DATE_KEPT');
    }},
    {message: '日期改成2026年6月30日，其他条件不变。', expect: ctx => {
      assert.equal(ctx.formal?.status, 'succeeded');
      assertQuery(ctx, {metrics: [M.DEP_D], orgs: [O.WX], start: '2026-06-30', end: '2026-06-30'});
    }},
  ]},
  {id: 'B13-multiple-missing', turns: [
    {message: '查询对公协定存款余额当日数。', expect: ctx => {
      assertNeedsUser(ctx); assertNoQuery(ctx);
      assert.deepEqual(userFields(ctx.formal), ['organizations', 'time']);
    }},
    {message: '机构是无锡。', expect: ctx => {
      assertNeedsUser(ctx); assertNoQuery(ctx);
      assert.deepEqual(userFields(ctx.formal), ['time']);
      assert.deepEqual((resolvedOf(ctx, 'organizations') as {codes: string[]}).codes, [O.WX]);
    }},
    {message: '日期是2026年5月31日。', expect: ctx => {
      assert.equal(ctx.formal?.status, 'succeeded');
      assertQuery(ctx, {metrics: [M.DEP_D], orgs: [O.WX], start: '2026-05-31', end: '2026-05-31'});
    }},
    {message: '6月末呢？', expect: ctx => {
      assert.equal(ctx.formal?.status, 'succeeded');
      assertQuery(ctx, {metrics: [M.DEP_D], orgs: [O.WX], start: '2026-06-30', end: '2026-06-30'});
    }},
  ]},
];

if (!LIVE) {
  validateFixtures();
} else {
  const [{loadConfig}, {createAskMetricModels}, {HarnessHost}, {NativeSessionStore},
    {loadBusinessSkills, createBusinessSkillReadTool}, {projectEntries}, {createAskMetricTools},
    {isSemanticFeedback}, {authoritativeAnswer, assertAuthoritativeAnswer}, {NativeSemanticTaskStore}] = await Promise.all([
    import('../src/config.js'), import('../src/models.js'), import('../src/harnessHost.js'),
    import('../src/nativeSessions.js'), import('../src/businessSkills.js'), import('../src/sessionProjection.js'),
    import('../src/tools/index.js'), import('../src/semantic-task/feedback.js'), import('./model-evidence-assertions.js'),
    import('../src/semantic-task/store.js'),
  ]);
  const config = {...loadConfig(), businessProtocol: 'semantic_v2'};
  const directory = await mkdtemp(join(tmpdir(), 'clarification-acceptance-'));
  const skills = await loadBusinessSkills();
  const liveConfig = {...config, dataDir: directory};
  let store = new NativeSessionStore(directory);
  const buildHost = () => new HarnessHost(liveConfig, (authorize: any) => createAskMetricModels(liveConfig, authorize),
    store, [...createAskMetricTools(), createBusinessSkillReadTool(skills)], {skills});
  let host = buildHost();
  async function rebuild() {
    await host.close(); await store.close();
    store = new NativeSessionStore(directory); host = buildHost();
  }
  const actor: BackendUser = {id: 'synthetic-clarification', username: 'synthetic', display_name: '澄清验收',
    org_code: 'SYNTH_ROOT', org_name: '合成省联社', role_code: 'USER'};

  function backend() {
    const queries: QueryRow[] = [], resolves: Ctx['resolves'] = [], results = new Map<string, any>();
    const inspections: Array<{question: string; businessDate: string; reference_year?: number}> = [];
    const client = {
      resolveBusinessField: async (entity: string, raw: string[], _options?: unknown, year?: number, source?: unknown, modelValue?: unknown) => {
        const result = python({action: 'resolve', entity, raw, year, source, model_value: modelValue ?? undefined});
        resolves.push({entity, raw, result}); return result;
      },
      resolveBusinessFieldSuggestion: async (entity: string, suggested: unknown, _options?: unknown, sourceQuestion?: string, rawValues: string[] = []) => {
        const result = python({action: 'resolve', entity, raw: rawValues, suggested,
          source: sourceQuestion ? {source_question: sourceQuestion} : undefined});
        resolves.push({entity, raw: rawValues, suggested, result}); return result;
      },
      inspectBusinessGoal: async (question: string, businessDate: string, _options?: unknown, reference_year?: number) => {
        inspections.push({question, businessDate, ...(reference_year === undefined ? {} : {reference_year})});
        return python({action: 'inspect', question, business_date: businessDate, reference_year});
      },
      matchMetricQuestion: async (question: string) => python({action: 'mentions', question}),
      metricCatalogOverview: async () => ({total: METRICS.length, groups: [{unit: '元', count: METRICS.length,
        examples: METRICS.map(m => ({code: m.metric_code, name: m.metric_name}))}]}),
      searchMetrics: async (keyword: string) => ({total: METRICS.filter(m => m.metric_name.includes(keyword)).length,
        items: METRICS.filter(m => m.metric_name.includes(keyword)), semantic_suggestions: []}),
      searchOrganizations: async (keyword: string) => {
        const items = ORGS.filter(o => o.name.includes(keyword) || o.aliases.some(a => a.includes(keyword)))
          .map(o => ({org_code: o.code, org_name: o.name, score: 1, match_type: 'exact'}));
        return {total: items.length, items};
      },
      createAgentQueryContext: async () => ({conversation_id: 'synthetic-clarification'}),
      basicQueries: async (spec: any) => {
        const row: QueryRow = {spec}; queries.push(row);
        const actual = python({action: 'query', spec}), id = `query-${queries.length}`;
        const result = {status: 'succeeded', task_id: id, result_id: `result-${id}`, rows: actual.rows,
          columns: Object.keys(actual.rows[0] ?? {}), row_count: actual.rows.length, truncated: false,
          facts: actual.rows.flatMap((r: any, index: number) => r.metric_value == null ? [] : [{
            fact_id: `fact:${id}:${index}:metric_value`, task_id: id, field: 'metric_value', value: String(r.metric_value),
            unit: r.unit ?? '元', metric_code: r.metric_code, org_code: r.org_code, date: r.stat_date}])};
        row.row_count = actual.rows.length; row.result_ref = `query:${id}:${result.result_id}`; results.set(id, result);
        return {query: spec, result};
      },
      getTask: async (id: string) => {
        if (!results.has(id)) throw new BackendApiError(404, '合成任务不存在', 'TASK_NOT_FOUND');
        return {task_id: id, status: 'SUCCEEDED', version: 1, result: {result_id: `result-${id}`}};
      },
      getTaskResult: async (id: string) => {
        if (!results.has(id)) throw new BackendApiError(404, '合成结果不存在', 'RESULT_NOT_FOUND');
        return results.get(id);
      },
    } as unknown as BackendClient;
    return {client, queries, resolves, inspections};
  }

  async function runTurn(hosted: any, b: ReturnType<typeof backend>, scenario: Scenario, attempt: number,
      index: number, turn: Turn, message: string, state: Record<string, unknown>) {
    const before = b.queries.length, beforeResolves = b.resolves.length, beforeInspections = b.inspections.length;
    const started = performance.now();
    let failure: string | undefined, guardAborted = false;
    // requestId 可由场景固定：同 ID 同输入重发用于验证“同请求 ID 不重复执行”。
    const input: Record<string, unknown> = {protocol_version: 3,
      request_id: turn.requestId ?? `${scenario.id}-a${attempt}-${index}`, message};
    if (turn.answers) input.answers = turn.answers(state);
    const admission = await host.admitPrompt(hosted, input as any, {actor, backend: b.client});
    assert(admission.ok, 'ADMIT_OK');
    const timer = setTimeout(() => {guardAborted = true; void host.abort(hosted, admission.operationId);}, guardMs);
    try {
      const result = await host.drivePrompt(hosted, admission);
      assert(result.ok && result.outcome.kind === 'settled' && result.outcome.outcome.status === 'completed', 'TURN_COMPLETED');
    } catch (e) {failure = e instanceof Error ? e.message : String(e);} finally {clearTimeout(timer);}
    const entries = await hosted.lane.findEntries({order: 'oldestFirst'}, BACKGROUND_CONTEXT);
    const start = entries.map((e: any) => e.type === 'message' && e.message.role === 'user').lastIndexOf(true);
    const current = entries.slice(start);
    const messages = current.flatMap((e: any) => e.type === 'message' ? [e.message] : []);
    const receipts = messages.flatMap((m: any) => m.role === 'toolResult' ? [{name: m.toolName, details: m.details, is_error: !!m.isError}] : []);
    const modelErrorCodes = messages.flatMap((m: any) => m.role === 'assistant' && ['error', 'aborted'].includes(m.stopReason)
      ? [/^(\d{3})\b/u.exec(m.errorMessage ?? '')?.[1] ? `HTTP_${/^(\d{3})\b/u.exec(m.errorMessage)![1]}` : 'MODEL_TRANSPORT_ERROR'] : []);
    const formal = receipts.filter((r: any) => isSemanticFeedback(r.details)).at(-1)?.details as SemanticFeedback | undefined;
    const delivery = authoritativeAnswer(projectEntries(current));
    const answer = delivery.final?.text ?? '';
    const finalModelMessage = messages.filter((message: any) => message.role === 'assistant').at(-1);
    const taskStore = new NativeSemanticTaskStore(hosted.session);
    // 统一工作状态后已解析条件挂在焦点任务的 target.fields；plan 不再有 target 投影。
    const focusTask = await taskStore.get((await taskStore.index()).focus ?? '');
    // 焦点 Frame 字段携带已解析值；澄清中间态的待补计划未必挂在 planIndex.focus 上。
    let frameFields: Record<string, any> | undefined;
    const framesApi = (admission.request as any).frames;
    if (framesApi) {
      const frameState = await framesApi.state();
      frameFields = (frameState.focusFrameId ? await framesApi.get(frameState.focusFrameId) : undefined)?.fields;
    }
    const savedQuestions = focusTask ? (await taskStore.questionsForTask(focusTask.ref)).filter(view => view.question.status === 'open').map(view => view.question) : [];
    const ctx: Ctx = {formal, answer, queries: b.queries.slice(before), pendingFields: Object.keys(focusTask?.target.pending ?? {}), savedQuestions,
      resolves: b.resolves.slice(beforeResolves), receipts, planFields: focusTask?.target?.fields, frameFields, state};
    try {
      assert(!guardAborted, 'TEST_GUARD_ABORTED');
      assertAuthoritativeAnswer(delivery, finalModelMessage);
      assert(!JSON.stringify(receipts).includes('QUESTION_NOT_PUBLISHED') && !answer.includes('QUESTION_NOT_PUBLISHED'),
        'QUESTION_NOT_PUBLISHED_FORBIDDEN');
      turn.expect(ctx);
    } catch (e) {failure ??= e instanceof Error ? e.message : String(e);}
    const report = {scenario: scenario.id, attempt, turn: index + 1, message, passed: !failure, failure,
      guard_aborted: guardAborted, model_error_codes: modelErrorCodes, status: formal?.status,
      elapsed_ms: Math.round(performance.now() - started), queries: ctx.queries.map(q => ({spec: q.spec, row_count: q.row_count})),
      pending_questions: formal?.pending_questions, saved_pending_fields: ctx.pendingFields, saved_questions: savedQuestions, issues: formal?.issues, answer,
      tool_calls: Object.fromEntries([...new Set(receipts.map(receipt => receipt.name))].map(name =>
        [name, receipts.filter(receipt => receipt.name === name).length])),
      binding_calls: {inspections: b.inspections.slice(beforeInspections),
        fields: ctx.resolves.map(({entity, raw, result}) => ({entity, raw, status: result.status}))},
      conditions: formal?.state.targets.flatMap(t => t.conditions),
      resolved: Object.fromEntries(Object.entries(ctx.planFields ?? {}).map(([k, v]: any) => [k, v?.resolvedValue]))};
    console.log(JSON.stringify({scenario: scenario.id, attempt, turn: index + 1, passed: !failure,
      status: formal?.status, elapsed_ms: report.elapsed_ms, failure}));
    return {failure, report, gatewayBlocked: modelErrorCodes.some(code => ['HTTP_401', 'HTTP_402', 'HTTP_403'].includes(code))};
  }

  const allReports: any[] = [], scenarioResults: any[] = [];
  const expectedScenarios = scenarios.filter(s => !selected.size || selected.has(s.id));
  let gatewayBlocked = false;
  const sourceHashes = Object.fromEntries(await Promise.all(
    ['scripts/check-clarification-acceptance.ts', 'scripts/clarification-acceptance-fixture.py',
      'src/semantic-task/actionBinding.ts', 'src/semantic-task/planService.ts', 'src/semantic-task/service.ts',
      'src/semantic-task/sourceGuard.ts', 'src/semantic-task/protocol.ts', 'src/semantic-task/structuredQuery.ts',
      'src/semantic-task/prompt.ts', 'src/semantic-task/questions.ts', 'src/semantic-task/store.ts',
      'src/semantic-task/tools.ts', 'src/toolRecovery.ts', 'src/harnessHost.ts']
      .map(async p => [p, createHash('sha256').update(await readFile(resolve(p))).digest('hex')])));
  async function save() {
    await mkdir(dirname(reportPath), {recursive: true});
    await writeFile(reportPath, JSON.stringify({
      environment: 'real_model_synthetic_catalog_in_memory_SQL', real_database: false,
      business_dates: [...new Set(allReports.flatMap(turn => turn.binding_calls?.inspections.map((item: {businessDate: string}) => item.businessDate) ?? []))],
      model: config.model.name, source_hashes: sourceHashes, native_session_directory: directory,
      gateway_blocked: gatewayBlocked, requested_scenarios: expectedScenarios.map(s => s.id), scenarios: scenarioResults, turns: allReports,
      passed: scenarioResults.length === expectedScenarios.length && scenarioResults.length > 0 && scenarioResults.every(s => s.passed),
    }, null, 2));
  }
  try {
    outer: for (const scenario of expectedScenarios) {
      let passed = false; const attempts: any[] = [];
      for (let attempt = 1; attempt <= maxAttempts && !passed && !gatewayBlocked; attempt++) {
        const hosted = await host.createSession(actor);
        const sessionId = hosted.sessionId;
        let current = hosted;
        const b = backend(); const state: Record<string, unknown> = {}; const turns: any[] = [];
        let failed = false;
        try {
          for (const [index, turn] of scenario.turns.entries()) {
            if (scenario.refreshBefore === index) {
              await host.closeSession(sessionId).catch(() => undefined);
              await rebuild();
              const reopened = await host.openSession(actor, sessionId);
              assert(reopened, 'REFRESH_REOPEN');
              current = reopened;
            }
            const message = typeof turn.message === 'function' ? turn.message(state) : turn.message;
            const {failure, report, gatewayBlocked: blocked} = await runTurn(current, b, scenario, attempt, index, turn, message, state);
            turns.push(report); allReports.push(report);
            gatewayBlocked ||= blocked;
            if (failure || blocked) {failed = true; break;}
          }
        } catch (e) {
          failed = true;
          const report = {scenario: scenario.id, attempt, turn: -1, passed: false,
            failure: e instanceof Error ? e.message : String(e)};
          turns.push(report); allReports.push(report);
          console.log(JSON.stringify({scenario: scenario.id, attempt, turn: -1, passed: false, failure: report.failure}));
        } finally {await host.closeSession(sessionId).catch(() => undefined);}
        attempts.push({attempt, passed: !failed, turns});
        passed = !failed;
        await save();
        if (gatewayBlocked) break outer;
      }
      scenarioResults.push({id: scenario.id, passed, attempts: attempts.length,
        failures: passed ? [] : attempts.flatMap(a => a.turns.filter((t: any) => !t.passed).map((t: any) => ({turn: t.turn, failure: t.failure})))});
      await save();
    }
  } finally {await save(); await host.close(); await store.close();}
  console.log(JSON.stringify({report: reportPath, passed: scenarioResults.every(s => s.passed),
    scenarios: scenarioResults.map(s => ({id: s.id, passed: s.passed, attempts: s.attempts}))}));
  if (scenarioResults.some(s => !s.passed)) process.exitCode = 1;
}
