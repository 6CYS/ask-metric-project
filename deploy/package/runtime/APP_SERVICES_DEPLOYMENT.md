# Python 与 Agent 现场部署手册

这份手册对应 `ask-metric-app-services.sh`，用于两台 APP 机器上的两个进程。

- Python 后端监听 `8010`
- Node Agent 监听 `8020`

现场已经运行的 Nacos、Gateway、Nginx 和数据库由现有环境继续提供。脚本只负责解包后的 Python 依赖安装、Python 后端和 Node Agent 的启动、停止与健康检查。它不会执行 SQL，也不会发布 Nacos 配置。

## 一、部署前确认

每台 APP 机器使用同一版 `back.tgz`。以下目录必须来自同一个发布包。

```text
backend/runtime/
backend/wheels/ask_metric_backend_next-*.whl
agent-service/dist/server.js
node-runtime/node/bin/node
ops/constraints.txt
```

目标机需要满足以下条件。

- Linux x86_64
- 可以执行 Bash、`tar`、`curl` 和 `ss`
- 可用 Python 3.12
- Python 具备 `venv` 和 `ensurepip`，或者由系统提前安装对应组件
- `appuser` 能读发布包、读配置文件并写自己的状态目录
- 两台机器能访问已有 Nacos、应用数据库和模型服务

Node Agent 使用发布包里的 Node，不依赖目标机另外安装 Node.js。

先检查压缩包内容，不要直接启动旧目录中的进程。

```bash
tar -tzf /home/appuser/back.tgz | grep -E '(^|/)(backend/runtime/|backend/wheels/|agent-service/dist/server.js|node-runtime/node/bin/node|ops/constraints.txt)'
```

## 二、解包并放置脚本

以下命令在每台 APP 机器各执行一次。目录可以换成现场实际目录，后续命令保持一致。

```bash
mkdir -p /home/appuser/ask-metric
tar -xzf /home/appuser/back.tgz -C /home/appuser/ask-metric
```

如果脚本随压缩包一起提供，确认它位于解包后的 `ops/` 目录。如果脚本是单独上传的，执行以下命令。

```bash
cp /home/appuser/ask-metric-app-services.sh /home/appuser/ask-metric/ops/
chmod 700 /home/appuser/ask-metric/ops/ask-metric-app-services.sh
cd /home/appuser/ask-metric
```

解包后的脚本路径是：

```text
/home/appuser/ask-metric/ops/ask-metric-app-services.sh
```

本次部署不需要 `site.json`、`upgrade.py`、`upgrade-prod.py`、`site_tasks.py` 或 `up.py`。

## 三、准备 Python 的 backend.env

脚本默认读取：

```text
/home/appuser/ask-metric-config-phase2/backend.env
```

如果现场配置已经在其他位置，可以通过环境变量指定完整路径，不需要复制配置内容。

```bash
export ASK_METRIC_BACKEND_ENV=/实际路径/backend.env
```

当前 Python 后端使用现有 Nacos 配置和应用数据库。两台机器的配置大部分相同，下面几项需要按机器分别填写。

```dotenv
PORT='8010'
BUSINESS_CONFIGURATION_STORAGE='database'
NACOS_CONFIG_ENABLED='true'
NACOS_CONFIG_GROUP='ASK_METRIC_CONFIG'
NACOS_ENABLED='true'
NACOS_SERVICE_NAME='ask-metric-python'
NACOS_INSTANCE_PORT='8010'
NACOS_INSTANCE_IP='<本机真实 IP>'
NACOS_INSTANCE_ID='<本机唯一实例 ID>'
```

两台机器的 `NACOS_INSTANCE_IP` 和 `NACOS_INSTANCE_ID` 不能相同。`NACOS_CONFIG_GROUP` 是后端读取配置的分组，`NACOS_GROUP` 是服务注册分组，两者用途不同。现有 Nacos 地址、namespace、账号、数据库连接串、SM4 密钥路径和模型配置沿用现场已经确认的内容。

