; [XJC-PATCH] XiaoJuClaw process names, deep link, and explicit installed marker.
; Kill app and sidecar processes before install/uninstall
!macro KillAppProcesses
  ; Kill main app
  nsExec::ExecToLog 'taskkill /F /IM "XiaoJuClaw.exe"'
  ; Kill sidecar (compiled bun binary)
  nsExec::ExecToLog 'taskkill /F /IM "XiaoJuClaw-server.exe"'
  ; Wait for processes to exit
  Sleep 1000
!macroend

; Register XiaoJuClaw:// deep-link protocol in Windows registry
!macro RegisterDeepLink
  WriteRegStr HKCU "Software\Classes\XiaoJuClaw" "" "URL:XiaoJuClaw Protocol"
  WriteRegStr HKCU "Software\Classes\XiaoJuClaw" "URL Protocol" ""
  WriteRegStr HKCU "Software\Classes\XiaoJuClaw\DefaultIcon" "" "$INSTDIR\XiaoJuClaw.exe,0"
  WriteRegStr HKCU "Software\Classes\XiaoJuClaw\shell\open\command" "" '"$INSTDIR\XiaoJuClaw.exe" "%1"'
!macroend

; Explicit installed marker wins over legacy writable-directory heuristics.
; This keeps per-user NSIS installs on AppData even though $INSTDIR is writable.
!macro WriteInstalledLayoutMarker
  FileOpen $0 "$INSTDIR\installed-layout.json" w
  FileWrite $0 "{}$\r$\n"
  FileClose $0
!macroend

; Called before install — silently remove old version + kill processes
!macro NSIS_HOOK_PREINSTALL
  !insertmacro KillAppProcesses
!macroend

; Called after install — ensure deep-link protocol is registered with current exe path
!macro NSIS_HOOK_POSTINSTALL
  !insertmacro RegisterDeepLink
  !insertmacro WriteInstalledLayoutMarker
!macroend

; Called before uninstall — kill processes so files can be deleted
!macro NSIS_HOOK_PREUNINSTALL
  !insertmacro KillAppProcesses
!macroend

; Called after uninstall — clean up deep-link protocol registry
!macro NSIS_HOOK_POSTUNINSTALL
  DeleteRegKey HKCU "Software\Classes\XiaoJuClaw"
!macroend
