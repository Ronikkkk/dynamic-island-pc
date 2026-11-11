param(
  [string]$Db = "$env:LOCALAPPDATA\Microsoft\Windows\Notifications\wpndatabase.db",
  [string]$Filter = 'discord|telegram',
  [int]$ParentPid = 0
)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class WSQ {
  const string D = "winsqlite3.dll";
  [DllImport(D, CallingConvention = CallingConvention.Cdecl)] static extern int sqlite3_open_v2(byte[] f, out IntPtr db, int flags, IntPtr vfs);
  [DllImport(D, CallingConvention = CallingConvention.Cdecl)] static extern int sqlite3_close(IntPtr db);
  [DllImport(D, CallingConvention = CallingConvention.Cdecl)] static extern int sqlite3_busy_timeout(IntPtr db, int ms);
  [DllImport(D, CallingConvention = CallingConvention.Cdecl)] static extern int sqlite3_prepare_v2(IntPtr db, byte[] sql, int n, out IntPtr st, IntPtr tail);
  [DllImport(D, CallingConvention = CallingConvention.Cdecl)] static extern int sqlite3_step(IntPtr st);
  [DllImport(D, CallingConvention = CallingConvention.Cdecl)] static extern int sqlite3_finalize(IntPtr st);
  [DllImport(D, CallingConvention = CallingConvention.Cdecl)] static extern long sqlite3_column_int64(IntPtr st, int i);
  [DllImport(D, CallingConvention = CallingConvention.Cdecl)] static extern IntPtr sqlite3_column_text(IntPtr st, int i);
  [DllImport(D, CallingConvention = CallingConvention.Cdecl)] static extern IntPtr sqlite3_column_blob(IntPtr st, int i);
  [DllImport(D, CallingConvention = CallingConvention.Cdecl)] static extern int sqlite3_column_bytes(IntPtr st, int i);
  public static IntPtr Open(string path, int flags) {
    IntPtr db; byte[] b = Encoding.UTF8.GetBytes(path + "\0");
    int rc = sqlite3_open_v2(b, out db, flags, IntPtr.Zero);
    if (rc != 0) { if (db != IntPtr.Zero) sqlite3_close(db); return IntPtr.Zero; }
    sqlite3_busy_timeout(db, 800);
    return db;
  }
  public static void Close(IntPtr db) { sqlite3_close(db); }
  public static IntPtr Prep(IntPtr db, string sql) {
    IntPtr st; byte[] b = Encoding.UTF8.GetBytes(sql + "\0");
    if (sqlite3_prepare_v2(db, b, -1, out st, IntPtr.Zero) != 0) return IntPtr.Zero;
    return st;
  }
  public static bool Step(IntPtr st) { return sqlite3_step(st) == 100; }
  public static void Fin(IntPtr st) { sqlite3_finalize(st); }
  public static long I64(IntPtr st, int i) { return sqlite3_column_int64(st, i); }
  public static string Txt(IntPtr st, int i) {
    IntPtr p = sqlite3_column_text(st, i); if (p == IntPtr.Zero) return "";
    int n = sqlite3_column_bytes(st, i); byte[] b = new byte[n]; Marshal.Copy(p, b, 0, n);
    return Encoding.UTF8.GetString(b);
  }
  public static byte[] Blob(IntPtr st, int i) {
    int n = sqlite3_column_bytes(st, i); if (n <= 0) return new byte[0];
    IntPtr p = sqlite3_column_blob(st, i); byte[] b = new byte[n]; Marshal.Copy(p, b, 0, n);
    return b;
  }
}
'@

function Out-Json($o) { [Console]::Out.WriteLine(($o | ConvertTo-Json -Compress)); [Console]::Out.Flush() }
function Diag($m) { Out-Json ([pscustomobject]@{ kind = 'diag'; msg = [string]$m }) }

$script:tmp = $null
function Open-Wpn {
  $h = [WSQ]::Open($Db, 1)               # только чтение, живая база
  if ($h -ne [IntPtr]::Zero) { return $h }
  try {                                   # запасной путь: копия базы с журналом
    if (-not $script:tmp) { $script:tmp = Join-Path $env:TEMP ('ifw-wpn-' + $PID); New-Item -ItemType Directory -Force $script:tmp | Out-Null }
    foreach ($sfx in '', '-wal', '-shm') {
      $src = $Db + $sfx
      if (Test-Path $src) {
        $in = [IO.File]::Open($src, 'Open', 'Read', 'ReadWrite,Delete')
        $out = [IO.File]::Create((Join-Path $script:tmp ('w.db' + $sfx)))
        $in.CopyTo($out); $out.Close(); $in.Close()
      }
    }
    return [WSQ]::Open((Join-Path $script:tmp 'w.db'), 2)
  } catch { return [IntPtr]::Zero }
}

function Decode-Payload([byte[]]$b) {
  if ($b.Length -eq 0) { return '' }
  if ($b.Length -ge 2 -and $b[1] -eq 0) { $s = [Text.Encoding]::Unicode.GetString($b) } else { $s = [Text.Encoding]::UTF8.GetString($b) }
  return $s.TrimStart([char]0xFEFF)
}

