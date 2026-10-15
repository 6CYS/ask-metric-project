import {createFieldResolvers} from '../../../agent-service/src/business-context/resolvers.ts';
import {createCapabilities} from '../../../agent-service/src/business-context/capabilities.ts';
import {fromFixedTurnArgs} from '../../../agent-service/src/business-context/fixedTurnArgs.ts';
import {metricCoverageSource} from '../../../agent-service/src/business-context/adapters.ts';
async function main() {
 const schema=createCapabilities().get('metric_query');
 const resolver=createFieldResolvers().getResolver(schema.fields.metrics!);
 const base={originalMessage:'存款记录',currentDate:'2026-10-14',turnId:'t2',inputSource:'explicit',resolveMetricMentions:async()=>({mentions:[]}),resolveCatalog:async()=>({status:'not_found'})};
 for (const previous of [undefined,{source:'explicit',resolutionStatus:'missing'},{source:'explicit',resolutionStatus:'not_found',rawValue:['存款记录']}]) {
  try {const r=await resolver.resolve({fromQuestion:true},schema.fields.metrics!,{...base,...(previous?{previous}:{})} as any);console.log(JSON.stringify({test:'empty-match',previous:previous?.resolutionStatus??'none',result:r}));}
  catch(e:any){console.log(JSON.stringify({test:'empty-match',previous:previous?.resolutionStatus??'none',error:e.code}));}
 }
 const question='合成甲、合成乙';
 const prior:any={source:'explicit',resolutionStatus:'resolved',rawValue:['合成甲','合成乙'],resolvedValue:{codes:['A','B'],names:['合成甲','合成乙']},metadata:{questionText:question,mentionResolutions:[{text:'合成甲',start:0,end:3,status:'resolved',value:{codes:['A'],names:['合成甲']}},{text:'合成乙',start:4,end:7,status:'resolved',value:{codes:['B'],names:['合成乙']}}]}};
 const fixed={protocol_version:1,capability:'metric_query',base:'current',mode:'execute',changes:{organizations:{action:'inherit'},metrics:{action:'remove',value:{mentionIndexes:[2]}}}};
 const delta=fromFixedTurnArgs(fixed);
 const removed=await resolver.resolve(delta.fieldChanges[0]!.rawValue,schema.fields.metrics!,{...base,originalMessage:'不要合成甲了',previous:prior,fieldOperation:'remove'} as any);
 console.log(JSON.stringify({test:'remove-wrong-target',input:'不要合成甲了',fixedPass:true,result:removed,coverage:metricCoverageSource((removed.metadata as any).questionText,(removed.metadata as any).mentionResolutions,(removed.metadata as any).removedMentions)}));
 const replaceQuestion='合成甲换成合成乙';
 const result=await resolver.resolve({fromQuestion:true,mentionIndexes:[2]},schema.fields.metrics!,{...base,originalMessage:replaceQuestion,previous:prior,fieldOperation:'set',resolveMetricMentions:async()=>({mentions:[{text:'合成甲',start:0,end:3,resolution:{status:'resolved',value:{codes:['A'],names:['合成甲']}}},{text:'合成乙',start:5,end:8,resolution:{status:'resolved',value:{codes:['B'],names:['合成乙']}}}]})} as any);
 console.log(JSON.stringify({test:'replace-current-target',result,coverage:metricCoverageSource((result.metadata as any).questionText,(result.metadata as any).mentionResolutions,[])}));
}
main();
