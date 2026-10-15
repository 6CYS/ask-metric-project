import {fileURLToPath} from 'node:url';
export default {test:{include:[fileURLToPath(new URL('./probe-agent.spec.ts',import.meta.url))],fileParallelism:false}};
