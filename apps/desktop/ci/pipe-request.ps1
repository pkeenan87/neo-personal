<#
  Sends one request to the Neo Protection service pipe and prints the reply line.

    pwsh ci/pipe-request.ps1 -Request '{"op":"status"}'

  The pipe's DACL allows SYSTEM and INTERACTIVE users only, and a CI runner is neither an
  interactive session nor guaranteed to carry the INTERACTIVE group, so the request is made by a
  one-shot scheduled task that runs as SYSTEM (the same way the service itself sees it).
#>
param(
  [Parameter(Mandatory = $true)][string]$Request,
  [int]$TimeoutSeconds = 60
)
$ErrorActionPreference = 'Stop'

$base = if ($env:RUNNER_TEMP) { $env:RUNNER_TEMP } else { $env:TEMP }
$work = Join-Path $base 'neo-pipe'
New-Item -ItemType Directory -Force -Path $work | Out-Null
$id = [guid]::NewGuid().ToString('N')
$scriptPath = Join-Path $work "req-$id.ps1"
$reqFile = Join-Path $work "req-$id.json"
$outFile = Join-Path $work "out-$id.txt"
[System.IO.File]::WriteAllText($reqFile, $Request)

@"
`$ErrorActionPreference = 'Stop'
try {
  `$p = New-Object System.IO.Pipes.NamedPipeClientStream('.', 'neo-agent', [System.IO.Pipes.PipeDirection]::InOut)
  `$p.Connect(15000)
  `$w = New-Object System.IO.StreamWriter(`$p)
  `$w.AutoFlush = `$true
  `$r = New-Object System.IO.StreamReader(`$p)
  `$w.WriteLine([System.IO.File]::ReadAllText('$reqFile'))
  `$line = `$r.ReadLine()
  [System.IO.File]::WriteAllText('$outFile', `$line)
} catch {
  [System.IO.File]::WriteAllText('$outFile', 'ERROR: ' + `$_.Exception.Message)
}
"@ | Set-Content -Path $scriptPath -Encoding UTF8

$task = "NeoPipe$id"
schtasks.exe /Create /TN $task /TR "powershell.exe -NoProfile -ExecutionPolicy Bypass -File `"$scriptPath`"" /SC ONCE /ST 00:00 /RU SYSTEM /RL HIGHEST /F | Out-Null
if ($LASTEXITCODE -ne 0) { throw "schtasks /Create failed with $LASTEXITCODE" }
try {
  schtasks.exe /Run /TN $task | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "schtasks /Run failed with $LASTEXITCODE" }
  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  while (-not (Test-Path $outFile)) {
    if ((Get-Date) -gt $deadline) { throw "no reply from the pipe within $TimeoutSeconds seconds" }
    Start-Sleep -Milliseconds 500
  }
  Start-Sleep -Milliseconds 200
  $reply = [System.IO.File]::ReadAllText($outFile)
} finally {
  try { schtasks.exe /Delete /TN $task /F 2>&1 | Out-Null } catch { }
  Remove-Item -Force -ErrorAction SilentlyContinue $scriptPath, $reqFile, $outFile
}
if ($reply.StartsWith('ERROR:')) { throw $reply }
Write-Output $reply
