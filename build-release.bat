@echo off
chcp 65001 >nul
setlocal EnableExtensions EnableDelayedExpansion

set "ROOT=%~dp0"
set "ROOT=%ROOT:~0,-1%"
set "WEB_DIR=%ROOT%\web"
set "BUNDLE_DIR=%ROOT%\src-tauri\target\release\bundle"
set "TAURI_BUILD_CMD=bun run build:tauri"
set "DRY_RUN=0"
set "DESKTOP_ONLY=0"
if not defined XJC_BUILD_VARIANT set "XJC_BUILD_VARIANT=windows-installer"

:parse_args
if "%~1"=="" goto args_done
if /I "%~1"=="--dry-run" set "DRY_RUN=1"
if /I "%~1"=="--dry-run" set "NO_PAUSE=1"
if /I "%~1"=="--desktop-only" set "DESKTOP_ONLY=1"
shift
goto parse_args
:args_done

title XiaoJuClaw Build Release

echo.
echo ========================================
echo   XiaoJuClaw Build Release
echo ========================================
echo Root: %ROOT%
if "%DRY_RUN%"=="1" echo Mode: dry-run
echo.

if not exist "%ROOT%\package.json" (
  echo [ERROR] package.json not found. Put this script in the XiaoJuClaw project root.
  goto :fail
)

where bun >nul 2>nul
if errorlevel 1 (
  echo [ERROR] bun was not found. Install Bun and make sure it is available in PATH.
  goto :fail
)

where powershell >nul 2>nul
if errorlevel 1 (
  echo [ERROR] PowerShell was not found. Release directory creation and artifact copy cannot continue.
  goto :fail
)

where cargo >nul 2>nul
if errorlevel 1 if exist "%USERPROFILE%\.cargo\bin\cargo.exe" (
  set "PATH=%USERPROFILE%\.cargo\bin;%PATH%"
)

where cargo >nul 2>nul
if errorlevel 1 (
  echo [ERROR] cargo was not found. Install Rust with rustup and reopen the terminal.
  echo [HINT] https://rustup.rs/
  goto :fail
)

for /f "delims=" %%v in ('powershell -NoProfile -Command "(Get-Content -Raw package.json | ConvertFrom-Json).version"') do set "APP_VERSION=%%v"
if not defined APP_VERSION (
  echo [ERROR] Could not read a release version from package.json.
  goto :fail
)
for /f "delims=" %%t in ('powershell -NoProfile -Command "Get-Date -Format yyyyMMdd-HHmmss"') do set "BUILD_STAMP=%%t"

set "RELEASE_DIR=%ROOT%\release\XiaoJuClaw-%APP_VERSION%-windows-%BUILD_STAMP%"

if not defined TAURI_SIGNING_PRIVATE_KEY (
  echo [WARN] TAURI_SIGNING_PRIVATE_KEY is not set. Configure it first if updater artifacts must be signed.
  echo [WARN] Building without updater artifacts.
  set "TAURI_BUILD_CMD=bun run build:tauri:no-updater"
  echo.
)

if /I "%XJC_RELEASE_GATE_ALREADY_RUN%"=="1" (
  echo.
  echo [SKIP] Strict release gate already completed by the orchestrator.
) else (
  if "%DESKTOP_ONLY%"=="1" (
    call :run_in "Desktop release gate" "%ROOT%" "powershell -NoProfile -ExecutionPolicy Bypass -File scripts\release-gate.ps1"
  ) else (
    call :run_in "Strict release gate" "%ROOT%" "powershell -NoProfile -ExecutionPolicy Bypass -File scripts\release-gate.ps1 -Release"
  )
  if errorlevel 1 goto :fail
)

if /I not "%SKIP_RECOMMENDED_VALIDATION%"=="1" (
  call :run_in "Validate recommended skills" "%ROOT%" "bun run validate:recommended-skills"
  if errorlevel 1 goto :fail
) else (
  echo.
  echo [SKIP] Validate recommended skills
)

