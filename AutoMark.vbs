' AutoMark silent one-click launcher (no console window).
' Double-click this file: hidden background, starts AutoMark.bat
' which auto-installs deps on first run and opens the Electron app.
Set fso = CreateObject("Scripting.FileSystemObject")
Set sh  = CreateObject("WScript.Shell")
scriptDir = fso.GetParentFolderName(WScript.ScriptFullName)
batPath = fso.BuildPath(scriptDir, "AutoMark.bat")
' 0 = hidden window, False = do not wait
sh.Run """" & batPath & """", 0, False
