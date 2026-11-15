# Island for Windows: game mode stats bridge.
# Every second prints one JSON line: {"gpu":<0..100 | -1>,"fps":<n | -1 no RTSS | -2 RTSS without this game>}
# GPU load: Windows "GPU Engine" performance counters (3D engine).
# FPS: RivaTuner Statistics Server shared memory (RTSSSharedMemoryV2), if RTSS is running.
param([int]$ParentPid = 0)
$ErrorActionPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public static class IslGameWin {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
}
"@
Add-Type -AssemblyName System.Core

function Get-FgPid {
  $p = [uint32]0
  [void][IslGameWin]::GetWindowThreadProcessId([IslGameWin]::GetForegroundWindow(), [ref]$p)
  return [int]$p
}

$script:gpuCounters = @()
$script:gpuRefresh = [DateTime]::MinValue
$script:gpuLast = -1
function Get-Gpu {
  if (([DateTime]::Now - $script:gpuRefresh).TotalSeconds -gt 15) {
    $script:gpuRefresh = [DateTime]::Now
    foreach ($c in $script:gpuCounters) { try { $c.Dispose() } catch {} }
    $script:gpuCounters = @()
    try {
      $cat = New-Object System.Diagnostics.PerformanceCounterCategory('GPU Engine')
      foreach ($n in $cat.GetInstanceNames()) {
        if ($n -like '*engtype_3D*') {
          $c = New-Object System.Diagnostics.PerformanceCounter('GPU Engine', 'Utilization Percentage', $n, $true)
          [void]$c.NextValue()
          $script:gpuCounters += $c
        }
      }
    } catch {}
    return $script:gpuLast
  }
  if ($script:gpuCounters.Count -eq 0) { return -1 }
  $sum = 0.0
  foreach ($c in $script:gpuCounters) { try { $sum += $c.NextValue() } catch {} }
  if ($sum -gt 100) { $sum = 100 }
  $script:gpuLast = [int][Math]::Round($sum)
  return $script:gpuLast
}

function Get-Fps([int]$fgPid) {
  $mmf = $null
  try {
    $mmf = [System.IO.MemoryMappedFiles.MemoryMappedFile]::OpenExisting('RTSSSharedMemoryV2', [System.IO.MemoryMappedFiles.MemoryMappedFileRights]::Read)
  } catch { return -1 }
  if ($null -eq $mmf) { return -1 }
  try {
    $va = $mmf.CreateViewAccessor(0, 0, [System.IO.MemoryMappedFiles.MemoryMappedFileAccess]::Read)
    try {
      if ($va.ReadUInt32(0) -ne 0x52545353) { return -1 }
      $entSize = [long]$va.ReadUInt32(8)
      $arrOff = [long]$va.ReadUInt32(12)
      $arrSize = [long]$va.ReadUInt32(16)
      for ($i = 0; $i -lt $arrSize; $i++) {
        $o = $arrOff + $i * $entSize
        $epid = [int]$va.ReadUInt32($o)
        if ($epid -ne 0 -and $epid -eq $fgPid) {
          $t0 = [double]$va.ReadUInt32($o + 268)
          $t1 = [double]$va.ReadUInt32($o + 272)
          $fr = [double]$va.ReadUInt32($o + 276)
          if ($t1 -gt $t0) { return [int][Math]::Round(1000.0 * $fr / ($t1 - $t0)) }
          return 0
        }
      }
      return -2
    } finally { $va.Dispose() }
  } catch { return -1 } finally { $mmf.Dispose() }
}

Add-Type -Namespace IslandMem -Name Ws -MemberDefinition '[DllImport("psapi.dll")] public static extern bool EmptyWorkingSet(IntPtr h);' -ErrorAction SilentlyContinue
$n = 0
while ($true) {
  if ($ParentPid -gt 0 -and ($n % 5) -eq 0) {
    if (-not (Get-Process -Id $ParentPid -ErrorAction SilentlyContinue)) { break }
  }
  $n++
  $g = Get-Gpu
  $f = Get-Fps (Get-FgPid)
  [Console]::Out.WriteLine('{"gpu":' + $g + ',"fps":' + $f + '}')
  [Console]::Out.Flush()
  if (($n % 60) -eq 0) { [GC]::Collect(); try { [void][IslandMem.Ws]::EmptyWorkingSet((Get-Process -Id $PID).Handle) } catch { } }
  Start-Sleep -Milliseconds 1000
}
