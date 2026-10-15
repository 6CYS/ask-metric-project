# 数字农商前端与 Nginx 部署

本方案把问数发布到数字农商的 `/bgwblj/znws` 路径下。前端必须重新构建，Nginx 必须同步更新：只改代理规则，已有 JavaScript 仍会请求根路径 `/api`，部分地址栏跳转也会丢失前缀。

依据 `docs/数字农商与外围系统对接规范V2.0.docx` 第三章，以及 `docs/江苏省农村商业联合银行云平台web中间件nginx标准规范v4.5.0.docx` 的端口、目录、域名和动态解析要求。对接示例中的 `upstream`、IP `server_name` 和丢失 `/bgwblj` 的跳转不能直接照搬；本配置按 v4.5.0 和本项目路径生成。

## 本次修改的位置

| 文件 | 修改与作用 |
| --- | --- |
| `frontend-vue/.env.bank` | 页面前缀 `/bgwblj/znws/static/`，接口前缀 `/bgwblj/znws` |
| `frontend-vue/vite.config.ts` | 将页面前缀接入 Vite `base`，统一校验本站路径；开发代理支持同样的接口前缀和 Cookie Path |
| `frontend-vue/src/router/index.ts` | 原有 `createWebHistory(import.meta.env.BASE_URL)` 自动取得构建前缀；SSO 清除 token 时使用含 base 的 `router.resolve(...).href`，不能使用不含 base 的 `fullPath` |
| `frontend-vue/src/views/SsoEntryView.vue` | 重试会话通过路由解析取得完整 URL，不再直接跳转根路径 `/chat` |
| `frontend-vue/src/lib/api.ts` | 普通请求、认证、上传、下载统一追加接口前缀；浏览器不再使用构建环境中的后端域名 |
| `frontend-vue/index.html` | 图标使用 `%BASE_URL%`，随页面部署路径生成 |
| `frontend-vue/package.json` | 新增 `npm run build:bank`，明确选择数字农商构建模式 |
| `deploy/nginx/8090.conf` | 静态文件、SPA 刷新、跳转、动态域名代理和会话 Cookie 路径配置 |

Vue Router 内部仍使用 `/chat`、`/login` 等路由，不需要把所有 `RouterLink` 手工改成带前缀的地址。路由 base 会统一生成 `/bgwblj/znws/static/chat` 等浏览器 URL。`to.fullPath` 用于路由内部回跳参数时仍然正确；只有直接写入浏览器地址栏时必须使用包含 base 的 `href`。

## 请求如何转发

| 浏览器请求 | Nginx 处理结果 |
| --- | --- |
| `/bgwblj/znws` 或 `/bgwblj/znws/static` | 跳转 `/bgwblj/znws/static/`，保留查询参数 |
| `/bgwblj/znws/static/` | `/home/source/html/frontend/index.html` |
| `/bgwblj/znws/static/chat`、`/bgwblj/znws/static/metrics` 等子路由 | 不存在实体文件时回退同一 `index.html`，地址栏不跳回根路径 |
| `/bgwblj/znws/static/assets/文件名.js` | `/home/source/html/frontend/assets/文件名.js`；不存在则 404，不返回 HTML |
| `/bgwblj/znws/api/v1/auth/sso` | F5 → 原后端网关 `/api/v1/auth/sso` |
| `/bgwblj/znws/api/v1/catalog/metrics?page=1` | F5 → 原后端网关 `/api/v1/catalog/metrics?page=1` |

页面入口向数字农商登记为 `https://实际入口域名/bgwblj/znws/static/sso-entry`，平台追加 `?token=...`。`https` 由外层平台/F5 终止，应用 Nginx 只监听 HTTP 8090。不要登记成根路径 `/sso-entry`。

## 与截图中的配置衔接

保留现有静态目录 `/home/source/html/frontend`，只替换其内容。保留网关收到的 `/api/...` 路径、Authorization 透传和 `proxy_buffering off`。截图中的三个网关 9000 端口节点由行方加入后端 F5 池；前端和本配置不维护节点列表。

