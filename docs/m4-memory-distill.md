# M4：私聊蒸馏与会话交接

从留档 m4 增量迁入，保留 M3 修复及原文上下文功能。尚未部署。

## 行为

私聊归档按消息量、空闲时间、每日 UTC+8 04:00 或管理员 POST /api/memory/distill 触发。qq-memory 是零工具 preset，缺失时不退回普通 preset。手动请求可绕过 distill.enabled，但不能绕过 memory.enabled。memberImpressions 仅为线索，默认保留轻量注入，可用 memory.inject.lightweightImpressions=false 关闭私聊印象块。

日终任务在同一串行队列直接执行子任务，避免嵌套排队自锁；覆盖存档 scope，并排空已有窗口后生成摘要。episode 日期取证据消息时间。定时调度不依赖容器本地时区。

窗口先按预算选择，再完整序列化所选归档文本。单条超过预算时独立处理，不截断后标记已处理。归档自身的文本上限仍然适用。只推进实际窗口的最后 seq；无效证据、episode 范围或只读存储不推进水位。facts/episodes/rolling/水位单文件事务落盘；异常恢复内存快照。配置 facts.minConfidence、facts.maxTextChars 生效。

handoff 与蒸馏共享队列，20 秒包含排队和读取，超时写最近消息回退摘要；过期排队任务不得再覆盖摘要。模型调用先注册完成监听，再提交 prompt，防止快速响应丢失；失败后弃用旧蒸馏会话。不同私聊不复用同一模型历史。普通清除上下文保留交接；完整记忆重置丢弃长期记忆，并串行执行避免旧蒸馏回写。

## 验证与限制

运行 npm run test:distill、npm run test:reset、记忆存储与上下文回归，以及 preset patch 检查。测试使用临时目录与 DSH 桩，不触碰真实 QQ。

证据 seq 校验只能保证引用来自输入窗口，不能证明模型结论语义准确。敏感信息排除仍依赖既有归档脱敏和模型要求，不是全面的隐私语义分类器。真实 DSH 的 preset 安装、模型响应与长时间定时行为需部署验收。
