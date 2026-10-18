import {afterEach, expect, it} from "vitest";
import {fixture, complete, proposal} from "./fixtures.js";
import {SemanticPlanService} from "../../src/semantic-task/planService.js";
import {createSemanticClarifyTool, createSemanticExecuteTool} from "../../src/semantic-task/tools.js";
import {runTool} from "../../src/tools/testUtils.js";
const closes: Array<() => Promise<void>> = [];
afterEach(async () => {for (const close of closes.splice(0)) await close();});
async function setup() {
  const f = await fixture(); closes.push(f.close);
  const input = proposal(complete());
  input.targets.push({source: {kind: "new"}, operations: complete().map(op => op.field === "organizations" ? {...op, value: "合成机构乙"} : op.field === "metrics" ? {...op, value: "合成指标乙"} : op)});
  const request = f.request("base", "查合成机构甲2025年末的合成指标甲；查合成机构乙2025年末的合成指标乙");
  const result = await new SemanticPlanService(request).resolve(input);
  expect(result.status).toBe("ready");
  for (const target of result.state.targets) await runTool(createSemanticExecuteTool(), {task_ref: result.state.task_ref, target_ref: target.target_ref}, request);
  const plan = (await request.semanticTasks!.plan(result.state.task_ref!))!;
  const alternatives = plan.steps.map((step, i) => ({task_ref: plan.ref, target_ref: step.targetRef, label: i ? "合成机构乙" : "合成机构甲"}));
  return {...f, plan, alternatives};
}
it("真实歧义只保存追问，明确来源后继续上一轮日期变更，旧Frame保持不变", async () => {
  const f = await setup(), store = f.request().semanticTasks!, frames = f.request().frames!;
  const prior = await Promise.all((await frames.state()).frameOrder.map(id => frames.get(id)));
  const count = f.backend.basicQueries.mock.calls.length;
  const waiting = await runTool(createSemanticClarifyTool(), {question: "要改合成机构甲还是合成机构乙？", alternatives: f.alternatives}, f.request("ambiguous", "把其中一项日期改成2024年末"));
  expect(waiting.details).toMatchObject({status: "needs_user", continuation: {actor: "user"}});
  expect(f.backend.basicQueries).toHaveBeenCalledTimes(count);
  const chosen = f.alternatives[1]!, next = f.request("selection", "我指的是合成机构乙那项");
  const continuation = proposal([{action: "set", field: "time", value: "2024年末"}], {kind: "reference", task_ref: chosen.task_ref, target_ref: chosen.target_ref}); continuation.context_action = "resume";
  const result = await new SemanticPlanService(next).resolve(continuation);
  expect(result.status, JSON.stringify(result.issues)).toBe("ready");
  await runTool(createSemanticExecuteTool(), {task_ref: result.state.task_ref, target_ref: result.state.targets[0]!.target_ref}, next);
  expect(f.backend.basicQueries.mock.calls.at(-1)![0]).toMatchObject({metric_codes: ["M2"], org_codes: ["O2"], time: {start: "2024-12-31"}});
  for (const frame of prior) expect(await frames.get(frame!.frameId)).toEqual(frame);
  await store.admit("after", "后续"); expect((await store.admissionContext("after"))?.pending_clarification).toBeUndefined();
});
it("伪造或重复备选不保存澄清状态，也不执行查询", async () => {
  const f = await setup(), count = f.backend.basicQueries.mock.calls.length;
  const result = await runTool(createSemanticClarifyTool(), {question: "哪一个？", alternatives: [f.alternatives[0], {...f.alternatives[1], target_ref: "invented"}]}, f.request("invalid", "改一项"));
  expect(result.details).toMatchObject({status: "conflict", continuation: {actor: "pi"}});
  await f.request().semanticTasks!.admit("after-invalid", "之后");
  expect((await f.request().semanticTasks!.admissionContext("after-invalid"))?.pending_clarification).toBeUndefined();
  expect(f.backend.basicQueries).toHaveBeenCalledTimes(count);
});
it("明确独立new不携带待明确的旧日期修改", async () => {
  const f = await setup();
  await runTool(createSemanticClarifyTool(), {question: "要改哪项？", alternatives: f.alternatives}, f.request("waiting", "其中一项改成2024年末"));
  const fresh = proposal([{action: "set", field: "metrics", value: "合成指标甲"}]); fresh.context_action = "abandon";
  const next = await new SemanticPlanService(f.request("fresh", "另查合成指标甲，不继承条件")).resolve(fresh);
  expect(next.status).toBe("needs_user"); expect(next.issues.map(issue => issue.field).sort()).toEqual(["organizations", "time"]);
  await f.request().semanticTasks!.admit("after-fresh", "之后");
  expect((await f.request().semanticTasks!.admissionContext("after-fresh"))?.pending_clarification).toBeUndefined();
});