交付文件是一个 `server` 块，应由主配置 **http 块**下的 `include /etc/nginx/conf.d/*.conf;` 加载，不能放在现有 `server` 块里。请由云平台确认实际花括号层级。截图的主配置包含旧 `gateway_cluster`、8089/IP 服务块以及标准日志、resolver 等；本文件不会替换整个主配置，也不会让其中的旧定义自动消失。申请云平台按标准主配置整理旧业务块，同时将外层转发目标切至 8090。不要自行复制截图里的主配置进行覆盖。

新文件不定义 `upstream`、`resolver`、`access_log`、`error_log`、TLS 证书或 `stream`。复用云平台现有 DNS 动态解析和标准日志。截图中的 `X-Forwarded-Port $server_port` 未沿用，避免把内部 8090 错当作浏览器外部端口。

监听和转发没有删除，而是集中在子配置的 `server { listen 8090; ... }` 和 `location` 中。
主配置通过 `http { ... include /etc/nginx/conf.d/*.conf; }` 加载它们。先准备完整子配置、
确认加载层级并通过 `nginx -t`，再协调入口端口从 8089 切至 8090；不能只删除旧业务块。
旧 `gateway_cluster` 清理前须确认没有其他配置引用。标准日志、DNS 和其他平台参数保持原样。

## 替换两个双引号占位值

打开 [8090.conf](8090.conf)，替换：

1. `server_name "replace-with-frontend-domain.dmp.jsrcb";`：填写进入本 Nginx 的实际 Host 域名。若数字农商代理保留门户 Host，应填写对应门户域名；多个已确认域名可各自加双引号，以空格分隔。不能填写 IP、localhost 或空值，也不能填写 URL、路径、端口。
2. `set $znws_backend_f5 "replace-with-backend-f5-domain.dmp.jsrcb:80";`：填写你申请的**后端网关 F5 域名及 HTTP 虚拟服务端口**，保留双引号，不加 `http://` 或路径。这里的 80 是待确认端口，不能由网关节点的 9000 端口推断 F5 端口。

保留下一行 `proxy_pass http://$znws_backend_f5;` 的形式。动态域名会使用主配置 resolver，F5 DNS 和虚拟服务须能从 Nginx 节点访问。

### 测试环境没有 F5

可以将后端变量临时填写为一个已确认可达的 Java 网关节点，例如截图中的节点仍可用时：

```nginx
set $znws_backend_f5 "77.16.65.63:9000";
```

`proxy_pass http://$znws_backend_f5;` 保持不变。这只提供单节点转发，不提供负载均衡或故障切换。
该地址不是浏览器入口、Nginx 8090 地址或 Python 后端地址；以后改为 F5 域名和虚拟服务端口即可。
仓库中的 `8090.conf` 保持通用占位模板，实际环境值填入发布副本。

### 三类地址不要混填

| 配置 | 正确格式 | 示例 |
| --- | --- | --- |
| Nginx `server_name` | 实际 Host 域名，不带协议、端口和路径 | `"mh.dmp.jsrcb"`（仅当进入 Nginx 的 Host 确为此域名） |
| 网关 `allowedOriginPatterns`、后端 `cors_origins` | 浏览器 origin，包含协议及非默认端口，不带路径 | `"https://mh.dmp.jsrcb"` |
| `$znws_backend_f5` | 后端域名或测试节点 IP，加实际端口，不带协议和路径 | `"77.16.65.63:9000"`（单节点测试） |

例如问数页面地址为 `https://mh.dmp.jsrcb/bgwblj/znws/static/chat`，允许来源填写
`"https://mh.dmp.jsrcb"`。若问数在 iframe 内，以 iframe 内问数页面的 origin 为准，可核对认证请求的
`Origin` 请求头。测试时通过 `http://77.6.82.133:8090/...` 访问，则对应 origin 是
`"http://77.6.82.133:8090"`，但不能把这个完整 URL 填入 `server_name`；云平台要求该字段使用域名。
HTTP/IP 直连可以核对转发路径，UAT/生产 Secure Cookie 的登录刷新恢复需通过 HTTPS 入口验证。

