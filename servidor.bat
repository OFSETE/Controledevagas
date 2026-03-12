@echo off
chcp 65001 >nul
title Controle de Vagas - Servidor Local

:menu
cls
echo ╔════════════════════════════════════════════╗
echo ║   Controle de Vagas - Servidor Local       ║
echo ╠════════════════════════════════════════════╣
echo ║                                            ║
echo ║  [1] Iniciar Servidor                      ║
echo ║  [2] Parar Servidor                        ║
echo ║  [3] Reiniciar Servidor                    ║
echo ║  [4] Abrir no Navegador                    ║
echo ║  [5] Sair                                  ║
echo ║                                            ║
echo ╚════════════════════════════════════════════╝
echo.
set /p opcao="Escolha uma opcao: "

if "%opcao%"=="1" goto iniciar
if "%opcao%"=="2" goto parar
if "%opcao%"=="3" goto reiniciar
if "%opcao%"=="4" goto abrir
if "%opcao%"=="5" goto sair

echo.
echo Opcao invalida!
timeout /t 2 >nul
goto menu

:iniciar
cls
echo Iniciando servidor...
echo.
start "Servidor Node" cmd /k "cd /d %~dp0 && node server.js"
echo Servidor iniciado!
echo Acesse: http://localhost:3000
echo.
pause
goto menu

:parar
cls
echo Parando servidor...
taskkill /F /IM node.exe 2>nul
if %ERRORLEVEL%==0 (
    echo Servidor parado com sucesso!
) else (
    echo Nenhum servidor estava rodando.
)
echo.
pause
goto menu

:reiniciar
cls
echo Reiniciando servidor...
taskkill /F /IM node.exe 2>nul
timeout /t 1 >nul
start "Servidor Node" cmd /k "cd /d %~dp0 && node server.js"
echo Servidor reiniciado!
echo Acesse: http://localhost:3000
echo.
pause
goto menu

:abrir
start http://localhost:3000
goto menu

:sair
taskkill /F /IM node.exe 2>nul
exit
