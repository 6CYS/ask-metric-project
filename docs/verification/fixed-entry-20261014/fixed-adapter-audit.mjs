import {createHash} from 'node:crypto';
import {readFileSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {isDeepStrictEqual} from 'node:util';
const source=join(process.cwd(),'src/business-context/fixedTurnArgs.ts');
const digest=()=>createHash('sha256').update(readFileSync(source)).digest('hex');
const before=digest();
const {fromFixedTurnArgs,toFixedTurnArgs,fixedTurnParameters}=await import(pathToFileURL(source));
const inherit={action:'inherit'};
const query=(changes={},base='current')=>({protocol_version:1,capability:'metric_query',base,mode:'execute',changes:{organizations:inherit,...changes}});
const org={action:'set',source_text:'上述三家机构',expected_count:3,value:{kind:'names',names:['合成甲','合成乙','合成丙']}};
const calc={protocol_version:1,capability:'metric_calculate',base:'current',mode:'execute',changes:{
 expressions:{action:'set',value:[{name:'total',label:'合成合计',expression:'a+c'}]},
 bindings:{action:'set',value:[{name:'a',fact_id:'fact:synthetic:0:a'}]},
 constants:{action:'set',value:[{name:'c',value:'-9007199254740993.12345678901234567890',source_text:'减9007199254740993.12345678901234567890'}]},
}};
const history=query({organizations:{action:'set',source_text:'合并先前两个机构组和合成丁',expected_count:4,value:{kind:'history',combine:'union',sources:[{frame:{ordinal:1,capability:'metric_query'},field:'organizations'},{frame:{frameId:'second',resultRequired:true},field:'organizations'}],add:['合成丁'],retainResolvedAdditions:true,replaceAdditions:[{index:0,value:'合成戊'}]}}});
const valid=[
 ['explicit null source',query({organizations:org,metrics:{action:'set',value:{fromQuestion:true}},time:{action:'set',value:'2035年4月末'}},null)],
 ['bound count and history union',history],
 ['selector conjunction',query({}, {ordinal:2,relativePosition:-1,capability:'metric_query',resultRequired:false})],
 ['confirm select',query({organizations:{action:'confirm',source_text:'第一个',decision:'select',expected_count:3}})],
 ['confirm semantic acceptance',query({organizations:{action:'confirm',source_text:'是的，日期改成四月',decision:'accept',expected_count:3}})],
 ['separate comparison role',query({comparison_organizations:{action:'set',source_text:'合成母行下辖机构',expected_count:null,value:{kind:'children_of',parentName:'合成母行'}}})],
 ['remove and clarify',query({metrics:{action:'remove',value:{mentionIndexes:[2]}},operation:{action:'clarify',source_text:'排名'}})],
 ['explicit inherit recovery choice',query({selection:inherit,operation:inherit})],
 ['reuse result no mutation',{...query(),mode:'reuse_result'}],
 ['coverage pagination',{protocol_version:1,capability:'data_availability',base:'current',mode:'execute',changes:{organizations:inherit,dimension:{action:'set',value:'metrics'},page:{action:'set',value:2},page_size:{action:'set',value:20}}}],
 ['calculation decimal precision',calc],
 ['calculation empty constants',{...calc,changes:{...calc.changes,constants:{action:'set',value:[]}}}],
];
const invalid=[
 ['legacy outer format',{capabilityHint:'metric_query',baseReference:'current',executionMode:'execute',fieldChanges:[]}],
 ['mixed outer format',{...query(),fieldIntents:{}}],
 ['missing required source',Object.fromEntries(Object.entries(query()).filter(([key])=>key!=='base'))],
 ['invalid source boolean',query({},false)],
 ['source ordinal numeric string',query({}, {ordinal:'1'})],
 ['untyped businessConstraints',query({}, {businessConstraints:{organizations:'合成甲'}})],
 ['protocol numeric string',{...query(),protocol_version:'1'}],
 ['count false',query({organizations:{...org,expected_count:false}})],
 ['count zero',query({organizations:{...org,expected_count:0}})],
 ['count numeric string',query({organizations:{...org,expected_count:'3'}})],
 ['missing expected count',query({organizations:{action:'set',source_text:org.source_text,value:org.value}})],
 ['inherit supplied evidence',query({organizations:{action:'inherit',source_text:'上述三家',expected_count:3}})],
 ['injected candidate code',query({organizations:{...org,value:{kind:'name',name:'合成甲',code:'forged'}}})],
 ['history cross-field substitution',query({comparison_organizations:{action:'set',source_text:'先前机构',expected_count:null,value:{kind:'history',combine:'single',sources:[{frame:{ordinal:1},field:'organizations'}]}}})],
 ['history duplicate replacement index',query({organizations:{...history.changes.organizations,value:{...history.changes.organizations.value,replaceAdditions:[{index:0,value:'甲'},{index:0,value:'乙'}]}}})],
 ['history replacement without retention',query({organizations:{action:'set',source_text:'先前机构换甲',expected_count:null,value:{kind:'history',combine:'union',sources:[{frame:{ordinal:1},field:'organizations'}],replaceAdditions:[{index:0,value:'甲'}]}}})],
 ['cross-capability operation',{...query(),capability:'data_availability',changes:{organizations:inherit,operation:{action:'set',value:{kind:'value'}}}}],
 ['cross-capability complex scope',{...query(),capability:'data_availability',changes:{organizations:{action:'set',source_text:'全部农商行',expected_count:null,value:{kind:'authorized_cohort',cohort:'rural_commercial_banks'}}}}],
 ['metric rewritten string',query({metrics:{action:'set',value:'模型改写指标'}})],
 ['duplicate mention index',query({metrics:{action:'set',value:{fromQuestion:true,mentionIndexes:[1,1]}}})],
 ['ranking numeric string',query({operation:{action:'set',value:{kind:'ranking',position:'top',top_n:'3'}}})],
 ['unknown nested operation key',query({operation:{action:'set',value:{kind:'value',top_n:3}}})],
 ['clarify carries guessed value',query({operation:{action:'clarify',source_text:'排名',value:{kind:'ranking',position:'top',top_n:10}}})],
 ['reuse result with changes',{...query({time:{action:'set',value:'4月末'}}),mode:'reuse_result'}],
 ['numeric constant precision coercion',{...calc,changes:{...calc.changes,constants:{action:'set',value:[{name:'c',value:9007199254740992,source_text:'加9007199254740993'}]}}}],
 ['duplicate variable in binding',{...calc,changes:{...calc.changes,bindings:{action:'set',value:[{name:'a',fact_id:'fact:a'},{name:'a',fact_id:'fact:b'}]}}}],
 ['duplicate variable across binding constant',{...calc,changes:{...calc.changes,constants:{action:'set',value:[{name:'a',value:'1',source_text:'加1'}]}}}],
 ['unknown variable entry property',{...calc,changes:{...calc.changes,bindings:{action:'set',value:[{name:'a',fact_id:'fact:a',sql:'forged'}]}}}],
];
const results=[];
for(const [label,args] of valid){const original=structuredClone(args);try{const delta=fromFixedTurnArgs(args);const restored=toFixedTurnArgs(delta);results.push({label,expected:'accept losslessly',pass:isDeepStrictEqual(args,restored)&&isDeepStrictEqual(args,original)});}catch(error){results.push({label,expected:'accept losslessly',pass:false,error_code:error.code,error_message:error.message});}}
for(const [label,args] of invalid){const original=structuredClone(args);let rejected=false,error_code;try{fromFixedTurnArgs(args);}catch(error){rejected=true;error_code=error.code;}results.push({label,expected:'reject without mutation',pass:rejected&&isDeepStrictEqual(args,original),error_code});}
const after=digest();const report={scope:'fixed schema and pure adapter only; synthetic values; no host compatibility/model/DB/network execution',source_sha256_before:before,source_sha256_after:after,source_stable:before===after,schema_json_bytes:Buffer.byteLength(JSON.stringify(fixedTurnParameters)),passed:results.filter(item=>item.pass).length,failed:results.filter(item=>!item.pass).length,results};
writeFileSync('/private/tmp/harness-fixed-entry-20261014/fixed-adapter-audit.json',JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report,null,2));
