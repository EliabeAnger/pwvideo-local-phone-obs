@echo off
setlocal
title PWVD - Phone camera to OBS
color 0A
cd /d "%~dp0"

echo.
echo  ====================================================
echo    PWVD - Iniciando sistema
echo  ====================================================
echo.

REM --- check node
where node >nul 2>nul
if errorlevel 1 (
  color 0C
  echo  [ERRO] Node.js nao encontrado!
  echo  Instale em https://nodejs.org/
  pause
  exit /b 1
)
echo  [ok] Node.js encontrado

REM --- install deps if missing
if not exist "node_modules\fastify" (
  echo  [setup] Instalando dependencias npm...
  call npm install --no-fund --no-audit
  if errorlevel 1 (
    color 0C
    echo  [ERRO] npm install falhou.
    pause
    exit /b 1
  )
)
echo  [ok] Dependencias instaladas

REM --- generate certs if missing
if not exist "certs\cert.pem" (
  echo  [setup] Gerando certificados HTTPS...
  call npm run certs
  if errorlevel 1 (
    color 0C
    echo  [ERRO] Falha ao gerar certificados.
    pause
    exit /b 1
  )
)
echo  [ok] Certificados HTTPS

REM --- kill stale processes
taskkill /f /im mediamtx.exe >nul 2>nul
taskkill /f /im node.exe >nul 2>nul

REM --- open dashboard after delay
echo.
echo  Abrindo painel em 4 segundos...
start "" cmd /c "timeout /t 4 /nobreak >nul & start https://localhost:8443/op.html"

REM --- start server
echo.
echo  ====================================================
echo  Servidor rodando. Feche esta janela para parar.
echo  ====================================================
echo.
call npm start

color 0E
echo.
echo  Servidor encerrado.
pause
pause
endlocal
