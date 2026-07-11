import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import {
  pollReadiness,
  SIDECAR_STARTUP_TIMEOUT_MS,
} from '../web/src/api/transport.ts'

const repoRoot = process.cwd()

function read(relativePath: string) {
  return readFileSync(path.join(repoRoot, relativePath), 'utf8')
}

describe('sidecar readiness foundation', () => {
  test('readiness polling succeeds, fails early, and respects its deadline', async () => {
    let now = 0
    let attempts = 0
    const sleep = async (ms: number) => {
      now += ms
    }

    const ready = await pollReadiness(
      async () => (++attempts === 3 ? 'ready' : 'pending'),
      { timeoutMs: 1_000, intervalMs: 100, now: () => now, sleep },
    )
    expect(ready).toBe(true)
    expect(attempts).toBe(3)

    attempts = 0
    const failed = await pollReadiness(
      async () => {
        attempts += 1
        return 'failed'
      },
      { timeoutMs: 1_000, intervalMs: 100, now: () => now, sleep },
    )
    expect(failed).toBe(false)
    expect(attempts).toBe(1)

    attempts = 0
    now = 0
    const timedOut = await pollReadiness(
      async () => {
        attempts += 1
        return 'pending'
      },
      { timeoutMs: 250, intervalMs: 100, now: () => now, sleep },
    )
    expect(timedOut).toBe(false)
    expect(now).toBe(250)
    expect(attempts).toBe(4)
  })

  test('frontend timeout extends beyond the Rust health window', () => {
    const rust = read('src-tauri/src/lib.rs')
    expect(rust).toContain('const SIDECAR_HEALTH_TIMEOUT: Duration = Duration::from_secs(90)')
    expect(SIDECAR_STARTUP_TIMEOUT_MS).toBeGreaterThan(90_000)
  })

  test('static splash communicates staged progress before the hard timeout', () => {
    const html = read('web/index.html')
    expect(html).toContain('id="xjc-splash-status"')
    expect(html).toContain("[12000, '正在初始化本地服务")
    expect(html).toContain("[30000, '本地服务启动较慢")
    expect(html).toContain("[60000, '仍在尝试连接")
    expect(html).toContain('超过 100 秒后将显示诊断页面')
  })

  test('termination updates queryable state and stale generations are ignored', () => {
    const rust = read('src-tauri/src/lib.rs')
    const terminated = rust.slice(
      rust.indexOf('CommandEvent::Terminated'),
      rust.indexOf('_ => {}', rust.indexOf('CommandEvent::Terminated')),
    )
    expect(terminated).toContain('update_if_current')
    expect(terminated).toContain('SIDECAR_STATE_ERROR')
    expect(rust).toContain('invalidate_and_mark_pending')
    expect(rust).toContain('self.generation.load(Ordering::SeqCst) != generation')
    expect(rust).toContain('app.state::<SidecarReadyState>().snapshot()')
  })

  test('overlay only recovers after the readiness guard passes', () => {
    const overlay = read('web/src/components/SidecarErrorOverlay.tsx')
    const restartBody = overlay.slice(
      overlay.indexOf('const handleRestart'),
      overlay.indexOf('const handleExit'),
    )
    expect(restartBody.indexOf("await invoke('restart_sidecar')")).toBeGreaterThanOrEqual(0)
    expect(restartBody.indexOf('await waitForBackendReady()')).toBeGreaterThan(
      restartBody.indexOf("await invoke('restart_sidecar')"),
    )
    expect(restartBody.indexOf('onRecovered()')).toBeGreaterThan(
      restartBody.indexOf('await waitForBackendReady()'),
    )
    expect(restartBody).toContain('setFailed(true)')
  })
})

