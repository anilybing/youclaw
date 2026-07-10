import { describe, expect, test } from 'bun:test'
import './setup.ts'
import {
  clearExtensionBridgeSession,
  enqueueExtensionBridgeCommand,
  pollExtensionBridgeCommand,
  resolveExtensionBridgeCommand,
  setExtensionBridgeSession,
} from '../src/browser/extension-bridge.ts'
import { snapshotForExtensionChat } from '../src/browser/extension-session.ts'

describe('browser extension transport', () => {
  test('poll returns the queued command and result resolution settles the waiter', async () => {
    const profileId = 'extension-profile'

    setExtensionBridgeSession(profileId, {
      browserId: 'chrome',
      browserName: 'Google Chrome',
      browserKind: 'chrome',
      tabId: 'tab-1',
      tabUrl: 'https://example.com',
      tabTitle: 'Example',
      extensionVersion: '0.1.0',
    })

    const waiter = enqueueExtensionBridgeCommand(profileId, 'snapshot', {
      activePageUrl: 'https://example.com',
    })

    const command = pollExtensionBridgeCommand(profileId)
    expect(command?.profileId).toBe(profileId)
    expect(command?.action).toBe('snapshot')

    resolveExtensionBridgeCommand({
      profileId,
      commandId: command!.id,
      ok: true,
      result: {
        url: 'https://example.com',
        title: 'Example',
        text: 'hello world',
      },
    })

    await expect(waiter).resolves.toEqual({
      url: 'https://example.com',
      title: 'Example',
      text: 'hello world',
    })
    clearExtensionBridgeSession(profileId)
  })

  test('extension chat commands target the attached tab by default', async () => {
    const profileId = 'extension-chat-profile'

    setExtensionBridgeSession(profileId, {
      browserId: 'chrome',
      browserName: 'Google Chrome',
      browserKind: 'chrome',
      tabId: 'tab-77',
      tabUrl: 'https://example.com/current',
      tabTitle: 'Current Tab',
      extensionVersion: '0.1.0',
    })

    const pending = snapshotForExtensionChat({
      chatId: 'chat-1',
      agentId: 'agent-1',
      profileId,
    })

    const command = pollExtensionBridgeCommand(profileId)
    expect(command?.payload.tabId).toBe('tab-77')

    resolveExtensionBridgeCommand({
      profileId,
      commandId: command!.id,
      ok: true,
      result: {
        tabId: 'tab-77',
        url: 'https://example.com/current',
        title: 'Current Tab',
        text: 'body',
        refs: [],
      },
    })

    await expect(pending).resolves.toEqual({
      title: 'Current Tab',
      url: 'https://example.com/current',
      text: 'body',
      refs: [],
    })
    clearExtensionBridgeSession(profileId)
  })
})
