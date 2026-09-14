# Ask Metric Vue Frontend

Ask Metric 的正式 Vue 3 前端，只连接 `backend-next` FastAPI 后端。

## 本地运行

先按 [本地部署指南](../docs/本地部署指南.md) 完成后端及账户配置。使用 Node.js 22.12+（22.x）或 24.x；以下命令在 `frontend-vue/` 执行。

```bash
npm ci
npm run dev
```

默认地址：<http://localhost:5173>

开发服务器会将 `/api` 请求代理到 `http://localhost:8010`。如需调整后端地址，可以设置：

```dotenv
VITE_BACKEND_NEXT_BASE_URL=http://localhost:8010
```

问数链路严格按 `questions → analyze → execute` 调用。澄清提交携带原 `task_id`、`task_version` 和 `clarification_id`，不会拼接原始问题；会话 ID 保存在浏览器本地，刷新时通过 `backend-next` 会话快照恢复任务和结果。

生产构建默认通过 Nginx 使用同源 `/api` 访问后端，发布产物不得包含本机回环地址。

## 聊天交互

登录有效期默认 8 小时，由后端 `JWT_EXPIRE_MINUTES` 决定。有效期内刷新会通过后端 HttpOnly
Cookie 恢复原会话，不延长到期时间；过期、退出或服务端撤销后需要重新登录。访问令牌只在页面
内存中使用，不写入 Web Storage。所有认证请求固定走同源 `/api/v1/auth/`，开发时由 Vite 代理，
生产由 Nginx/网关代理，不能改为浏览器跨域携带 Cookie。生产入口要求 HTTPS；升级及来源配置
见 [后端登录说明](../backend-next/README.md#登录有效期与刷新恢复)。

聊天页和测试中心通过 `/api/v1/query-readiness` 检查后端目录初始化状态。启动预热期间显示进度，
禁用提问、补充条件和“开始测试”，就绪后自动开放；初始化失败或连接异常会提示并自动刷新状态。
初始化期间仍可查看历史结果。新前端须与支持该状态接口的后端同步部署。

当前只提供单次可信问数、当前任务澄清和历史结果查看/导出。旧归因运行入口、进度轮询和停止分析按钮已移除；
每次查询完成后再发消息会创建独立问题，不继承上一轮条件；缺失条件会再次澄清。
当前未完成任务的补充回答继续使用原任务标识。旧跨任务澄清只读，不能恢复执行。
普通语义解析继续调用 `analyze`。历史归因结果保留只读展示，旧归因澄清不再提供可操作表单。
升级时须同步部署配套后端，配置合并要求见 [后端升级说明](../backend-next/README.md#旧归因原型退出与升级)。

- 历史回复显示消息创建时间。会话快照使用消息级 `created_at`，前端兼容旧 `payload.created_at`；两者均缺失时不伪造时间。消息仍按任务轮次和事件顺序排列。
- Enter 发送，Shift+Enter 换行；纯空白输入不发送、不累积空行。输入框最多增高到 144px，长文本在框内滚动，发送按钮垂直居中。
- 当前会话的本次提问或补充回答新产生指标或机构澄清时，输入框上方自动展开对应目录，候选优先展示。进入、刷新或切回历史会话时不自动展开，即使历史仍待澄清；可点击“＋”手动继续选择。可切换“指标／机构”、搜索并连续选择；名称直接写入正文，点击“继续输入”补充日期后一起发送。关闭后可点击输入框左侧“＋”重开，也保留 `/指标`、`/机构` 快捷搜索。快捷键说明放在发送按钮的悬停提示中，不另占底栏。
- 只缺日期时直接在对话补充，历史已结束的澄清不自动弹窗；编辑或删除已选名称后不携带旧编号。

## 生产构建

先强制清空构建子进程的后端地址，再构建。PowerShell（借助项目已有 Python，避免旧 PowerShell 将空环境变量直接删除而回退到 `.env.local`）：

```powershell
npm ci
python -c "import os,shutil,subprocess; subprocess.run([shutil.which('npm.cmd') or shutil.which('npm'),'run','build'],env=dict(os.environ,VITE_BACKEND_NEXT_BASE_URL=''),check=True)"
```

Linux：

```bash
npm ci
VITE_BACKEND_NEXT_BASE_URL= npm run build
```

产物为 `dist/`，由 Nginx 托管并代理 `/api`。`npm run preview` 只用于预览静态产物，未配置开发代理，不能替代生产反向代理；不要以直接打开 `dist/index.html` 验证完整应用。
