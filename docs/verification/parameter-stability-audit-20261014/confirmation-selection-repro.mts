import {clarificationOptions, selectOptions} from '../../../agent-service/src/business-context/clarificationOptions.ts';
import {createCapabilities} from '../../../agent-service/src/business-context/capabilities.ts';
import {validateFieldIntents, applyFieldIntentConstraints, validateFrame} from '../../../agent-service/src/business-context/core.ts';
import {BusinessContextService} from '../../../agent-service/src/business-context/service.ts';
import {createFieldResolvers} from '../../../agent-service/src/business-context/resolvers.ts';
console.info = () => {};
const groups = clarificationOptions({fields:{organizations:{resolutionStatus:'needs_confirmation',source:'explicit',candidates:[{code:'O1',value:'合成机构甲'}]}}} as any,{organizations:'机构'});
for (const reply of ['不要合成机构甲','不需要合成机构甲','别选第一个','机构就用合成机构甲，日期不要4月，换成5月']) {
 console.log('negation',JSON.stringify({reply,selected:selectOptions(groups,{reply}).map(x=>x.candidate.code)}));
}
const schema=createCapabilities().get('metric_query');
const fields:any={metrics:{source:'explicit',resolutionStatus:'resolved',resolvedValue:{codes:['M'],names:['合成指标']}},organizations:{source:'explicit',resolutionStatus:'resolved',resolvedValue:{codes:['O1','O2'],names:['合成机构甲','合成机构乙']}},time:{source:'explicit',resolutionStatus:'resolved',resolvedValue:{start:'2026-04-30',end:'2026-04-30'}},selection:{source:'explicit',resolutionStatus:'resolved',resolvedValue:'exact'},operation:{source:'explicit',resolutionStatus:'resolved',resolvedValue:{kind:'value'}},comparison_organizations:{source:'explicit',resolutionStatus:'missing'}};
const delta:any={capabilityHint:'metric_query',baseReference:null,executionMode:'execute',fieldIntents:{organizations:{mode:'set',sourceText:'以上三家机构',expectedCount:2}},fieldChanges:[{fieldHint:'organizations',operation:'set',rawValue:{fromHistory:true,sourceText:'以上三家机构',sources:[{frame:{frameId:'history'},field:'organizations'}],combine:'single',expectedCount:2}}]};
validateFieldIntents(schema,delta,{originalMessage:'查询以上三家机构',requireFieldIntents:true} as any);
applyFieldIntentConstraints(schema,fields,delta);
console.log('count',JSON.stringify({original:'查询以上三家机构',submitted:2,actual:2,result:validateFrame(schema,fields)}));
class MemoryStore {
 stateData:any; frames=new Map<string,any>(); commands=new Map<string,string>();
 constructor(){const ready:any={frameId:'R',sessionId:'s',turnId:'t1',requestId:'r1',capability:'metric_query',operationFrameId:'R',fields:structuredClone(fields),delta:{capabilityHint:'metric_query',baseReference:null,executionMode:'execute',fieldChanges:[]},issues:[],status:'ready',createdAt:new Date().toISOString()};const executing={...ready,frameId:'E',parentFrameId:'R',status:'executing'};this.frames.set('R',ready);this.frames.set('E',executing);this.stateData={sessionId:'s',version:2,frameOrder:['R','E'],operations:{R:'E'},focusFrameId:'E'};}
 async state(){return structuredClone(this.stateData)} async get(id:string){return structuredClone(this.frames.get(id))} async list(){return [...this.frames.values()].map(x=>structuredClone(x))} async command(key:string){return this.get(this.commands.get(key)!)}
 async save(frame:any,version:number,key:string,focus=true){if(version!==this.stateData.version)throw new Error('conflict');this.frames.set(frame.frameId,structuredClone(frame));this.commands.set(key,frame.frameId);this.stateData={...this.stateData,version:version+1,frameOrder:[...this.stateData.frameOrder,frame.frameId],operations:{...this.stateData.operations,[frame.operationFrameId]:frame.frameId},...(focus&&frame.status!=='failed'?{focusFrameId:frame.frameId}:{})};return structuredClone(frame)}
}
async function main(){for(const base of ['current',{frameId:'R'}]){const store=new MemoryStore();const service=new BusinessContextService(store as any,createCapabilities(),createFieldResolvers());const result=await service.resolve({capabilityHint:'metric_query',baseReference:base as any,executionMode:'execute',fieldChanges:[],fieldIntents:{organizations:{mode:'inherit',sourceText:null,expectedCount:null}}},{sessionId:'s',turnId:'t2',requestId:'r2'},{originalMessage:'再查一次',currentDate:'2026-10-14',turnId:'t2',requireFieldIntents:true,resolveCatalog:async()=>{throw new Error('catalog should not be called')}});console.log('inflight',JSON.stringify({base,status:result.status,issues:result.issues,parent:result.parentFrameId}));}}
main();