`backend.env` 不要放进 Git，也不要把密码、连接串或密钥写进本手册。脚本只读取它，不会改写它。

## 四、执行 install

进入解包目录执行：

```bash
cd /home/appuser/ask-metric
bash ops/ask-metric-app-services.sh install
```

`install` 的作用按顺序如下。

1. 检查后端目录、Python wheel、Agent 入口文件和随包 Node 是否存在。
2. 检查目标 Python 主版本和次版本是否为 3.12。
3. 在 `/home/appuser/venv-phase2` 创建虚拟环境，已存在时复用该目录。
4. 如果虚拟环境没有 pip，尝试执行 `ensurepip`。
5. 使用 `backend/wheels` 离线安装 `ask-metric-backend-next` 和 `uvloop`，不访问外网。
6. 使用 `ops/constraints.txt` 约束依赖版本。
7. 执行 `pip check` 和 Python 导入检查。
8. 创建 `/home/appuser/ask-metric-state-phase2/run` 和 `logs` 目录。
9. 第一次执行时生成 `/home/appuser/ask-metric-config-phase2/agent.env`。

`install` 不会启动服务，不会执行 SQL，不会修改 `backend.env`，也不会修改 Nacos、Gateway、Nginx 或数据库。

安装成功时会看到：

```text
INSTALL_OK
```

如果使用现场已有的 Python 3.12 虚拟环境，可以显式指定，但需要确认它确实是 Python 3.12，并且允许安装包内依赖。

```bash
ASK_METRIC_VENV=/home/appuser/已有虚拟环境 \
  bash ops/ask-metric-app-services.sh install
```

如果出现 `No module named pip`，脚本会先尝试 `ensurepip`。如果系统 Python 没有 `ensurepip`，需要由系统管理员补齐 Python 3.12 的 `venv` 和 pip 组件，然后重新执行 `install`。

## 五、准备 Agent 的 agent.env

`install` 第一次执行后会生成：

```text
/home/appuser/ask-metric-config-phase2/agent.env
```

编辑它：

```bash
vi /home/appuser/ask-metric-config-phase2/agent.env
chmod 600 /home/appuser/ask-metric-config-phase2/agent.env
```

两台 APP 共用应用数据库时，至少确认以下内容。

```dotenv
AGENT_SERVICE_HOST=0.0.0.0
AGENT_SERVICE_PORT=8020
BACKEND_BASE_URL=http://127.0.0.1:8010
BUSINESS_CONFIGURATION_STORAGE=database
AGENT_SESSION_STORAGE=database
AGENT_DEPLOYMENT_REPLICAS=2
AGENT_SESSION_DATABASE_URL=<现有应用库连接密文>
AGENT_MODEL_API_KEY=<现有模型密文>
ASK_METRIC_CONFIG_SM4_KEY_FILE=/home/appuser/ask-metric-config-phase2/config-sm4-uat.key
AGENT_DATA_DIR=/home/appuser/ask-metric-state-phase2/agent-data
```

这三个字段是脚本启动前的硬性检查项。

- `AGENT_SESSION_DATABASE_URL` 用于两台 Agent 共享会话和运行状态
- `AGENT_MODEL_API_KEY` 用于模型调用
- `ASK_METRIC_CONFIG_SM4_KEY_FILE` 指向现有 SM4 主密钥文件

连接串、模型密钥和 Nacos 密码按现场既有方式使用 `ENC[SM4:v1:...]` 密文。密文和主密钥必须匹配，不能把本手册中的占位符直接用于启动。

`BUSINESS_CONFIGURATION_STORAGE=database` 时，Agent 的业务配置、模型运行参数和提示词由应用库中的正式配置提供。不要为了让服务启动而随意补写本地模型地址或模型名。

## 六、Agent 的 Nacos 开关