外层数字农商代理应将 `/bgwblj/znws/**` 完整转给本 Nginx，不提前剥离本方案使用的前缀。后端 F5 保持 `/api/...` 不变，不应重新加回 `/bgwblj/znws`。F5 池健康检查由行方按后端网关实际接口配置；本文件 `/health` 只表示 Nginx 存活。

## 单点登录与两层网关的变更边界

已核对 `D:/workFile/支持工作相关文件/江苏农商/ask-metric-intent-gateway` 当前工作区的
`config/nacos/znws_gateway.yaml`、`config/local/znws_gateway_fallback.yaml` 和配置刷新监听器。
这里记录的是代码和模板结论，尚未读取行方 Nacos 运行值；网关工作区已有未提交改动，本次没有修改该仓库。

| 位置 | 是否需要调整 |
| --- | --- |
| 数字农商登记的问数入口 | 需要，将旧入口换成 `https://实际入口域名/bgwblj/znws/static/sso-entry`，平台继续追加原 `token` 参数；改完重新联调 |
| 数字农商前置网关/DMZ 代理 | 需配置或核对 `/bgwblj/znws/**` 到问数 Nginx 8090 的路由，转发时保留此前缀；这是平台侧路由，不是下面的问数后端网关 |
| 问数 Nginx | 使用本文件：页面本地托管，API 去除 `/bgwblj/znws` 后经 F5 转到问数网关 |
| 问数网关的 `/api/**` 路由 | 保持 `Path=/api/**` → `lb://ask-metric-python`；没有必要改成 `/bgwblj/znws/**`，也不要新增 `StripPrefix` 或重复重写路径 |
| 问数网关的 `/**` 前端兜底 | 本方案的页面由 Nginx 直接托管，不经过该路由；不必因前缀修改 URI，更不能让它成为错误 API 请求来回代理的补救办法 |
| 问数网关 CORS | 核对 Nacos Data ID `znws_gateway.yaml` 的实际允许来源；模板仅列 localhost，需加入浏览器入口精确 origin，已有正确来源可保留 |
| 后端 SSO token 反查接口 | 地址、参数和认证协议不因前端路径变化而改变；后端仍通过平台反查 token |
| Python 后端来源配置 | 核对 `sznsznws_backend_runtime.yaml` 中的 `cors_origins`，与浏览器实际 origin 一致，不填写 `/bgwblj/znws` 路径 |

网关 CORS 字段的完整层级为：

```yaml
# 合并到现有 znws_gateway.yaml 的对应字段；不是用于覆盖完整配置的文件。
spring:
  cloud:
    gateway:
      server:
        webflux:
          globalcors:
            cors-configurations:
              '[/**]':
                allowedOriginPatterns:
                  - "https://replace-with-browser-entry-domain.dmp.jsrcb"
```

保留现有 methods、headers、exposedHeaders、credentials 等配置。若同时支持多个已确认入口，逐项添加精确 origin。网关使用 Nacos 的运行配置优先；远程字段已写死时，仅修改本地 `GATEWAY_CORS_ALLOWED_ORIGIN_PATTERNS` 并不能覆盖它。该项目现有监听器支持路由、默认过滤器、HTTP 超时和 CORS 热更新，不需要仅为上述 CORS 调整重新编译 JAR。

网关配置已有 `server.forward-headers-strategy: framework`。联调应核对可信转发头及实际后端看到的 Host/协议；不要只根据这个开关断定多层代理后的来源一定正确。若现场 API 路由还存在 `StripPrefix`、`RewritePath`、`RemoveRequestHeader` 或 Cookie 重写过滤器，应与本 Nginx 合并核对，避免两层重复处理。

## 构建和交付

在 `frontend-vue/` 执行：

```bash
npm ci
npm run typecheck
npm run build:bank
```

Windows 若 PowerShell 阻止 `npm.ps1`，使用对应的 `npm.cmd` 命令。产物在 `frontend-vue/dist/`。应看到 `dist/index.html` 的 JS、CSS、图标地址均以 `/bgwblj/znws/static/` 开头。不要把 `.env.bank.local` 或进程环境中的同名变量设置成其他路径；Vite 高优先级环境值仍会覆盖模式文件。

