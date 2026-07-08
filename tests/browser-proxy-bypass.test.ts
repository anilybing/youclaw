import { describe, expect, test } from 'bun:test'
import { resolve } from 'node:path'

// [XJC] 本测试必须在子进程里跑：Bun 的 fetch 会在 HTTP_PROXY 首次被设置后**锁存**代理配置，
// 即使随后 delete 环境变量也不会恢复（实测复现）。若在主测试进程内设置死代理
// http://127.0.0.1:7890，同进程后续所有真实网络请求（如 voice-service 假服务端测试）
// 都会被路由到死代理而误报失败。子进程隔离后污染只影响子进程自身。
describe('browser CDP proxy bypass', () => {
  test('temporarily adds loopback hosts to NO_PROXY for local CDP urls (subprocess isolated)', () => {
    const repoRoot = resolve(import.meta.dir, '..')
    const script = [
      "const { withNoProxyForCdpUrl } = await import('./src/browser/cdp-proxy-bypass.ts')",
      "process.env.HTTP_PROXY = 'http://127.0.0.1:7890'",
      'delete process.env.NO_PROXY',
      'delete process.env.no_proxy',
      "let inside = ''",
      "await withNoProxyForCdpUrl('ws://127.0.0.1:18801/devtools/browser/test', async () => { inside = process.env.NO_PROXY || ''; return undefined })",
      "const ok = inside.includes('127.0.0.1') && process.env.NO_PROXY === undefined && process.env.no_proxy === undefined",
      "console.log(ok ? 'PROXY_BYPASS_OK' : 'PROXY_BYPASS_FAIL inside=' + inside + ' NO_PROXY=' + process.env.NO_PROXY)",
      'process.exit(ok ? 0 : 1)',
    ].join('\n')

    // Windows 下 spawn 'bun' 名称解析会 ENOENT，用当前 bun 可执行文件绝对路径
    const result = Bun.spawnSync([process.execPath, '-e', script], {
      cwd: repoRoot,
      env: { ...process.env, HTTP_PROXY: undefined, NO_PROXY: undefined, no_proxy: undefined } as Record<string, string>,
    })

    const stdout = result.stdout.toString()
    const stderr = result.stderr.toString()
    expect(stdout, `stdout: ${stdout}\nstderr: ${stderr}`).toContain('PROXY_BYPASS_OK')
    expect(result.exitCode).toBe(0)
  })
})
