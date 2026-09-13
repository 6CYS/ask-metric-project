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
