# 模型配置保留在 Nacos

二期分布式部署可采用一期的模型配置管理方式，将 Python 和 Agent 的模型参数与密钥放在 Nacos。提示词、Skill、业务知识、主题及语义配置继续使用共享应用库。现有 r3 SQL 已提供这些资源的默认数据。已经有现场版本时，按原流程确认保留结果。

| 内容 | 二期运行时来源 |
|---|---|
| Python 模型地址、名称、调用路径、鉴权方式等 | Nacos 中的 `sznsznws_backend_model.json`，沿用一期文档格式 |
| Agent 模型地址、名称、超时、上下文和输出预算等 | Nacos 中的 `sznsznws_agent_model.json`，使用原迁移工具导出的 `agent-runtime.json` 文档格式 |
| Python 模型 API Key | Nacos 中的 `sznsznws_backend_security.yaml`，字段与模型的 `api_key_env` 对应 |
| Agent API Key | Nacos 中的 `sznsznws_agent_security.json` 的 `AGENT_MODEL_API_KEY` |
| 提示词、Skill、业务知识及其版本 | 共享应用库，沿用 r3 初始化和管理接口 |

Agent 继续通过后端已有配置接口按轮获取模型参数。Agent 的 `sznsznws_agent_runtime.json` 继续提供共享会话模式、部署副本数等启动参数。管理员页面按原权限读写，模型参数保存发布到 Nacos，提示词等仍按应用库版本机制发布。现有数据库结构与历史模型记录可保留。

## 部署

1. 按 r3 手册验证应用库结构与数据初始化均通过。升级成功的库可用独立只读验收。
2. 使用已包含本改动的 Python 后端包。若沿用现有二期替换包的 `upgrade.py configure`，先完成现场配置转换，再核对其受保护目录中的 `backend-models.json` 和 `agent-runtime.json`。前者来自一期实际模型配置。后者在模型协议可映射或已有 Agent 配置时导出。缺失时按实际模型端点补齐并校验，避免照搬测试模型。
3. 将这两个文件的内容分别发布到二期实际 namespace 和 group 下的 `sznsznws_backend_model.json` 与 `sznsznws_agent_model.json`。旧配置组可供回退。此模式直接使用上述 Nacos 文件，现有手册的 `import-models` 步骤不适用于此模式。
4. 按现有安全配置流程把 API Key 的 SM4 密文合并到对应安全文档。所有节点继续使用原主密钥。Agent 安全文档保留共享会话连接字段。
5. 在每个二期 Python 节点生成的受保护引导文件中配置以下三项，然后按原流程切换后端。二期所有节点应读取相同的 namespace 和配置组。Agent 保持共享业务配置和共享会话设置。

```dotenv
BUSINESS_CONFIGURATION_STORAGE=database
NACOS_CONFIG_ENABLED=true
MODEL_CONFIGURATION_STORAGE=nacos
```

## 验收和回退

- 分别从两个节点核对当前 Python 和 Agent 模型。发布一次参数调整，刷新后两节点应读取同一版本。使用旧版本保存应收到冲突提示。
- 用管理员检查提示词、Skill 和业务知识仍可维护。完成模型诊断，再用普通用户验证一条明确机构、日期和指标的问数。
- Agent API Key 在 Agent 进程启动时加载，密钥更新后按节点滚动重启。普通模型参数按请求读取。
- Nacos 模式按当前文档版本绑定查询和测评。切换来源或发布新 Agent 参数前，先收尾使用旧版本的在途问数和测评。需要重新读取已退出使用的版本时，系统会明确提示重新发起。参数回退使用 Nacos 的发布历史。
- 如恢复模型入库模式，先在共享库核对或导入要使用的模型参数，然后把各 Python 节点的 `MODEL_CONFIGURATION_STORAGE` 统一恢复为 `inherit`。应用库切换开关和共享会话继续按原配置管理。
