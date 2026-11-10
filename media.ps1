param([string]$CmdFile)

# Bridge to Windows system media sessions (SMTC).
# Browsers, Yandex Music, Spotify and other players expose controls through it.
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -AssemblyName System.Runtime.WindowsRuntime

$asTask = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
  $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
})[0]

function Await($op, $type) {
  $m = $asTask.MakeGenericMethod($type)
  $t = $m.Invoke($null, @($op))
  $t.Wait(-1) | Out-Null
  $t.Result
}

$null = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager, Windows.Media.Control, ContentType = WindowsRuntime]
$null = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties, Windows.Media.Control, ContentType = WindowsRuntime]
$null = [Windows.Storage.Streams.IRandomAccessStreamWithContentType, Windows.Storage.Streams, ContentType = WindowsRuntime]
$null = [Windows.Media.MediaPlaybackAutoRepeatMode, Windows.Media, ContentType = WindowsRuntime]
$mgrType = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager]
$propType = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties]
$strType = [Windows.Storage.Streams.IRandomAccessStreamWithContentType]
$mgr = Await ($mgrType::RequestAsync()) $mgrType

# Diagnostic log next to this script (media.log).
$LogFile = Join-Path $PSScriptRoot 'media.log'
function Log($m) {
  try { Add-Content -LiteralPath $LogFile -Value ((Get-Date -Format 'HH:mm:ss') + ' ' + $m) } catch { }
}
Log '--- media bridge started ---'

# Cover art as a data URL (empty string if the player gives none).
$script:why = ''
function Get-Thumb($p) {
  $script:why = ''
  try {
    if (-not $p.Thumbnail) { $script:why = 'no thumbnail reference from player'; return '' }
    $rs = Await ($p.Thumbnail.OpenReadAsync()) $strType
    if (-not $rs) { $script:why = 'OpenReadAsync returned null'; return '' }
    $asStream = ([System.IO.WindowsRuntimeStreamExtensions].GetMethods() | Where-Object {
      $_.Name -eq 'AsStreamForRead' -and $_.GetParameters().Count -eq 1
    })[0]
    $stream = $asStream.Invoke($null, @($rs))
    $ms = New-Object System.IO.MemoryStream
    $stream.CopyTo($ms)
    $ct = [string]$rs.ContentType
    if (-not $ct) { $ct = 'image/jpeg' }
    $bytes = $ms.ToArray()
    $stream.Dispose(); $ms.Dispose()
    $script:why = 'got ' + $bytes.Length + ' bytes, type ' + $ct
    if ($bytes.Length -lt 100 -or $bytes.Length -gt 3000000) { $script:why = $script:why + ' (size out of range)'; return '' }
    return 'data:' + $ct + ';base64,' + [Convert]::ToBase64String($bytes)
  } catch {
    $script:why = 'ERROR: ' + $_.Exception.Message
    return ''
  }
}


# Foreground window detection (to hide the island in browsers and fullscreen apps).
Add-Type -AssemblyName System.Windows.Forms
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public class FgWin {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassName(IntPtr hWnd, System.Text.StringBuilder sb, int max);
}
"@
$fgHwnd = [IntPtr]::Zero
$fgProc = ''
$fgPath = ''
$fgSent = ''
$shellProcs = @('desktop', 'explorer', 'shellexperiencehost', 'searchhost', 'searchapp', 'startmenuexperiencehost', 'textinputhost', 'lockapp', 'applicationframehost')

