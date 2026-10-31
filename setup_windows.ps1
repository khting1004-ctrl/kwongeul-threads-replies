$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$envFile = Join-Path $root '.env'
$template = Join-Path $root '.env.example'
if (!(Test-Path -LiteralPath $envFile)) {
  if (!(Test-Path -LiteralPath $template)) { throw 'Missing .env.example' }
  Copy-Item -LiteralPath $template -Destination $envFile
}
$content = [System.IO.File]::ReadAllText($envFile)
$match = [regex]::Match($content, '(?m)^\s*ADMIN_PASSWORD\s*=\s*(.*)$')
$old = if ($match.Success) { $match.Groups[1].Value.Trim().Trim('"', "'") } else { '' }
$placeholder = $old -match '^(CHANGE_THIS|YOUR_|example|password)' 
if ($old.Length -lt 12 -or $placeholder) {
  $bytes = New-Object byte[] 24
  $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
  try { $rng.GetBytes($bytes) } finally { $rng.Dispose() }
  $password = [Convert]::ToBase64String($bytes).TrimEnd('=').Replace('+','-').Replace('/','_')
  if ($match.Success) {
    $content = [regex]::Replace($content, '(?m)^\s*ADMIN_PASSWORD\s*=\s*.*$', ('ADMIN_PASSWORD=' + $password))
  } else {
    $content = $content.TrimEnd("`r", "`n") + "`r`nADMIN_PASSWORD=" + $password + "`r`n"
  }
  [System.IO.File]::WriteAllText($envFile, $content, (New-Object System.Text.UTF8Encoding($false)))
  $secretFile = Join-Path $root 'LOGIN_PASSWORD.txt'
  [System.IO.File]::WriteAllText($secretFile, "Username: admin`r`nPassword: $password`r`nURL: http://localhost:3000`r`n`r`nDelete this file after saving your password safely.`r`n", (New-Object System.Text.UTF8Encoding($false)))
  Write-Host '[FIXED] Admin password was invalid (short or placeholder).'
  Write-Host 'Your new login password was saved in LOGIN_PASSWORD.txt.'
  Write-Host 'Keep it private and delete that text file after login.'
} else {
  Write-Host '[OK] Existing admin password is valid (12+ chars). No changes made.'
}
