/** 合成目录调用真实 Python 指标算法；不访问数据库或模型。 */
import {execFile} from "node:child_process";
import {promisify} from "node:util";
import {join, resolve} from "node:path";
import type {MetricMentions} from "../src/business-context/metricMentions.js";

const run = promisify(execFile);
export function syntheticMetricResolver(items: Array<{code: string; name: string; aliases?: string[]; description?: string}>) {
  return async (question: string): Promise<MetricMentions> => {
    const cwd = resolve(import.meta.dirname, "../../backend-next");
    const {stdout} = await run(join(cwd, ".venv/bin/python"), ["-c",
      "import json,sys;from ask_metric.application.metric_candidates import MetricCandidateIndex;from ask_metric.domain.semantics import MetricCatalogItem;items=[MetricCatalogItem(**i) for i in json.loads(sys.argv[1])];print(json.dumps({'mentions':MetricCandidateIndex(items).mentions(sys.argv[2])},ensure_ascii=False))",
      JSON.stringify(items), question], {cwd, env: {...process.env, PYTHONPATH: join(cwd, "src")}});
    return JSON.parse(stdout);
  };
}
