$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
$runtime = Join-Path $root 'data\runtime'
$pythonHome = Join-Path $runtime 'python311'
$venv = Join-Path $runtime 'tts-python'
$source = Join-Path $runtime 'thonburian-tts'
$installer = Join-Path $runtime 'python-3.11.9-amd64.exe'

New-Item -ItemType Directory -Force -Path $runtime | Out-Null

$python = $null
try {
  $candidate = & py -3.11 -c "import sys; print(sys.executable)" 2>$null
  if ($LASTEXITCODE -eq 0) { $python = $candidate.Trim() }
} catch {}

if (-not $python) {
  if (-not (Test-Path -LiteralPath (Join-Path $pythonHome 'python.exe'))) {
    Write-Host 'Downloading isolated CPython 3.11...'
    Invoke-WebRequest 'https://www.python.org/ftp/python/3.11.9/python-3.11.9-amd64.exe' -OutFile $installer
    Start-Process -FilePath $installer -Wait -WindowStyle Hidden -ArgumentList @(
      '/quiet',
      'InstallAllUsers=0',
      'PrependPath=0',
      'Include_launcher=0',
      'Include_test=0',
      'Include_doc=0',
      'Include_pip=1',
      "TargetDir=$pythonHome"
    )
  }
  $python = Join-Path $pythonHome 'python.exe'
}

if (-not (Test-Path -LiteralPath (Join-Path $venv 'Scripts\python.exe'))) {
  & $python -m venv $venv
}

$venvPython = Join-Path $venv 'Scripts\python.exe'
& $venvPython -m pip install --upgrade pip setuptools wheel
& $venvPython -m pip install torch torchvision torchaudio --index-url https://download.pytorch.org/whl/cu121
if (-not (Test-Path -LiteralPath (Join-Path $source '.git'))) {
  git clone --depth 1 https://github.com/biodatlab/thonburian-tts.git $source
} else {
  git -C $source pull --ff-only
}
& $venvPython -m pip install -r (Join-Path $source 'requirements.txt')
# Upstream's wheel currently omits the flowtts package. Editable mode keeps the
# checked-out source directory on sys.path so `from flowtts...` works.
& $venvPython -m pip install --no-deps -e $source

Write-Host ''
Write-Host 'TTS runtime installed. The model will download on the first generated voice.'
Write-Host 'ThonburianTTS model license: CC BY-NC-SA 4.0 (non-commercial).'
