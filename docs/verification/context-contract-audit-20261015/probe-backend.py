import importlib.util,json,hashlib
from pathlib import Path
root=Path(__file__).resolve().parents[3]
spec=importlib.util.spec_from_file_location('semantic_fixture',root/'agent-service/scripts/semantic-task-fixture.py')
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
paths=['backend-next/src/ask_metric/api/routes/business_context.py','backend-next/src/ask_metric/application/semantic_transition.py','backend-next/src/ask_metric/application/goal_facts.py','backend-next/src/ask_metric/application/field_resolution.py']
hashes=lambda:{p:hashlib.sha256((root/p).read_bytes()).hexdigest() for p in paths}
before_hashes=hashes()
def query(org,day):
    return m.BasicQuerySpec.model_validate({'schema_version':2,'metric_codes':['SYNTH_M:D'],'org_codes':[org],'time':{'start':day,'end':day},'selection':'exact','operation':{'kind':'value'}}).model_dump(mode='json',exclude_none=True)
old=[query('SYNTH_O1','2026-05-31'),query('SYNTH_O2','2026-06-30')]
new=[query('SYNTH_O1','2026-06-30'),query('SYNTH_O2','2026-05-31')]
base={'conversation_id':'synthetic-conversation','session_id':'synthetic-session','business_date':'2026-10-15','goal':'查询合成机构甲2026年5月31日的经营收益金额当日数；查询合成机构乙2026年6月30日的经营收益金额当日数','steps':[{'target_ref':str(i),'fragment':i,'origin':'user_explicit','spec':q} for i,q in enumerate(old)]}
facts=m.main({'action':'inspect','question':base['goal'],'business_date':base['business_date']})
base['fragment_bindings']={str(i):[{'text':v['text'],'start':v['start'],'end':v['end'],'codes':v['resolution']['value']['codes']} for v in f['mentions']] for i,f in enumerate(facts['fragments'])}
a=m.main({'action':'admit','payload':base})
receipts={x['target_ref']:x['receipt'] for x in a['receipts']}
results=[]
for case,specs,changes in [('omitted_date_changes',old,False),('correct_date_changes',new,True)]:
    p={**base,'goal':'合成机构甲改查2026年6月30日；合成机构乙改查2026年5月31日','steps':[{'target_ref':str(i),'fragment':i,'origin':'history','spec':q,'transition':{'before':old[i],'source_semantic_receipt':receipts[str(i)],'changes':[{'field':'time','action':'set','before':old[i]['time'],'after':q['time']}] if changes else []}} for i,q in enumerate(specs)]}
    try:
        r=m.main({'action':'admit','payload':p});outcome=r['status']
    except Exception as e:outcome=getattr(e,'code',type(e).__name__)
    results.append({'case':case,'backend_admission':outcome,'actual_target_tuples':[[q['org_codes'][0],q['metric_codes'][0],q['time']['start']] for q in specs],'expected_target_tuples':[[q['org_codes'][0],q['metric_codes'][0],q['time']['start']] for q in new],'matches_user_request':specs==new})
controls=[]
for mode in ['forged_receipt','permission_removed']:
    p={**base,'goal':'合成机构甲改查2026年6月30日；合成机构乙改查2026年5月31日','steps':[{'target_ref':str(i),'fragment':i,'origin':'history','spec':q,'transition':{'before':old[i],'source_semantic_receipt':receipts[str(i)],'changes':[{'field':'time','action':'set','before':old[i]['time'],'after':q['time']}]}} for i,q in enumerate(new)]}
    if mode=='forged_receipt':
        t=p['steps'][0]['transition']['source_semantic_receipt']; raw,sig=t.split('.');p['steps'][0]['transition']['source_semantic_receipt']=raw+'.'+('A' if sig[0]!='A' else 'B')+sig[1:]
    allowed=m.fixture.ALLOWED.copy()
    if mode=='permission_removed':m.fixture.ALLOWED.discard('SYNTH_O1')
    try:r=m.main({'action':'admit','payload':p});outcome=r['status']
    except Exception as e:outcome=getattr(e,'code',type(e).__name__);status=getattr(e,'status_code',None)
    finally:m.fixture.ALLOWED=allowed
    controls.append({'case':mode,'outcome':outcome,'rejected':outcome!='admitted'})
suggested=m.fixture.resolve_catalog_field('organization',[],m.fixture.ORGS,suggested=[{'code':'SYNTH_O1','name':'不相关名称','excerpt':'合成机构乙'}])
report={'environment':'isolated synthetic catalogs; actual Python admission route; no model or business database','source_hashes':before_hashes,'sources_unchanged_during_probe':before_hashes==hashes(),'baseline':a['status'],'negative_controls':controls,'cases':results,'suggestion_probe':{'status':suggested['status'],'value':suggested.get('value'),'metadata':suggested.get('metadata'),'limit':'This tests catalog membership only; no end-to-end false answer is claimed.'}}
print(json.dumps(report,ensure_ascii=False,indent=2))
