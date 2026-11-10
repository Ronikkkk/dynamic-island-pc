param([string]$Action = 'open', [string]$App = 'Discord')
$ErrorActionPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
Add-Type -TypeDefinition @'
using System; using System.Runtime.InteropServices;
public class IFWWin {
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int n);
}
'@

Add-Type -TypeDefinition @'
using System; using System.Runtime.InteropServices;
public static class IFWMouse {
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT p);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f, uint dx, uint dy, uint d, IntPtr e);
  public struct POINT { public int X; public int Y; }
  public static void Click(int x, int y) {
    POINT old; GetCursorPos(out old);
    SetCursorPos(x, y); mouse_event(2, 0, 0, 0, IntPtr.Zero); mouse_event(4, 0, 0, 0, IntPtr.Zero);
    System.Threading.Thread.Sleep(60); SetCursorPos(old.X, old.Y);
  }
}
'@

function Focus-App {
  if ($App -eq 'Discord') { $names = @('Discord') } else { $names = @('Telegram', 'Telegram Desktop') }
  foreach ($n in $names) {
    $p = Get-Process -Name $n | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1
    if ($p) { [IFWWin]::ShowWindow($p.MainWindowHandle, 9) | Out-Null; [IFWWin]::SetForegroundWindow($p.MainWindowHandle) | Out-Null; return $true }
  }
  return $false
}

if ($Action -ne 'open') {
  if ($Action -eq 'accept') {
    $rx = '(?i)accept|answer|join|принять|ответить|присоедин'
  } else {
    $rx = '(?i)decline|reject|ignore|отклонить|отклон|сброс|игнор'
  }
  $root = [Windows.Automation.AutomationElement]::RootElement
  $cls = New-Object Windows.Automation.PropertyCondition([Windows.Automation.AutomationElement]::ClassNameProperty, 'Windows.UI.Core.CoreWindow')
  $btn = New-Object Windows.Automation.PropertyCondition([Windows.Automation.AutomationElement]::ControlTypeProperty, [Windows.Automation.ControlType]::Button)
  foreach ($w in $root.FindAll('Children', $cls)) {
    foreach ($b in $w.FindAll('Descendants', $btn)) {
      if ($b.Current.Name -match $rx) {
        $ip = $b.GetCurrentPattern([Windows.Automation.InvokePattern]::Pattern)
        if ($ip) { $ip.Invoke(); 'invoked'; exit }
      }
    }
  }
  # Окно самого приложения (Discord на Chromium отдаёт кнопки через UI Automation)
  if ($App -eq 'Discord') { $pn = 'Discord' } else { $pn = 'Telegram' }
  if ($Action -eq 'accept') { $rx2 = '(?i)^\s*(accept|join|join call|\u043f\u0440\u0438\u043d\u044f\u0442\u044c|\u043f\u0440\u0438\u0441\u043e\u0435\u0434\u0438\u043d\u0438\u0442\u044c\u0441\u044f|\u043f\u0440\u0438\u043d\u044f\u0442\u044c \u0437\u0432\u043e\u043d\u043e\u043a)\s*$' }
  else { $rx2 = '(?i)^\s*(decline|ignore|reject|\u043e\u0442\u043a\u043b\u043e\u043d\u0438\u0442\u044c|\u0438\u0433\u043d\u043e\u0440\u0438\u0440\u043e\u0432\u0430\u0442\u044c)\s*$' }
  $names = New-Object System.Collections.ArrayList
  $ids = @(Get-Process -Name $pn | ForEach-Object { $_.Id })
  Focus-App | Out-Null
  Start-Sleep -Milliseconds 400
  for ($try = 0; $try -lt 3; $try++) {
    foreach ($w in $root.FindAll('Children', [Windows.Automation.Condition]::TrueCondition)) {
      if ($ids -notcontains $w.Current.ProcessId) { continue }
      foreach ($e in $w.FindAll('Descendants', [Windows.Automation.Condition]::TrueCondition)) {
        $nm = $e.Current.Name
        if ($nm -and $nm.Length -le 24 -and $names.Count -lt 40 -and ($e.Current.ControlType -eq [Windows.Automation.ControlType]::Button) -and -not $e.Current.IsOffscreen -and ($names -notcontains $nm)) { [void]$names.Add($nm) }
        if ($nm -and $nm -match $rx2) {
          if ($e.Current.IsOffscreen) { continue }
          $r = $e.Current.BoundingRectangle
          if ($r.Width -le 4 -or $r.Height -le 4 -or $r.Width -gt 600) { continue }
          [IFWMouse]::Click([int]($r.X + $r.Width / 2), [int]($r.Y + $r.Height / 2))
          'clicked-app:' + $nm + ':' + [int]$r.Width + 'x' + [int]$r.Height; exit
        }
      }
    }
    Start-Sleep -Milliseconds 900
  }
  $nl = ($names -join ',')
  if ($Action -eq 'accept' -and (Focus-App)) { 'focused:' + $nl; exit }
  'none:' + $nl; exit
}
if (Focus-App) { 'focused' } else { 'none' }
