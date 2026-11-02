# 行内 UAT 快速部署清单

版本：uat-pi-20261009-r1。新版 Nacos 配置读取、完整离线包、数据库增量核对和 Docker 模拟验证已完成。**现场直接按[部署执行手册](行内UAT部署执行手册.md)操作。**

| 项目 | 已确认方案 |
| --- | --- |
| 前端 | 77.6.79.36；appuser 独立 Nginx，8090 |
| 后端 + Agent | 77.16.60.204；8010 + 8020 |
| 系统 | 后端麒麟 x86_64、glibc 2.28、Python 3.12.0 |
| Node | 离线包内 Node 22.23.2，无需现场安装 |
| Nacos | 复用 .204/.40/.91:8848，public；新配置组 ASK_METRIC_CONFIG_PI_UAT_R1 |
| 服务注册 | DEFAULT_GROUP；ask-metric-python-pi-uat |
| 原配置/密钥 | 复用 /home/appuser/ask-metric-config-uat/backend.env 及原 SM4 key |
| 旧入口 | 保留原 8089 Nginx 和三台 Gateway :9000 |
| 权限 | 所有本包部署命令无 sudo，程序/状态均在用户目录 |

基础环境检查已经完成，不再重复手敲。首次部署：两台各 5 条上传后解压命令，后端 8 条、前端 2 条，另 3 条最终连通检查。DBA 审核执行、受控配置核对和页面验收另计。

部署前协调三个事项：网络允许新端口/依赖访问；Nacos 新组授权及真实模型 SSE/tools/窗口/SSO；DBA 实际增量与正式机构权限映射。

执行顺序：上传校验解压 → 后端 install / prepare → 核对生成配置 → publish → sql 交 DBA → db / sync / start / check → 前端 front / front-check → 页面真实验收。

浏览器 → Nginx；/api/ → Python；/agent-api/ → Agent → Python。Python/Agent 从 Nacos 读业务配置，Python 同时注册服务。Nacos 不转发网页请求。

详细配置与旧版差异见[配置说明](行内UAT完整部署指南.md)。不要执行旧准备文档中的占位方案，所有实际命令以当前执行手册为准。
