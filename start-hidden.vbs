' Starts the island with no console window and no taskbar button.
Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
dir = fso.GetParentFolderName(WScript.ScriptFullName)
sh.CurrentDirectory = dir
exe = dir & "\node_modules\electron\dist\electron.exe"
If fso.FileExists(exe) Then
  sh.Run """" & exe & """ """ & dir & """", 1, False
Else
  sh.Run "cmd /c npm start", 0, False
End If
