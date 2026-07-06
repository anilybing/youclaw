# XiaoJuClaw Main Browser Bridge Extension

Load this directory as an unpacked Chromium extension during development.

Current capabilities:

1. Accept a backend URL and pairing code from the XiaoJuClaw app
2. Attach the current tab through `chrome.debugger`
3. Send current tab metadata to `POST /api/browser/main-bridge/extension-attach`
4. Poll XiaoJuClaw for browser commands and execute them through the Chrome DevTools Protocol

The bridge no longer depends on broad website host permissions for DOM access. Tab automation runs through `chrome.debugger`, similar to OpenClaw's main-browser attach model.