当前现场已确认的 Nacos 配置清单中没有 Agent 运行配置 Data ID，也没有确认 Gateway 已经配置 `ask-metric-agent` 的服务发现路由。因此生成的 `agent.env` 默认是：

```dotenv
NACOS_CONFIG_ENABLED=false
NACOS_REGISTER_ENABLED=false
```

这表示 Agent 使用本地 `agent.env` 的基础配置，并且不向 Nacos 注册。此状态适合先验证两个进程和本地健康检查。

只有现场确认 Gateway 已经通过 Nacos 访问 `ask-metric-agent`，并且 Nacos 中已经准备好 Agent 的运行配置时，才在每台机器分别补齐以下配置。

```dotenv
NACOS_CONFIG_ENABLED=true
NACOS_CONFIG_GROUP=<Agent 配置分组>
NACOS_SERVER_ADDR=<Nacos 地址列表>
NACOS_NAMESPACE=public
NACOS_USERNAME=<Nacos 用户名>
NACOS_PASSWORD=<SM4 密文>
NACOS_REGISTER_ENABLED=true
NACOS_SERVICE_NAME=ask-metric-agent
NACOS_GROUP=DEFAULT_GROUP
NACOS_CLUSTER_NAME=DEFAULT
NACOS_INSTANCE_IP=<本机真实 IP>
NACOS_INSTANCE_PORT=8020
```

启用 Agent 注册只会让 Agent 注册、续约和注销实例，不会自动创建 Gateway 路由，也不会自动生成 Nacos 配置。

## 七、两台机器的差异

两台机器使用同一版 `back.tgz`，使用相同的应用数据库和兼容的 `agent.env`。每台机器需要独立确认以下字段。

| 项目 | APP-1 | APP-2 |
| --- | --- | --- |
| Python 端口 | 8010 | 8010 |
| Agent 端口 | 8020 | 8020 |
| Python Nacos 实例 IP | 本机 IP | 本机 IP |
| Python Nacos 实例 ID | 唯一 ID | 另一个唯一 ID |
| Agent 数据目录 | 本机 state 目录 | 本机 state 目录 |
| 日志目录 | 本机 state 目录 | 本机 state 目录 |

`AGENT_DEPLOYMENT_REPLICAS=2` 表示当前部署有两个副本，脚本不会在一台机器上自动启动两份 Agent。

## 八、启动与检查

配置完成后，在每台机器执行：

```bash
cd /home/appuser/ask-metric
bash ops/ask-metric-app-services.sh start
```

脚本先启动 Python，等待 `8010/health/ready` 成功后，再启动 Agent，等待 `8020/health/ready` 成功。成功时会输出：

```text
START_OK: Python 8010, Agent 8020
```

随后执行完整检查：

```bash
bash ops/ask-metric-app-services.sh check
bash ops/ask-metric-app-services.sh status
```

也可以直接访问本机健康接口：

```bash
curl --fail http://127.0.0.1:8010/health/ready
curl --fail http://127.0.0.1:8020/health/ready
```

日志位置如下。

```text
/home/appuser/ask-metric-state-phase2/logs/backend.log
/home/appuser/ask-metric-state-phase2/logs/agent.log
```

查看最近日志：

```bash
tail -n 100 /home/appuser/ask-metric-state-phase2/logs/backend.log
tail -n 100 /home/appuser/ask-metric-state-phase2/logs/agent.log
```

## 九、停止、重启和状态

停止两个服务：

```bash
bash ops/ask-metric-app-services.sh stop
```

重启两个服务：

```bash
bash ops/ask-metric-app-services.sh restart
```

只查看脚本记录的两个进程：

```bash
bash ops/ask-metric-app-services.sh status
```

脚本通过 PID 文件和命令行特征确认进程，只停止自己启动并记录的 Python 和 Node Agent。

## 十、常见问题

### 1. 找不到 wheel、server.js 或随包 Node

