import {expect,it,vi} from "vitest";
import {organizationValues,orgCatalog} from "../../src/business-context/orgCatalog.js";
import {testRequestContext,MemoryCommandBridge} from "../../src/tools/testUtils.js";
import type {BackendClient} from "../../src/backendClient.js";
it("机构目录连接词不拆正式名称，完整多值原文逐项保留且同轮只读一次目录",async()=>{
 const fetch=vi.fn(async()=>({items:[{code:'A',name:'和盛银行',aliases:['和盛']},{code:'B',name:'与民银行',aliases:['与民']},{code:'C',name:'机构甲',aliases:[]}]}));
 const request=testRequestContext({orgCatalog:fetch} as unknown as BackendClient,new MemoryCommandBridge());
 expect(await organizationValues(request,'和盛银行')).toEqual(['和盛银行']);
 expect(await organizationValues(request,'和盛银行和与民银行、机构甲以及未知机构')).toEqual(['和盛银行','与民银行','机构甲','未知机构']);
 expect(await organizationValues(request,'和盛与机构甲')).toEqual(['和盛','机构甲']);
 expect((await orgCatalog(request)).items.map(i=>i.code)).toEqual(['A','B','C']);
 expect(fetch).toHaveBeenCalledTimes(1);
});
