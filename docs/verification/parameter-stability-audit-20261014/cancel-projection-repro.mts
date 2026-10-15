import {projectEntries} from "../../../agent-service/src/sessionProjection.ts";
const entries:any=[{id:"user",parentId:null,type:"message",seq:1,timestamp:1,message:{role:"user",content:"查询合成指标",businessProtocol:"frame_v1",timestamp:1}},{id:"cancel",parentId:"user",type:"message",seq:2,timestamp:2,message:{role:"assistant",content:[],stopReason:"aborted",errorMessage:"模型请求已取消。",timestamp:2}}];
console.log(JSON.stringify({case:"user-cancel-history",messages:projectEntries(entries)},null,2));