# Аватар отправителя: берём картинку из самого тоста (appLogoOverride).
# У Discord/Telegram это почти всегда удалённая https-ссылка (CDN), а не локальный файл,
# поэтому для http(s) качаем сами с коротким таймаутом; локальный file:// путь читаем как раньше.
$script:avCache = @{}
function Get-RemoteImg([string]$url) {
  try {
    if ($script:avCache.ContainsKey($url)) { return $script:avCache[$url] }
    $req = [Net.HttpWebRequest]::Create($url)
    $req.Timeout = 3000
    $req.ReadWriteTimeout = 3000
    $req.UserAgent = 'Mozilla/5.0'
    $resp = $req.GetResponse()
    $stream = $resp.GetResponseStream()
    $ms = New-Object IO.MemoryStream
    $stream.CopyTo($ms)
    $resp.Close()
    $bytes = $ms.ToArray()
    if ($bytes.Length -eq 0 -or $bytes.Length -gt 300000) { return '' }
    $ext = 'png'
    if ($url -match '\.(jpe?g)(\?|$)') { $ext = 'jpeg' }
    elseif ($url -match '\.gif(\?|$)') { $ext = 'gif' }
    elseif ($url -match '\.webp(\?|$)') { $ext = 'webp' }
    $data = 'data:image/' + $ext + ';base64,' + [Convert]::ToBase64String($bytes)
    if ($script:avCache.Count -gt 200) { $script:avCache.Clear() }
    $script:avCache[$url] = $data
    return $data
  } catch { return '' }
}
function Get-Avatar($x) {
  try {
    $img = $x.SelectSingleNode("//image[@placement='appLogoOverride']")
    if (-not $img) { $img = $x.SelectSingleNode('//image') }
    if (-not $img) { return '' }
    $src = $img.GetAttribute('src')
    if (-not $src) { return '' }
    if ($src -match '^https?://') { return Get-RemoteImg $src }
    $p = $src
    if ($p -match '^file:///(.+)$') { $p = [Uri]::UnescapeDataString($matches[1]) -replace '/', '\' }
    if (-not (Test-Path -LiteralPath $p)) { return '' }
    $info = Get-Item -LiteralPath $p
    if ($info.Length -gt 300000) { return '' }   # не тащим в остров что-то огромное
    $ext = $info.Extension.TrimStart('.').ToLower()
    if ($ext -eq 'jpg') { $ext = 'jpeg' }
    if ($ext -ne 'png' -and $ext -ne 'jpeg' -and $ext -ne 'gif' -and $ext -ne 'webp') { $ext = 'png' }
    $bytes = [IO.File]::ReadAllBytes($p)
    return 'data:image/' + $ext + ';base64,' + [Convert]::ToBase64String($bytes)
  } catch { return '' }
}

$last = -1
$seen = @{}
$failed = 0
$memTick = 0

while ($true) {
  try {
    $h = Open-Wpn
    if ($h -eq [IntPtr]::Zero) {
      $failed++
      if ($failed -eq 1 -or $failed % 60 -eq 0) { Diag 'cannot open wpndatabase.db' }
      Start-Sleep -Milliseconds 2000
      continue
    }
    if ($failed -gt 0) { Diag 'database opened'; $failed = 0 }
    try {
      if ($last -lt 0) {
        $st = [WSQ]::Prep($h, 'SELECT MAX(Id) FROM Notification')
        if ($st -eq [IntPtr]::Zero) { Diag 'prepare failed (schema?)'; Start-Sleep -Seconds 10; continue }
        $last = 0; if ([WSQ]::Step($st)) { $last = [WSQ]::I64($st, 0) }
        [WSQ]::Fin($st)
        Diag ('ready, baseline id ' + $last)
      } else {
        $sql = 'SELECT n.Id, h.PrimaryId, n.Payload FROM Notification n JOIN NotificationHandler h ON h.RecordId = n.HandlerId WHERE n.Id > ' + [int64]$last + ' ORDER BY n.Id LIMIT 50'
        $st = [WSQ]::Prep($h, $sql)
        if ($st -ne [IntPtr]::Zero) {
          while ([WSQ]::Step($st)) {
            $id = [WSQ]::I64($st, 0); $app = [WSQ]::Txt($st, 1); $blob = [WSQ]::Blob($st, 2)
            if ($id -gt $last) { $last = $id }
            if ($app -notmatch $Filter) { if (-not $seen.ContainsKey($app) -and $seen.Count -lt 40) { $seen[$app] = 1; Diag ('other app: ' + $app) }; continue }
            if (-not $seen.ContainsKey($app)) { $seen[$app] = 1; Diag ('matched app: ' + $app) }
            $xml = Decode-Payload $blob
            $title = ''; $body = ''; $avatar = ''
            try {
              $x = New-Object Xml.XmlDocument; $x.LoadXml($xml)
              $t = @($x.SelectNodes('//text') | ForEach-Object { $_.InnerText } | Where-Object { $_ })
              if ($t.Count -gt 0) { $title = $t[0] }
              if ($t.Count -gt 1) { $body = ($t[1..($t.Count - 1)] -join ' ') }
              $avatar = Get-Avatar $x
            } catch { $body = ($xml -replace '<[^>]+>', ' ') }
            $label = if ($app -match 'discord') { 'Discord' } else { 'Telegram' }
            Diag ('toast ' + $app + ' t=' + $title.Substring(0, [Math]::Min(24, $title.Length)) + ' avatar=' + [bool]$avatar)
            Out-Json ([pscustomobject]@{ kind = 'notif'; id = $id; app = $label; title = $title; text = $body; avatar = $avatar })
          }
          [WSQ]::Fin($st)
        } else { Diag 'prepare failed (schema?)'; Start-Sleep -Seconds 10 }
      }
    } finally { [WSQ]::Close($h) }
  } catch { Diag ('error: ' + $_.Exception.Message); Start-Sleep -Seconds 5 }
  # Раз в ~30 c: остров закрылся/упал — выходим; плюс чистим свою память.
  $memTick++
  if ($memTick % 25 -eq 0) {
    if ($ParentPid -gt 0 -and -not (Get-Process -Id $ParentPid -ErrorAction SilentlyContinue)) { exit }
    [System.GC]::Collect()
  }
  Start-Sleep -Milliseconds 1200
}
