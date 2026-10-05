@echo off
REM ============================================================================
REM  NUKE BUTTON - double-click this file.
REM
REM  Immediately revokes agy's shell access and takes it out of the routing
REM  rotation. Restores agy's settings.json from the backup taken before
REM  ShanAuto ever modified it.
REM
REM  Safe to run at any time, including if nothing was ever granted.
REM  Needs no administrator rights.
REM ============================================================================
title Revoke agy shell access
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0agy-access.ps1" -Revert
echo.
echo Press any key to close.
pause >nul
