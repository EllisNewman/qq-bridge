// qq-memory preset 的零工具守卫：记忆整理会话不允许调用任何工具。
// 它只输出 JSON 文本；工具调用一律拒绝，避免窗口里的注入内容借工具越权。
export const name = 'qq-memory-guard'

export const inject = ['tools']

export function apply(ctx) {
  ctx.tools.guard((exec) => {
    const name = exec?.name
    if (typeof name !== 'string' || name.length === 0) return '工具名无效，已拒绝'
    return `记忆整理会话禁止调用任何工具（${name}）`
  })
}