通常是压缩包解包层级不对，或者使用了不完整的旧包。回到包根目录检查：

```bash
pwd
ls -ld backend/runtime backend/wheels agent-service/dist node-runtime/node ops
ls backend/wheels/ask_metric_backend_next-*.whl
```

### 2. Python 版本不是 3.12

查看版本：

```bash
python3.12 --version
```

如果 Python 不在默认 PATH，指定绝对路径：

```bash
ASK_METRIC_PYTHON=/实际路径/bin/python3.12 \
  bash ops/ask-metric-app-services.sh install
```

### 3. `No module named pip`

这是 Python 虚拟环境缺少 pip。脚本会自动尝试 `ensurepip`。如果失败，补齐系统 Python 3.12 的 venv/pip 组件后重跑 `install`。

### 4. 8010 或 8020 已被占用

先确认占用进程，不要直接杀掉未知服务：

```bash
ss -ltnp | grep -E ':(8010|8020)\b'
```

确认是旧 Ask Metric 进程后，再停止旧进程并执行本脚本的 `start`。如果是其他业务占用，需要由现场决定端口或停止顺序。

### 5. 启动时报缺少 backend.env

检查默认路径：

```bash
ls -l /home/appuser/ask-metric-config-phase2/backend.env
```

配置在其他目录时指定：

```bash
ASK_METRIC_BACKEND_ENV=/实际路径/backend.env \
  bash ops/ask-metric-app-services.sh start
```

### 6. Agent 报数据库会话配置缺失

检查 `agent.env` 中这两项是否非空。

```dotenv
AGENT_SESSION_STORAGE=database
AGENT_SESSION_DATABASE_URL=<现有应用库连接密文>
```

两台 Agent 使用数据库会话时，必须连接同一个已完成相应版本迁移的应用库。脚本不会执行迁移 SQL。

### 7. Agent 报 SM4 主密钥不存在或解密失败

检查路径、权限和密钥内容：

```bash
ls -l /home/appuser/ask-metric-config-phase2/config-sm4-uat.key
```

主密钥文件需要能被 `appuser` 读取，并且必须与 `ENC[SM4:v1:...]` 密文来源一致。

### 8. 健康检查失败

先查看对应日志，再判断是配置、数据库、模型服务还是端口问题。

```bash
tail -n 100 /home/appuser/ask-metric-state-phase2/logs/backend.log
tail -n 100 /home/appuser/ask-metric-state-phase2/logs/agent.log
```

后端健康正常而 Agent 健康失败时，重点检查 Agent 数据库连接、SM4 主密钥和 `BACKEND_BASE_URL`。两个本机健康接口都正常而门户访问失败时，重点检查现有 Gateway 路由和 Nacos 服务发现配置。

## 十一、可选路径覆盖

默认路径适合本次 `/home/appuser` 部署。只有现场目录不同才使用这些变量。

```bash
export ASK_METRIC_ROOT=/实际解包目录
export ASK_METRIC_CONFIG_ROOT=/实际配置目录
export ASK_METRIC_BACKEND_ENV=/实际配置目录/backend.env
export ASK_METRIC_AGENT_ENV=/实际配置目录/agent.env
export ASK_METRIC_STATE_ROOT=/实际状态目录
export ASK_METRIC_VENV=/实际虚拟环境
export ASK_METRIC_PYTHON=/实际路径/bin/python3.12
```

端口默认是 Python `8010` 和 Agent `8020`。只有 Gateway、Nacos 注册信息和访问策略都同步调整时才改端口。

## 十二、部署完成标准

每台机器都满足以下条件后再交给 Gateway 链路测试。

```bash
bash ops/ask-metric-app-services.sh status
bash ops/ask-metric-app-services.sh check
```

应看到 Python 和 Agent 均为 running，并且 `check` 输出 `CHECK_OK`。这只证明两个本机进程已就绪，门户链路还需要使用现有 Gateway 进行一次真实请求验证。
