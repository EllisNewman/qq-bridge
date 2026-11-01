# M6：记忆与备份控制台

从 deepseek-harness/workspace/qq-bridge-changes/m6 的增量补丁迁入，保留 M3–M5 修复。尚未部署。

## 页面与接口

控制台新增「记忆与备份」：仅列私聊 scope，显示事实、事件摘要、归档行数/体积、待说想法和备份数。支持手动新增、置顶、撤回、蒸馏、印象导入预览、保留长期记忆的会话重置，以及全部私聊记忆重置。破坏性操作沿用确认提示。

GET /api/memory/scopes、GET /api/metrics、POST /api/memory/backup 均为管理端接口；未认证或带 agent token 的请求不可访问。群聊不出现在记忆列表。恢复固定返回 409，只允许停机 CLI；没有在线恢复按钮。

在线备份在蒸馏队列中执行，先刷新 sessions、social-v2 和 archive 索引再复制；备份包含完整 memory，archive 按勾选包含。指标不替代 token 账本。

## 本轮修复

- 会话加载有请求版本检查，旧响应不能覆盖新选择；空列表清理旧内容。
- 操作期间禁用控制按钮并拒绝重复提交。
- 会话统计与操作消息独立显示，刷新不覆盖备份位置/操作结果。
- 部分失败显示 errors 与 backupDir，蒸馏无新消息不再显示为新增成功。
- 备份列表请求失败会报错；导入预览显示候选文本。
- 事实及事件内容转义显示；只读/非活跃事实禁用策展按钮。
- 修正已归档事实指标，包含由 dropFacts 在原集合中标为 archived 的条目。
- 更正页面关于恢复自动备份的误导性说明。

## 验证

npm run test:console-memory 包含 10 项静态契约、隔离真实 HTTP 管理路由测试和页面异步逻辑测试。覆盖权限、私聊筛选、事实操作、指标、备份、恢复拒绝、旧响应隔离、成功提示保留、部分失败详情及内联脚本语法。

M3 reset、M4 distill、M5 proactive、memory-store 和 conversation-context 回归独立运行。未访问真实 QQ 或 DSH。

真实浏览器视觉验收未完成：临时 Playwright 安装遇到 ECONNRESET，且本机未找到 Chrome。需在有浏览器环境部署前检查桌面/窄屏布局、长表格和真实接口交互。
