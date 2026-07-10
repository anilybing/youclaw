// [XJC] 内置 MCP Server 端点（streamable HTTP，供 Cursor 等 MCP 客户端连接）
//   POST /mcp — JSON-RPC 消息入口（application/json 应答；notification 回 202）
//   GET  /mcp — 405（不提供 SSE 服务端推送，tools-only 无需）
// 鉴权：settings.mcpServer.enabled 开关 + Authorization: Bearer <token>（timing-safe 比较）。
// Cursor 侧 mcp.json 配置示例见设置页「MCP 服务」。

import { Hono } from 'hono'
import { createHash, timingSafeEqual } from 'node:crypto'
import { McpServerService, type McpServerDeps } from '../mcp-server/service.ts'

function tokenMatches(provided: string, expected: string): boolean {
  if (!provided || !expected) return false
  // 双方 sha256 后等长，可安全 timingSafeEqual
  const a = createHash('sha256').update(provided).digest()
  const b = createHash('sha256').update(expected).digest()
  return timingSafeEqual(a, b)
}

export function createMcpServerRoutes(deps: McpServerDeps) {
  const app = new Hono()
  const service = new McpServerService(deps)

  app.post('/mcp', async (c) => {
    if (!service.isEnabled()) {
      return c.json({ error: 'MCP server is disabled. Enable it in XiaoJuClaw Settings → MCP Server.' }, 403)
    }
    const expected = service.getToken()
    const auth = c.req.header('Authorization') ?? ''
    const provided = auth.startsWith('Bearer ') ? auth.slice(7).trim() : ''
    if (!tokenMatches(provided, expected)) {
      return c.json({ error: 'Unauthorized: invalid or missing bearer token.' }, 401)
    }

    let message: unknown
    try {
      message = await c.req.json()
    } catch {
      return c.json({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }, 400)
    }
    // 新版 streamable HTTP 已移除 batch，数组一律拒绝
    if (Array.isArray(message) || !message || typeof message !== 'object') {
      return c.json({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid request' } }, 400)
    }

    const response = await service.handle(message)
    if (response === null) return c.body(null, 202)
    return c.json(response)
  })

  // 不支持 SSE 监听流与会话删除（无会话状态）
  app.get('/mcp', (c) => c.body(null, 405))
  app.delete('/mcp', (c) => c.body(null, 405))

  return app
}
