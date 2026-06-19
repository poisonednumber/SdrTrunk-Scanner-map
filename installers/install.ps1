<#
  Scanner Map - Windows installer (thin bootstrap)

  This no longer asks 40 questions. It just installs prerequisites and
  dependencies, then launches the web Setup Wizard in your browser.

  Run from an elevated PowerShell:
     Set-ExecutionPolicy -Scope Process Bypass
     .\installers\install.ps1
#>

$ErrorActionPreference = 'Stop'
$RepoRoot = Split-Path -Parent $PSScriptRoot

function Write-Step($msg) { Write-Host "`n=== $msg ===" -ForegroundColor Cyan }
function Have($cmd) { return [bool](Get-Command $cmd -ErrorAction SilentlyContinue) }

Write-Step "Scanner Map setup (Windows)"

# --- Prerequisites via winget where possible ---
function Ensure-WingetPackage($id, $probeCmd, $name) {
  if (Have $probeCmd) { Write-Host "[ok] $name found" -ForegroundColor Green; return }
  if (Have 'winget') {
    Write-Host "[..] Installing $name via winget..." -ForegroundColor Yellow
    winget install --id $id -e --accept-source-agreements --accept-package-agreements
  } else {
    Write-Host "[!!] $name not found and winget unavailable. Please install $name manually." -ForegroundColor Red
  }
}

Ensure-WingetPackage 'OpenJS.NodeJS.LTS' 'node' 'Node.js LTS'
Ensure-WingetPackage 'Python.Python.3.11' 'python' 'Python 3.11'
Ensure-WingetPackage 'Gyan.FFmpeg' 'ffmpeg' 'FFmpeg'

# Refresh PATH for this session
$env:Path = [System.Environment]::GetEnvironmentVariable('Path','Machine') + ';' + [System.Environment]::GetEnvironmentVariable('Path','User')

Write-Step "Installing Node dependencies"
Push-Location $RepoRoot
npm install --no-audit --no-fund
Pop-Location

Write-Step "Setting up Python environment"
Push-Location $RepoRoot
if (-not (Test-Path ".venv")) { python -m venv .venv }
& ".\.venv\Scripts\python.exe" -m pip install --upgrade pip
Write-Host "Installing PyTorch (CPU build). For NVIDIA GPU, re-run pip with the CUDA index URL (see requirements.txt)." -ForegroundColor Yellow
& ".\.venv\Scripts\pip.exe" install torch torchvision torchaudio --index-url https://download.pytorch.org/whl/cpu
& ".\.venv\Scripts\pip.exe" install -r requirements.txt
Pop-Location

# Point the app at the venv python
if (-not (Test-Path "$RepoRoot\.env")) {
  Copy-Item "$RepoRoot\.env.example" "$RepoRoot\.env"
}

Write-Step "Done!"
Write-Host "Starting Scanner Map. The Setup Wizard will open at http://localhost:8080/setup" -ForegroundColor Green
Push-Location $RepoRoot
$env:PYTHON_COMMAND = "$RepoRoot\.venv\Scripts\python.exe"
Start-Process "http://localhost:8080/setup"
npm start
Pop-Location
