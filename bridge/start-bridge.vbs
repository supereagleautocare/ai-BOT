' Starts the AI Helper bridge hidden (no window). Restarts it if it ever exits.
' To run at login: press Win+R, type  shell:startup , and put a shortcut to this file there.
Set fso = CreateObject("Scripting.FileSystemObject")
here = fso.GetParentFolderName(WScript.ScriptFullName)
Set sh = CreateObject("WScript.Shell")
Do
  code = sh.Run("""C:\Program Files\nodejs\node.exe"" """ & here & "\bridge.js""", 0, True)
  If code = 3 Then WScript.Quit ' another copy is already running
  WScript.Sleep 10000
Loop