function Check-Foreground {
  $h = [FgWin]::GetForegroundWindow()
  if ($h -eq [IntPtr]::Zero) { return }
  if ($h -ne $script:fgHwnd) {
    $procId = [uint32]0
    [void][FgWin]::GetWindowThreadProcessId($h, [ref]$procId)
    $nm = ''
    try { $nm = (Get-Process -Id $procId -ErrorAction Stop).ProcessName.ToLower() } catch { }
    $pp = ''
    try { $pp = (Get-Process -Id $procId -ErrorAction Stop).Path } catch { }
    if (-not $pp) { $pp = '' }
    $sbc = New-Object System.Text.StringBuilder 256
    [void][FgWin]::GetClassName($h, $sbc, 256)
    $cls = $sbc.ToString()
    if ($cls -eq 'Progman' -or $cls -eq 'WorkerW' -or $cls -eq 'Shell_TrayWnd') { $nm = 'desktop'; $pp = '' }
    $script:fgHwnd = $h
    $script:fgProc = $nm
    $script:fgPath = $pp
  }
  $rc = New-Object FgWin+RECT
  [void][FgWin]::GetWindowRect($h, [ref]$rc)
  $b = [System.Windows.Forms.Screen]::FromHandle($h).Bounds
  $full = ($rc.Left -le $b.Left) -and ($rc.Top -le $b.Top) -and ($rc.Right -ge $b.Right) -and ($rc.Bottom -ge $b.Bottom)
  if ($shellProcs -contains $script:fgProc) { $full = $false }
  $safePath = (($script:fgPath -replace '\\', '\\') -replace '"', '')
  $msg = '{"kind":"fg","proc":"' + ($script:fgProc -replace '[^a-z0-9._ -]', '') + '","path":"' + $safePath + '","full":' + $(if ($full) { 'true' } else { 'false' }) + '}'
  if ($msg -ne $script:fgSent) {
    [Console]::WriteLine($msg)
    $script:fgSent = $msg
  }
}

$lastSig = ''
function Pick-Session {
  $cur = $mgr.GetCurrentSession()
  $list = @()
  try { $list = @($mgr.GetSessions()) } catch { }
  $sig = ''
  foreach ($x in $list) { try { $sig += [string]$x.SourceAppUserModelId + '=' + $x.GetPlaybackInfo().PlaybackStatus.ToString() + '; ' } catch { } }
  $sig = 'fg=' + $script:fgProc + ' sessions: ' + $sig
  if ($sig -ne $script:lastSig) { $script:lastSig = $sig; Log $sig }
  if ($list.Count -le 1) { return $cur }
  $playing = @()
  foreach ($x in $list) {
    try { if ($x.GetPlaybackInfo().PlaybackStatus.ToString() -eq 'Playing') { $playing += $x } } catch { }
  }
  if ($playing.Count -eq 0) { return $cur }
  $fp = [string]$script:fgProc
  if ($fp -ne '') {
    $needle = $fp
    if ($fp -eq 'browser') { $needle = 'yandex' }
    if ($fp -eq 'msedge') { $needle = 'edge' }
    foreach ($x in $playing) {
      $id = ([string]$x.SourceAppUserModelId).ToLower()
      if ($id.Contains($needle) -and -not $id.Contains('music')) { return $x }
    }
  }
  if ($cur) {
    foreach ($x in $playing) { if ([string]$x.SourceAppUserModelId -eq [string]$cur.SourceAppUserModelId) { return $cur } }
  }
  return $playing[0]
}

$thumbKey = ''
$thumbTries = 0
$lastErr = ''

