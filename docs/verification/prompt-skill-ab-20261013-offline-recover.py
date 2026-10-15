from pathlib import Path
import json,tempfile,hashlib,shutil
repo=Path('/Users/yubobo/Documents/服务项目/江苏农信/ask-metric-intent-goldendb-Harness')
base=repo/'docs/verification/prompt-skill-ab-20261013'
before=json.load(open(str(base)+'-before.json'))
phase_rows={}
for line in Path('/private/tmp/prompt-skill-ab-final-live-20261013.log').read_text().splitlines():
 try:d=json.loads(line)
 except ValueError:continue
 if d.get('phase')=='after' and 'scenario' in d:phase_rows[(d['scenario'],d['turn'])]=d
names=[s['name'] for s in before['scenarios'][:4]]
original=None
for p in Path(tempfile.gettempdir()).glob('pi-prompt-skill-ab-after-*'):
 files=list(p.rglob('*01a13590-d870-7213-a7b8-eec36feff6dc.jsonl'))
 if files:original=p;break
assert original
outdir=Path(str(base)+'-candidate2-native');outdir.mkdir(exist_ok=True)
records=[]
for file in original.rglob('*.jsonl'):
 flat=[]
 for line in file.read_text().splitlines():
  d=json.loads(line);flat.extend(d if isinstance(d,list) else[d])
 users=[r for r in flat if r.get('kind')=='entry' and r.get('message',{}).get('role')=='user']
 matches=[s for s in before['scenarios'][:4] if any(u['message'].get('content')==s['steps'][0]['message'] for u in users)]
 if not matches:continue
 scenario=matches[0];shutil.copy2(file,outdir/file.name)
 for i,step in enumerate(scenario['steps']):
  starts=[j for j,r in enumerate(flat) if r.get('kind')=='entry' and r.get('message',{}).get('role')=='user' and r['message'].get('content')==step['message']]
  if not starts:continue
  start=starts[-1];end=next((j for j in range(start+1,len(flat)) if flat[j].get('kind')=='entry' and flat[j].get('message',{}).get('role')=='user'),len(flat))
  entries=[r for r in flat[start:end] if r.get('kind')=='entry']
  messages=[r['message'] for r in entries if r.get('type')=='message']
  calls=[{'id':c['id'],'name':c['name'],'args':c.get('arguments',{})} for m in messages if m['role']=='assistant' for c in m.get('content',[]) if c.get('type')=='toolCall']
  receipts=[{'id':m.get('toolCallId'),'name':m.get('toolName'),'is_error':m.get('isError',False),'details':m.get('details',{}),'text':'\n'.join(c['text'] for c in m.get('content',[]) if c.get('type')=='text')} for m in messages if m['role']=='toolResult']
  values={}
  for r in flat[:end]:
   if r.get('kind')=='value' and r.get('op')=='set':values[(r['namespace'],r['key'])]=r.get('value')
  state=values.get(('askmetric.business.v1','state'),{})
  focus=values.get(('askmetric.business.v1','frame/'+state.get('focusFrameId','')))
  queries=[]
  for r in receipts:
   try:payload=json.loads(r['text'])
   except ValueError:continue
   spec=payload.get('query_evidence',{}).get('logical_dsl')
   if r['name'] in ('resolve_business_turn','execute_business_frame') and r['details'].get('status')=='succeeded' and spec and 'metric_codes' in spec:queries.append(spec)
  guessed=[]
  if step['expected']['kind']=='clarify':
   for c in calls:
    for change in c['args'].get('fieldChanges',[]):
     v=change.get('rawValue')
     if change.get('operation')=='set' and ((change.get('fieldHint')=='selection' and isinstance(v,str))or(change.get('fieldHint')=='operation' and isinstance(v,dict)and v.get('kind')=='ranking')):guessed.append({'call_id':c['id'],'field':change['fieldHint'],'value':v,'reason':'user_not_supplied_business_choice'})
  logged=phase_rows.get((scenario['name'],i+1))
  errors=[m.get('errorMessage') for m in messages if m.get('role')=='assistant' and m.get('errorMessage')]
  count=sum(r['is_error'] or r['details'].get('status') in ('ARGUMENT_ERROR','error','failed') for r in receipts)
  if logged:
   measures=logged['measures'];assert measures['tool_calls']==len(calls);assert measures['error_calls']==count;assert measures['query_count']==len(queries);assert measures['ungrounded_condition_proposals']==len(guessed)
  else:
   assert scenario['name']=='unique_reference_without_count' and errors
   timing=next((v.get('timings_ms',{}) for (ns,key),v in values.items() if ns=='askmetric' and key.startswith('request/') and v.get('input',{}).get('message')==step['message']),{})
   needs=sum(r['details'].get('status')=='NEEDS_CLARIFICATION' for r in receipts)
   measures={'tool_calls':len(calls),'error_calls':count,'error_rate':count/len(calls) if calls else 0,'expected_business_refusals':0,'ungrounded_condition_proposals':0,'ungrounded_condition_executions':0,'unnecessary_clarifications':needs,'repeated_clarifications':max(0,needs-1),'query_count':len(queries),'calculation_count':0,'coverage_count':0,'model_calls':len(timing.get('model',[])),'elapsed_ms':timing.get('drive_total',141346)}
  turn={'scenario':scenario['name'],'turn':i+1,'passed':logged['passed'] if logged else False,'message':step['message'],'expected':step['expected'],'tools':calls,'receipts':receipts,'query_specs':queries,'calculation_specs':[],'coverage_specs':[],'focus':focus,'measures':measures,'ungrounded_proposals':guessed,'native_model_errors':errors,'measurement_provenance':{'offline_reconstructed':True,'model_called':False,'native_file':str(outdir/file.name),'native_file_sha256':hashlib.sha256(file.read_bytes()).hexdigest(),'original_model_script_hash':before['script_hash'],'logged_completed_metrics_reused':bool(logged)},'_projection_entries':entries}
  if logged and logged.get('failure'):turn['failure']=logged['failure']
  elif not logged:turn['failure']='MODEL_STREAM_IDLE_EXCEEDED; model returned error before correction tool execution; original runner then hung in Node assert source location'
  if errors:turn['failure_class']='model_runtime_failure'
  records.append(turn)
assert len(records)==5,len(records)
records.sort(key=lambda t:(names.index(t['scenario']),t['turn']))
Path(str(base)+'-candidate2-first5.offline.json').write_text(json.dumps({'source_data_dir':str(original),'original_script_hash':before['script_hash'],'turns':records},ensure_ascii=False,indent=2))
print(original)
