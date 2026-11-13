/** 离线迁移材料：复用运行时校验，仅输出非敏感业务配置，不写数据库。 */
import { readFile, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { parseArgs, parseEnv } from "node:util";
import { loadRuntimeConfig } from "../dist/nacosConfig.js";
import { loadBusinessSkills } from "../dist/businessSkills.js";
import { BusinessSkillStore } from "../dist/businessSkillStore.js";
import { agentRuntimeImportDocument } from "../dist/databaseAgentRuntime.js";
import { validateTopicRegistry } from "../dist/inquiry/topics/registry.js";

try {
  const { values } = parseArgs({
    options: {
      env: { type: "string" },
      root: { type: "string" },
      output: { type: "string" },
      "data-dir": { type: "string" },
      "answer-streaming": { type: "string" },
    },
  });
  if (!values.env || !values.root || !values.output) throw new Error("arguments");
  const root = resolve(values.root);
  const env = { ...process.env, ...parseEnv(await readFile(resolve(values.env), "utf8")) };
  if (env.BUSINESS_CONFIGURATION_STORAGE === "database") throw new Error("source_is_database");
  env.BUSINESS_CONFIGURATION_STORAGE = "file";
  if (values["data-dir"]) env.AGENT_DATA_DIR = resolve(values["data-dir"]);
  if (values["answer-streaming"] !== undefined)
    env.AGENT_ANSWER_STREAMING = values["answer-streaming"];
  const config = await loadRuntimeConfig(env);
  // 旧行内角色包的网关兼容开关迁入已有模型扩展参数，不在运行时继续依赖旧文件。
  if (env.AGENT_MODEL_TOOL_CHOICE_POLICY === "auto") config.model.extraBody.tool_choice = "auto";
  const dataDir = resolve(root, config.dataDir);
  const skills = await loadBusinessSkills(join(root, "skills"));
  // 原加载器校验覆盖文件，拒绝损坏内容，不用默认正文掩盖错误。
  new BusinessSkillStore(dataDir, skills);
  let overrides = {};
  try {
    overrides = JSON.parse(await readFile(join(dataDir, "business-skills.json"), "utf8")).overrides;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const topics = validateTopicRegistry(
    JSON.parse(await readFile(join(root, "config/inquiry-topics.json"), "utf8")),
  );
  const document = {
    runtime: agentRuntimeImportDocument(config),
    skills: skills.map((skill) => ({
      name: skill.name,
      description: skill.description,
      content: skill.content,
      disable_model_invocation: skill.disableModelInvocation ?? false,
    })),
    overrides,
    topics,
  };
  await writeFile(resolve(values.output), JSON.stringify(document, null, 2) + "\n", {
    flag: "wx",
    mode: 0o600,
  });
  console.log(
    JSON.stringify({
      status: "exported",
      skills: skills.length,
      overrides: Object.keys(overrides).length,
    }),
  );
} catch {
  console.error("Agent配置导出失败：核对参数、源环境、编译产物及业务文件；未输出凭据或配置正文。");
  process.exitCode = 1;
}