while ($true) {
  try {
    if (Test-Path -LiteralPath $CmdFile) {
      $cmd = (Get-Content -LiteralPath $CmdFile -Raw).Trim()
      Remove-Item -LiteralPath $CmdFile -Force -ErrorAction SilentlyContinue
      $cs = Pick-Session
      if ($cs) {
        if ($cmd -eq 'toggle') { $null = Await ($cs.TryTogglePlayPauseAsync()) ([bool]) }
        elseif ($cmd -eq 'next') { $null = Await ($cs.TrySkipNextAsync()) ([bool]) }
        elseif ($cmd -eq 'prev') { $null = Await ($cs.TrySkipPreviousAsync()) ([bool]) }
        elseif ($cmd -eq 'shuffle') {
          $cur = $cs.GetPlaybackInfo().IsShuffleActive
          $want = -not [bool]$cur
          $null = Await ($cs.TryChangeShuffleActiveAsync($want)) ([bool])
        }
        elseif ($cmd -eq 'repeat') {
          $cm = $cs.GetPlaybackInfo().AutoRepeatMode
          $curName = 'None'
          if ($null -ne $cm) { $curName = $cm.ToString() }
          if ($curName -eq 'None') { $nextName = 'List' } elseif ($curName -eq 'List') { $nextName = 'Track' } else { $nextName = 'None' }
          $nextMode = [Windows.Media.MediaPlaybackAutoRepeatMode]$nextName
          $null = Await ($cs.TryChangeAutoRepeatModeAsync($nextMode)) ([bool])
        }
        elseif ($cmd -like 'seek:*') {
          $ms = [double]$cmd.Substring(5)
          $tl0 = $cs.GetTimelineProperties()
          $ticks = [long](($ms + $tl0.StartTime.TotalMilliseconds) * 10000)
          $null = Await ($cs.TryChangePlaybackPositionAsync($ticks)) ([bool])
        }
      }
    }

    $s = Pick-Session
    if ($s) {
      $p = Await ($s.TryGetMediaPropertiesAsync()) $propType
      $status = $s.GetPlaybackInfo().PlaybackStatus.ToString()
      $title = [string]$p.Title
      $artist = [string]$p.Artist
      $app = [string]$s.SourceAppUserModelId
      $key = $title + '|' + $artist + '|' + $app

      $dur = 0.0
      $pos = 0.0
      try {
        $tl = $s.GetTimelineProperties()
        $start = $tl.StartTime.TotalMilliseconds
        $dur = $tl.EndTime.TotalMilliseconds - $start
        $pos = $tl.Position.TotalMilliseconds - $start
        if ($status -eq 'Playing') {
          $pos += ([DateTimeOffset]::UtcNow - $tl.LastUpdatedTime).TotalMilliseconds
        }
        if ($dur -lt 0) { $dur = 0.0 }
        if ($pos -lt 0) { $pos = 0.0 }
        if ($dur -gt 0 -and $pos -gt $dur) { $pos = $dur }
      } catch { }

      $shuf = $null
      $rep = ''
      try {
        $pi = $s.GetPlaybackInfo()
        if ($null -ne $pi.IsShuffleActive) { $shuf = [bool]$pi.IsShuffleActive }
        if ($null -ne $pi.AutoRepeatMode) { $rep = $pi.AutoRepeatMode.ToString() }
      } catch { }

      $obj = [ordered]@{
        kind   = 'info'
        shuffle = $shuf
        repeat = $rep
        ok     = $true
        key    = $key
        title  = $title
        artist = $artist
        status = $status
        app    = $app
        pos    = [math]::Round($pos)
        dur    = [math]::Round($dur)
      }
      [Console]::WriteLine(($obj | ConvertTo-Json -Compress))

      if ($key -ne $thumbKey) {
        if ($thumbTries -eq 0) { Log ('track: ' + $key + ' status=' + $status) }
        $data = Get-Thumb $p
        $thumbTries++
        if ($data -ne '' -or $thumbTries -ge 6) {
          Log ('thumbnail result: ' + $(if ($data -ne '') { 'OK' } else { 'EMPTY after retries' }))
          $thumbKey = $key
          $thumbTries = 0
          $tobj = [ordered]@{ kind = 'thumb'; key = $key; data = $data; why = $script:why }
          [Console]::WriteLine(($tobj | ConvertTo-Json -Compress))
        }
      }
    } else {
      [Console]::WriteLine('{"kind":"info","ok":false}')
    }
  } catch {
    $em = $_.Exception.Message
    if ($em -ne $lastErr) { Log ('loop ERROR: ' + $em); $lastErr = $em }
  }
  try { Check-Foreground } catch { }
  Start-Sleep -Milliseconds 400
}
