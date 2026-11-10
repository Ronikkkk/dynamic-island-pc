# Diagnostic: list UI Automation buttons of the Yandex Music window.
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
$out = Join-Path $PSScriptRoot 'ymdump.txt'
$lines = New-Object System.Collections.ArrayList
function Add-Line($t) { [void]$lines.Add($t) }

$procs = @(Get-Process | Where-Object { $_.MainWindowHandle -ne [IntPtr]::Zero -and $_.Path -like '*\YandexMusic\*' })
Add-Line ('windows found: ' + $procs.Count)
foreach ($p in $procs) {
  Add-Line ('process ' + $p.Id + ' handle ' + $p.MainWindowHandle)
  for ($round = 1; $round -le 3; $round++) {
    try {
      $root = [System.Windows.Automation.AutomationElement]::FromHandle($p.MainWindowHandle)
      $cond = New-Object System.Windows.Automation.OrCondition(
        (New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::Button)),
        (New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::CheckBox)),
        (New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::RadioButton)))
      $els = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, $cond)
      Add-Line ('round ' + $round + ': buttons ' + $els.Count)
      if ($els.Count -gt 0) {
        $n = 0
        foreach ($e in $els) {
          $n++
          if ($n -gt 120) { break }
          $pats = ($e.GetSupportedPatterns() | ForEach-Object { $_.ProgrammaticName.Replace('PatternIdentifiers.Pattern','') }) -join ','
          $r = $e.Current.BoundingRectangle
          Add-Line ('  [' + $e.Current.ControlType.ProgrammaticName.Replace('ControlType.','') + '] name="' + $e.Current.Name + '" id="' + $e.Current.AutomationId + '" help="' + $e.Current.HelpText + '" pats=' + $pats + ' rect=' + [int]$r.X + ',' + [int]$r.Y + ',' + [int]$r.Width + ',' + [int]$r.Height)
        }
        break
      }
    } catch { Add-Line ('round ' + $round + ' ERROR: ' + $_.Exception.Message) }
    Start-Sleep -Seconds 3
  }
}
[System.IO.File]::WriteAllLines($out, [string[]]$lines, (New-Object System.Text.UTF8Encoding($true)))
