// [XJC] 浏览器敏感写操作确定性人工确认：分类规则 + pending 确认状态机。
import { afterEach, describe, expect, test } from 'bun:test'
import {
  armPendingConfirmation,
  classifyBrowserAction,
  clearBrowserConfirmationState,
  rememberSnapshot,
  resolveBrowserTurnContext,
} from '../src/browser/sensitive-guard.ts'

afterEach(() => clearBrowserConfirmationState())

const CHAT = 'web:test-browser'

describe('browser sensitive-action guard', () => {
  test('act(click) is classified by the cached element semantics', () => {
    rememberSnapshot(CHAT, 'https://shop.example.com/cart', [
      { ref: '1', tag: 'button', role: 'button', label: '立即支付' },
      { ref: '2', tag: 'a', role: 'link', text: '返回首页' },
    ])
    expect(classifyBrowserAction(CHAT, { kind: 'act', action: 'click', ref: '1' }, 'https://shop.example.com/cart').sensitive).toBe(true)
    expect(classifyBrowserAction(CHAT, { kind: 'act', action: 'click', ref: '2' }, 'https://shop.example.com/cart').sensitive).toBe(false)
  })

  test('page sensitive-zone catches unlabeled icon-button clicks on checkout', () => {
    rememberSnapshot(CHAT, 'https://shop.example.com/checkout', [{ ref: '9', tag: 'button', role: 'button' }])
    const c = classifyBrowserAction(CHAT, { kind: 'act', action: 'click', ref: '9' }, 'https://shop.example.com/checkout')
    expect(c.sensitive).toBe(true)
    expect(c.reasons).toContain('page-zone')
  })

  test('checkbox/select acts and navigation are never gated', () => {
    rememberSnapshot(CHAT, 'https://shop.example.com/checkout', [{ ref: '3', tag: 'input', role: 'checkbox', label: '同意条款' }])
    expect(classifyBrowserAction(CHAT, { kind: 'act', action: 'click', ref: '3' }, 'https://shop.example.com/checkout').sensitive).toBe(false)
    expect(classifyBrowserAction(CHAT, { kind: 'act', action: 'check', ref: '3' }, 'https://shop.example.com/checkout').sensitive).toBe(false)
    expect(classifyBrowserAction(CHAT, { kind: 'navigate', url: 'https://shop.example.com/checkout' }, null).sensitive).toBe(false)
  })

  test('secret fields and raw CSS selectors', () => {
    expect(classifyBrowserAction(CHAT, { kind: 'type', selector: 'input#password', text: 'x' }, 'https://site.example.com/login').sensitive).toBe(true)
    expect(classifyBrowserAction(CHAT, { kind: 'type', selector: 'input#search', text: 'x' }, 'https://site.example.com/home').sensitive).toBe(false)
    expect(classifyBrowserAction(CHAT, { kind: 'click', selector: 'button.submit-order' }, 'https://site.example.com/home').sensitive).toBe(true)
    expect(classifyBrowserAction(CHAT, { kind: 'click', selector: 'a.back' }, 'https://site.example.com/home').sensitive).toBe(false)
  })

  test('Enter is a submit only inside a sensitive zone', () => {
    expect(classifyBrowserAction(CHAT, { kind: 'press_key', key: 'Enter' }, 'https://shop.example.com/checkout').sensitive).toBe(true)
    expect(classifyBrowserAction(CHAT, { kind: 'press_key', key: 'Enter' }, 'https://shop.example.com/home').sensitive).toBe(false)
    expect(classifyBrowserAction(CHAT, { kind: 'press_key', key: 'Tab' }, 'https://shop.example.com/checkout').sensitive).toBe(false)
  })

  test('state machine: arm -> confirm authorizes once with bound signature', () => {
    const c = classifyBrowserAction(CHAT, { kind: 'click', selector: 'button.pay' }, 'https://shop.example.com/checkout')
    expect(c.sensitive).toBe(true)
    expect(resolveBrowserTurnContext(CHAT, '帮我付款', null).authorization.allowSensitiveOnce).toBe(false)
    armPendingConfirmation(CHAT, c, 'https://shop.example.com/checkout')
    const confirmed = resolveBrowserTurnContext(CHAT, '确认', null)
    expect(confirmed.authorization.allowSensitiveOnce).toBe(true)
    expect(confirmed.authorization.boundSignature).toBe(c.signature)
    // one-shot: consumed, next turn is no longer authorized
    expect(resolveBrowserTurnContext(CHAT, '再点一次', null).authorization.allowSensitiveOnce).toBe(false)
  })

  test('cancel clears pending so a later confirm does not fire', () => {
    const c = classifyBrowserAction(CHAT, { kind: 'click', selector: 'button.delete' }, 'https://site.example.com/account/security')
    armPendingConfirmation(CHAT, c, 'https://site.example.com/account/security')
    expect(resolveBrowserTurnContext(CHAT, '取消', null).authorization.allowSensitiveOnce).toBe(false)
    expect(resolveBrowserTurnContext(CHAT, '确认', null).authorization.allowSensitiveOnce).toBe(false)
  })
})
