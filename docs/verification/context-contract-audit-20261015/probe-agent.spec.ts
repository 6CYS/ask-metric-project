import {it, expect} from '../../../agent-service/node_modules/vitest/dist/index.js';
import {fixture, proposal, complete} from '../../../agent-service/specs/semantic-task/fixtures.ts';
import {SemanticTaskService} from '../../../agent-service/src/semantic-task/service.ts';
it('probe: plan-wide count is currently applied to one inherited member even with jointCoverage', async()=>{
 const f=await fixture();
 try {
  const base=await new SemanticTaskService(f.request('base','合成机构甲2025年末的合成指标甲')).resolve(proposal(complete(),{kind:'new'},'prepare'));
  expect(base.status).toBe('prepared');
  const request={...f.request('followup','上述三家机构2024年末的分别是多少'), semanticStep:{planRef:'synthetic-plan',rootOperationId:'followup',revision:1,kind:'query' as const,jointCoverage:true,partialCalendar:true}};
  const result=await new SemanticTaskService(request).resolve(proposal([{action:'set',field:'time',value:'2024年末'}],{kind:'reference',task_ref:base.task!.ref,target_ref:base.task!.target.ref}));
  expect(result.task!.target.fields.organizations.resolvedValue).toEqual({codes:['O1'],names:['合成机构甲']});
  expect(result.task!.issues).toContainEqual(expect.objectContaining({code:'ORGANIZATION_COUNT_CONFLICT',remediation:'user'}));
  expect(f.backend.basicQueries).not.toHaveBeenCalled();
 } finally {await f.close();}
});