交付至云管上传平台的文件布局：

```text
/etc/nginx/conf.d/8090.conf
/home/source/html/frontend/index.html
/home/source/html/frontend/ask-metric.ico
/home/source/html/frontend/assets/...
```

上传 `dist` 的**内容**，不要多嵌套一层 `dist` 目录。由云平台管理 nginx 用户和文件权限。主配置默认 MIME 映射需保留。

`npm run build` 继续用于原有根路径部署；其产物应配套原独立部署 Nginx。当前 `deploy/package/build_bundle.py` 默认构建 production 模式，不能直接将它重建的根路径前端用于这里。数字农商前端按上述专用流程单独交付，后端仍可沿用现有原生离线发布流程。

## 登录与刷新所需的配套条件

后端继续使用 `/api/v1/auth` 作为内部认证路径。Nginx 将 `Set-Cookie` 中的 Path 改为 `/bgwblj/znws/api/v1/auth`，登录、恢复和退出都必须经过这条代理路径；否则刷新时浏览器不会携带正确的 Cookie，或者退出无法删除它。HttpOnly、Secure、SameSite 属性保持后端原值，访问令牌仍不写入 Web Storage。

可信外层代理须覆盖并传递浏览器原始 Host、`X-Forwarded-Proto`，后端网关继续保留它们。不能让外部用户伪造的转发头直接作为可信来源。后端在 Nacos 运行配置 `cors_origins` 中填写浏览器实际入口的**精确 origin**（协议、域名及非默认端口，不含路径）；不要使用 `*` 来绕过认证来源检查。生产 Secure Cookie 需要浏览器通过 HTTPS 访问，即使 F5 至 Nginx 使用 HTTP。

页面 CSP 已允许同源以及规范列出的 `mh.dmp.jsrcb`、`szns.dmp.jsrcb` 的 HTTP/HTTPS 门户嵌入。如实际 UAT 门户域名或端口不同，只追加平台确认的 origin，不使用 `frame-ancestors *`。若上层还发送会阻止嵌入的 X-Frame-Options/CSP，需由该层按平台策略处理，子配置不能靠增加一个空头消除其他响应头。

## 验收

本次本地验证已通过前端 typecheck、普通构建、bank 构建、Nginx 1.30.2 Windows 版 `nginx -t`，以及使用本机模拟后端的无界面浏览器验证：SSO 原 token 透传、去除 token 后保留前缀、菜单跳转、刷新恢复、退出删除 Cookie、重试会话、SPA 刷新回退、缺失资源 404、API 请求体/查询参数/鉴权头转发和重定向改写。该验证不连接行方 F5、Nacos、数据库或真实 SSO；Linux 标准主配置、DNS 解析及真实网关联调仍须在现场完成。构建仅有现有图表分包超过 500 kB 的提示，无构建错误。

替换占位符后，在安装了同版 Nginx 的环境将子配置纳入标准主配置并执行 `nginx -t`，通过后按云平台流程发布。前端构建检查不等于 F5、数字农商网关和真实认证联调。

- 从平台携 token 进入，验证地址栏移除 token 后仍为 `/bgwblj/znws/static/...`。
- 点击聊天、指标、机构等菜单，刷新和浏览器后退均保留完整前缀；认证失败及重试恢复会话也不跳到根路径。
- 浏览器 Network 中认证、目录、问数、导入和导出都请求 `/bgwblj/znws/api/...`；网关收到 `/api/...`，查询参数、请求体和鉴权头保持不变。
- 登录后刷新可恢复；退出后再次刷新不能恢复；检查 Cookie Path 为 `/bgwblj/znws/api/v1/auth`。
- 缺失 JS/CSS 返回 404；页面入口不长时间缓存；API 错误不回退为首页 HTML。
- 查询耗时须同时满足数字农商代理、F5、后端网关和本层超时；本层读取/发送超时为 190 秒，不沿用截图中 3600 秒作为全部链路的默认值。
