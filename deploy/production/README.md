# 生产后端部署脚本

- `upgrade.py` 是 1122 交接包中的原升级入口，供离线准备、配置、启停和检查使用。
- `upgrade-prod.py` 在原流程上补齐 Pi Agent 的 Nacos 原生注册配置，检查 Agent 载荷和端口。

使用与原升级器布局兼容的新版后端离线包。将两个脚本与包内的 `site_tasks.py`、`backend-payload.tgz`、校验文件和站点配置放在同一解压目录。Agent 载荷须包含 `2946131` 引入的原生注册入口和模块。

每台应用机用 `appuser` 和本机 Python 3.12，根据实际环境填写站点配置。Agent 的注册 IP 和端口来自 `node_ip`、`agent_port`，服务名由 `agent_service_name` 指定，默认 `ask-metric-agent-v2`，须与 Gateway 路由一致。

```bash
python3.12 upgrade-prod.py inspect --site site-prod.json
python3.12 upgrade-prod.py prepare --site site-prod.json
python3.12 upgrade-prod.py configure --site site-prod.json
```

确认生成的 Nacos 配置已发布、应用库已验收，再逐条执行 `validate → start → check`。切流前核对 Nacos 中的 Agent 实例、Gateway 分流、停机摘除和重启恢复。
