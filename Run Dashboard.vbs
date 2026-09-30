Option Explicit

Dim fso, shell, root, script, command

Set fso = CreateObject("Scripting.FileSystemObject")
Set shell = CreateObject("WScript.Shell")

root = fso.GetParentFolderName(WScript.ScriptFullName)
script = root & "\scripts\run-app.ps1"
command = "powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File " & Chr(34) & script & Chr(34)

shell.CurrentDirectory = root
shell.Run command, 0, False