describe('commercial OTP login and account privacy', () => {
  test('login is a two-step OTP flow with small-window and offline escape paths', () => {
    const login = read('web/src/pages/Login.tsx')
    const client = read('web/src/api/client.ts')
    const routes = read('src/routes/commercial-auth.ts')

    expect(client).toContain("export async function requestLoginOtp")
    expect(client).toContain("otpChallengeId: string")
    expect(client).toContain("otpCode: string")
    expect(routes).toContain("app.post('/auth/otp/request'")
    expect(routes).toContain("errorCode: 'CLOUD_UNREACHABLE'")
    expect(login).toContain('data-testid="login-identity-step"')
    expect(login).toContain('data-testid="login-otp-step"')
    expect(login).toContain('autoComplete="one-time-code"')
    expect(login).toContain('OTP_RESEND_COOLDOWN_MS')
    expect(login).toContain('overflow-y-auto')
    expect(login).toContain('onClick={goOffline}')
  })

  test('missing avatars stay local and account labels reflect server entitlements', () => {
    const runtime = read('web/src/stores/app-runtime.ts')
    const sidebar = read('web/src/components/layout/AppSidebar.tsx')
    const account = read('web/src/components/settings/AccountPanel.tsx')

    expect(runtime).not.toContain('api.dicebear.com')
    expect(sidebar).toContain('resolveAccountPlanLabel')
    expect(account).toContain('resolveAccountPlanLabel')
    expect(sidebar).not.toContain('Pro Plan')
    expect(account).not.toContain('Pro Member')
  })
})

describe('workflow and fulfillment page states', () => {
  test('today operations is the default business entry with profile and auditable brief', () => {
    const app = read('web/src/App.tsx')
    const sidebar = read('web/src/components/layout/AppSidebar.tsx')
    const page = read('web/src/pages/commercial/TodayOperations.tsx')
    expect(app).toContain('<Route path="/" element={<Navigate to="/today" replace />} />')
    expect(app).toContain('<Route path="/today" element={<TodayOperations />} />')
    expect(app).toContain('<Route path="/chat" element={<Chat />} />')
    expect(sidebar).toContain('{ to: "/today", icon: LayoutDashboard')
    expect(page).toContain('data-testid="today-operations-page"')
    expect(page).toContain('data-testid="today-operations-loading"')
    expect(page).toContain('data-testid="today-operations-error"')
    expect(page).toContain('data-testid="business-profile-form"')
    expect(page).toContain('runWorkflow(TODAY_BUSINESS_BRIEF_WORKFLOW_ID, {})')
    expect(page).toContain('data-testid="run-business-brief"')
    expect(page).toContain('profile.completeness')
    expect(page).toContain('automation.aiUsageToday.costUsd')
  })

  test('workflows expose step timelines and live usage while protecting builtins', () => {
    const page = read('web/src/pages/Workflows.tsx')
    const workbench = read('web/src/pages/commercial/Workbench.tsx')
    expect(page).toContain('data-testid="workflows-loading"')
    expect(page).toContain('data-testid="workflows-error"')
    expect(page).toContain('data-testid="workflow-step-card"')
    expect(page).toContain('outputRun.usage.totalTokens')
    expect(page).toContain('getWorkflowRunDetail(runId)')
    expect(page).toContain("workflowViewState === 'empty'")
    expect(page).toContain('WORKFLOW_RUN_POLL_MS = 4_000')
    expect(page).toContain('expandedHasRunningRun')
    expect(page).toContain('window.setInterval')
    expect(page).toContain("workflow.source !== 'builtin'")
    expect(page).toContain('canDeleteWorkflow(wf) &&')
    expect(page).not.toContain('.catch(() => setWorkflows([]))')
    expect(workbench).toContain('await runWorkflow(task.workflowId, inputs)')
    expect(workbench).toContain('自动流水线')
  })

  test('fulfillment distinguishes both collection states and exposes refresh', () => {
    const page = read('web/src/pages/Fulfillment.tsx')
    expect(page).toContain('data-testid="fulfillment-skus-loading"')
    expect(page).toContain('data-testid="fulfillment-skus-error"')
    expect(page).toContain("skuViewState === 'empty'")
    expect(page).toContain('data-testid="fulfillment-deliveries-loading"')
    expect(page).toContain('data-testid="fulfillment-deliveries-error"')
    expect(page).toContain("deliveryViewState === 'empty'")
    expect(page).toContain('onClick={refreshAll}')
    expect(page).not.toContain('.catch(() => setSkus([]))')
    expect(page).not.toContain('.catch(() => setDeliveries([]))')
  })
})
