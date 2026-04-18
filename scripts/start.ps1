# PWVD — start script (Windows PowerShell)
# Runs the control plane; MediaMTX is started as a child process.
$ErrorActionPreference = 'Stop'
Push-Location $PSScriptRoot\..
try {
  if (-not (Test-Path .env)) { Copy-Item .env.example .env }
  if (-not (Test-Path certs\cert.pem)) { node scripts\make-certs.js }
  node server\index.js
} finally {
  Pop-Location
}
