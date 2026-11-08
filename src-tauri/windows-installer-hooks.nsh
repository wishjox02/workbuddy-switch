!macro NSIS_HOOK_PREINSTALL
  ; Preserve the original per-user install directory after the product rename.
  IfFileExists "$LOCALAPPDATA\小玉米\小玉米.exe" 0 +2
    StrCpy $INSTDIR "$LOCALAPPDATA\小玉米"
  ; Stop both executable names so the installer can replace the running file.
  nsExec::ExecToLog 'taskkill /F /IM 小玉米.exe /T'
  nsExec::ExecToLog 'taskkill /F /IM 小玉米API.exe /T'
!macroend

!macro NSIS_HOOK_POSTINSTALL
  ; The NSIS shortcut migration above retargets old shortcuts; keep one executable.
  Delete "$INSTDIR\小玉米.exe"
!macroend
