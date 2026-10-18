import {afterEach,expect,it,vi} from "vitest";
import {BackendClient} from "../src/backendClient.js";
afterEach(()=>vi.restoreAllMocks());
it("建议接口在HTTP请求中保留完整raw_values，不把多机构清单丢成空数组",async()=>{
 const fetch=vi.spyOn(globalThis,"fetch").mockResolvedValue(new Response(JSON.stringify({status:"resolved",value:{codes:["O1","O2"],names:["合成机构甲","合成机构乙"]}}),{status:200}));
 await new BackendClient("http://synthetic.invalid","synthetic-token",1000).resolveBusinessFieldSuggestion("organization",[{name:"合成机构甲",excerpt:"甲"}],undefined,"查甲、乙",["合成机构甲","合成机构乙"]);
 expect(JSON.parse(String(fetch.mock.calls[0]![1]?.body))).toEqual({entity:"organization",raw_values:["合成机构甲","合成机构乙"],suggested:[{name:"合成机构甲",excerpt:"甲"}],source_question:"查甲、乙"});
});
