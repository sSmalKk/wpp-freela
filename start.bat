@echo off
setlocal
cd /d "%~dp0"
title wpp-freela

rem --- Chrome em debug (perfil proprio do robo, ja logado no freelancer.com.br) ---
set "CHROME=C:\Program Files\Google\Chrome\Application\chrome.exe"
if not exist "%CHROME%" set "CHROME=C:\Program Files (x86)\Google\Chrome\Application\chrome.exe"
set "PERFIL=%LOCALAPPDATA%\Publiva\chrome-rpa"

curl -s -o nul http://localhost:9222/json/version
if errorlevel 1 (
  echo Abrindo o Chrome em modo debug...
  start "" "%CHROME%" --remote-debugging-port=9222 --user-data-dir="%PERFIL%" --no-first-run ^
    --disable-background-timer-throttling --disable-backgrounding-occluded-windows --disable-renderer-backgrounding ^
    https://freelancer.com.br/account/inbox
  timeout /t 4 /nobreak >nul
) else (
  echo Chrome debug ja esta aberto.
)

rem --- Ollama (rascunho da IA) ---
curl -s -o nul http://localhost:11434/api/tags
if errorlevel 1 (
  where ollama >nul 2>nul && (
    echo Iniciando o Ollama...
    start "ollama" /min ollama serve
  ) || echo Ollama nao encontrado - o botao IA nao vai funcionar.
)

rem --- Painel ---
where node >nul 2>nul || (echo Node 22+ nao encontrado. Instale em https://nodejs.org & pause & exit /b 1)
echo.
echo Painel: http://localhost:3737   (feche esta janela para parar)
echo.
node --env-file-if-exists=.env src\servidor.mjs
pause
