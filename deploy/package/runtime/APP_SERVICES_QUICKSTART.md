# 两台 APP 启动清单

本次只启动两台 APP 上的 Python 后端和 Node Agent。现场已有的 Nacos、Gateway、数据库、Nginx 不由脚本管理，脚本不会执行 SQL、发布 Nacos 配置或修改 Gateway。

## 1. 放包和脚本

每台机器使用 `appuser` 执行。假设最新包是 `/home/appuser/back.tgz`，脚本文件已经上传到 `/home/appuser/ask-metric-app-services.sh`。

```bash
mkdir -p /home/appuser/ask-metric
tar -xzf /home/appuser/back.tgz -C /home/appuser/ask-metric
cp /home/appuser/ask-metric-app-services.sh /home/appuser/ask-metric/ops/
chmod 700 /home/appuser/ask-metric/ops/ask-metric-app-services.sh
cd /home/appuser/ask-metric
```

解包后应存在：

```text
backend/runtime/
backend/wheels/
agent-service/dist/server.js
node-runtime/node/bin/node
ops/constraints.txt
```

本次不使用 `site.json`、`upgrade.py`、`upgrade-prod.py`、`site_tasks.py` 或 `up.py`。

## 2. 确认 Python 配置

脚本默认读取：

```text
/home/appuser/ask-metric-config-phase2/backend.env
```

两台机器各自确认本机真实 IP 和实例 ID，Python 端口固定为 8010：

```dotenv
PORT='8010'
BUSINESS_CONFIGURATION_STORAGE='database'
NACOS_CONFIG_ENABLED='true'
NACOS_CONFIG_GROUP='ASK_METRIC_CONFIG'
NACOS_ENABLED='true'
NACOS_SERVICE_NAME='ask-metric-python'
NACOS_INSTANCE_IP='<本机 IP>'
NACOS_INSTANCE_PORT='8010'
NACOS_INSTANCE_ID='<本机唯一实例 ID>'
```

其他 Nacos 地址、namespace、group、账号和 SM4 密钥路径沿用现有配置。脚本只读取这份文件，不修改它。

## 3. 安装

```bash
bash ops/ask-metric-app-services.sh install
```

脚本默认使用 Python 3.12，并在 `/home/appuser/venv-phase2` 创建或复用虚拟环境，从包内 wheel 离线安装。现场已经有其他虚拟环境时可指定：

```bash
ASK_METRIC_VENV=/home/appuser/已有虚拟环境 \
  bash ops/ask-metric-app-services.sh install
```

如果出现 `No module named pip`，脚本会先尝试 `ensurepip`。若机器的 Python 没有 `ensurepip`，先补齐 Python 3.12 的 venv/pip，再重跑这条命令。

首次安装会生成：

```text
/home/appuser/ask-metric-config-phase2/agent.env
```

## 4. 填 Agent 配置

```bash
vi /home/appuser/ask-metric-config-phase2/agent.env
```

两台 APP 共用应用库时，至少填下面三项。连接串和模型密钥使用已有 SM4 密文，不填写明文：

```dotenv
AGENT_SERVICE_HOST=0.0.0.0
AGENT_SERVICE_PORT=8020
BACKEND_BASE_URL=http://127.0.0.1:8010
BUSINESS_CONFIGURATION_STORAGE=database
AGENT_SESSION_STORAGE=database
AGENT_DEPLOYMENT_REPLICAS=2
AGENT_SESSION_DATABASE_URL=<现有应用库连接密文>
AGENT_MODEL_API_KEY=<现有模型密钥密文>
ASK_METRIC_CONFIG_SM4_KEY_FILE=/home/appuser/ask-metric-config-phase2/config-sm4-uat.key
NACOS_CONFIG_ENABLED=false
NACOS_REGISTER_ENABLED=false
AGENT_DATA_DIR=/home/appuser/ask-metric-state-phase2/agent-data
```

当前 Nacos 配置清单没有确认 Agent 的运行配置 Data ID，因此 Agent 配置读取默认关闭。只有现有 Gateway 已经配置 `ask-metric-agent` 服务发现时，才把 `NACOS_REGISTER_ENABLED` 改成 `true`，并补齐 Agent 的 Nacos 地址、账号、密钥和本机 IP。打开注册不会自动新增 Gateway 路由。

## 5. 启动、检查和停止

```bash
bash ops/ask-metric-app-services.sh start
bash ops/ask-metric-app-services.sh check
bash ops/ask-metric-app-services.sh status
```

启动顺序是 Python 8010，再启动 Agent 8020。日志在：

```text
/home/appuser/ask-metric-state-phase2/logs/backend.log
/home/appuser/ask-metric-state-phase2/logs/agent.log
```

停止服务：

```bash
bash ops/ask-metric-app-services.sh stop
```

脚本只停止自己记录且命令行匹配的进程，不会杀掉其他服务。

## 6. 验收边界

`check` 只检查本机 Python 和 Agent 的 `/health/ready`。门户能否访问 Agent 还取决于现有 Gateway 是否已经有对应路由和发现目标，本脚本不新增或修改该路由。
