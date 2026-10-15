import {readFile,writeFile} from 'node:fs/promises';
import {projectEntries} from '/private/tmp/prompt-skill-unify-final-20261013-992ls5tm/agent-service/src/sessionProjection.ts';
const path='/Users/yubobo/Documents/服务项目/江苏农信/ask-metric-intent-goldendb-Harness/docs/verification/prompt-skill-ab-20261013-candidate2-first5.offline.json';
const report=JSON.parse(await readFile(path,'utf8'));
for(const turn of report.turns){const result=projectEntries(turn._projection_entries).filter(m=>m.role==='assistant'&&m.text.trim()).at(-1);turn.answer=result?.role==='assistant'?result.text:'';delete turn._projection_entries;}
await writeFile(path,JSON.stringify(report,null,2));
console.log(JSON.stringify({offline_projection_completed:true,model_called:false,turns:report.turns.length}));
