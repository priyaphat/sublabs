$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$modelDir = Join-Path $root 'data\models\whisper-cpp'
$cpuDir = Join-Path $root 'tools\whisper'
$cudaDir = Join-Path $root 'tools\whisper-cuda'
New-Item -ItemType Directory -Force $modelDir,$cpuDir,$cudaDir | Out-Null

function Download-IfMissing([string]$Url,[string]$Destination) {
  if (Test-Path -LiteralPath $Destination) { return }
  Write-Host "Downloading $(Split-Path -Leaf $Destination)..."
  Start-BitsTransfer -Source $Url -Destination $Destination
}

Download-IfMissing 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo-q8_0.bin' (Join-Path $modelDir 'ggml-large-v3-turbo-q8_0.bin')
Download-IfMissing 'https://huggingface.co/ggml-org/whisper-vad/resolve/main/ggml-silero-v6.2.0.bin' (Join-Path $modelDir 'ggml-silero-v6.2.0.bin')

$cpuServer = Join-Path $cpuDir 'Release\whisper-server.exe'
if (-not (Test-Path -LiteralPath $cpuServer)) {
  $zip = Join-Path $cpuDir 'runtime.zip'
  Download-IfMissing 'https://github.com/ggml-org/whisper.cpp/releases/download/v1.9.1/whisper-bin-x64.zip' $zip
  Expand-Archive -Force $zip $cpuDir
  Remove-Item -LiteralPath $zip -Force
}

$cudaServer = Join-Path $cudaDir 'Release\whisper-server.exe'
if ((Get-Command nvidia-smi -ErrorAction SilentlyContinue) -and -not (Test-Path -LiteralPath $cudaServer)) {
  $zip = Join-Path $cudaDir 'runtime.zip'
  Download-IfMissing 'https://github.com/ggml-org/whisper.cpp/releases/download/v1.9.1/whisper-cublas-12.4.0-bin-x64.zip' $zip
  Expand-Archive -Force $zip $cudaDir
  Remove-Item -LiteralPath $zip -Force
}
Write-Host 'SubLabs speech models are ready.' -ForegroundColor Green
