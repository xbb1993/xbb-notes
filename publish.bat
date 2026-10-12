@echo off
setlocal EnableExtensions
chcp 65001 >nul
rem One-click publish: git add -A, commit, push (xbb-notes)
cd /d "%~dp0"

where git >nul 2>&1
if errorlevel 1 (
  echo [ERROR] git not found in PATH.
  goto :end
)

echo === Changes to be published ===
git -c core.quotepath=false status --short
for /f %%i in ('git status --porcelain ^| find /c /v ""') do set CHANGES=%%i
if "%CHANGES%"=="0" (
  echo Nothing to commit. Working tree clean.
  goto :end
)
echo.

for /f "delims=" %%d in ('powershell -NoProfile -Command "Get-Date -Format \"yyyy-MM-dd HH:mm\""') do set NOW=%%d
set "MSG="
set /p "MSG=Commit message (Enter = docs: update notes %NOW%): "
if not defined MSG set "MSG=docs: update notes %NOW%"

git add -A
if errorlevel 1 (
  echo [ERROR] git add failed.
  goto :end
)

git commit -m "%MSG%"
if errorlevel 1 (
  echo [ERROR] git commit failed.
  goto :end
)

git push origin HEAD
if errorlevel 1 (
  echo [ERROR] git push failed. Commit is saved locally; fix the issue and run again or push manually.
  goto :end
)

echo.
echo === Done. GitHub Actions will rebuild the site in a minute or two. ===

:end
echo.
pause
endlocal