rem Never collect stale MSI/NSIS files from an earlier build. The no-updater
rem configuration currently targets NSIS only; without this cleanup, an old MSI
rem left under target\release\bundle is copied into the new release directory.
if "%DRY_RUN%"=="0" if exist "%BUNDLE_DIR%" (
  echo.
  echo [STEP] Clean stale Tauri bundle artifacts
  powershell -NoProfile -Command "Remove-Item -Path '%BUNDLE_DIR%' -Recurse -Force"
  if errorlevel 1 goto :fail
  echo [OK] Stale bundle artifacts removed
)

call :run_in "Tauri release build" "%ROOT%" "%TAURI_BUILD_CMD%"
if errorlevel 1 goto :fail

if "%DRY_RUN%"=="1" (
  echo.
  echo [DRY-RUN] Script flow check completed. Artifact collection skipped.
  goto :success
)

if not exist "%BUNDLE_DIR%" (
  echo [ERROR] Tauri bundle directory was not found: %BUNDLE_DIR%
  goto :fail
)

echo.
echo [STEP] Collect release artifacts
powershell -NoProfile -ExecutionPolicy Bypass -Command "$releaseDir = '%RELEASE_DIR%'; $bundleDir = '%BUNDLE_DIR%'; if (!(Test-Path -Path $releaseDir)) { New-Item -ItemType Directory -Path $releaseDir -Force | Out-Null }; Get-ChildItem -Path $bundleDir | ForEach-Object { Copy-Item -Path $_.FullName -Destination $releaseDir -Recurse -Force }"
if errorlevel 1 goto :fail

echo.
echo [OK] Release artifacts directory: %RELEASE_DIR%
pushd "%ROOT%" >nul
call bun scripts\write-build-provenance.mjs "%RELEASE_DIR%\build-provenance.json" "%APP_VERSION%" "%XJC_BUILD_VARIANT%"
set "PROVENANCE_STATUS=%ERRORLEVEL%"
if not "%PROVENANCE_STATUS%"=="0" (
  popd >nul
  goto :fail
)
call bun scripts\generate-sbom.mjs write "%RELEASE_DIR%\sbom.cdx.json"
set "SBOM_STATUS=%ERRORLEVEL%"
if not "%SBOM_STATUS%"=="0" (
  popd >nul
  goto :fail
)
call bun scripts\release-artifacts.mjs write "%RELEASE_DIR%"
set "HASH_STATUS=%ERRORLEVEL%"
if not "%HASH_STATUS%"=="0" (
  popd >nul
  goto :fail
)
call bun scripts\release-artifacts.mjs verify "%RELEASE_DIR%"
set "VERIFY_STATUS=%ERRORLEVEL%"
popd >nul
if not "%VERIFY_STATUS%"=="0" goto :fail
echo.
powershell -NoProfile -Command "Get-ChildItem -Path '%RELEASE_DIR%' -Recurse | Where-Object { -not $_.PSIsContainer } | Sort-Object FullName | ForEach-Object { '{0}  {1:N2} MB' -f $_.FullName, ($_.Length / 1MB) }"

:success
echo.
echo ========================================
echo   XiaoJuClaw build release completed
echo ========================================
echo.
if /I not "%NO_PAUSE%"=="1" pause
exit /b 0

:run_in
set "STEP_NAME=%~1"
set "STEP_DIR=%~2"
set "STEP_CMD=%~3"
echo.
echo [STEP] %STEP_NAME%
echo [CMD]  %STEP_CMD%
if "%DRY_RUN%"=="1" (
  echo [DRY-RUN] Command execution skipped
  exit /b 0
)
pushd "%STEP_DIR%" >nul
call %STEP_CMD%
set "STEP_STATUS=%ERRORLEVEL%"
popd >nul
if not "%STEP_STATUS%"=="0" (
  echo [ERROR] %STEP_NAME% failed with exit code: %STEP_STATUS%
  exit /b %STEP_STATUS%
)
echo [OK] %STEP_NAME%
exit /b 0

:fail
echo.
echo ========================================
echo   XiaoJuClaw build release failed
echo ========================================
echo.
if /I not "%NO_PAUSE%"=="1" pause
exit /b 1
