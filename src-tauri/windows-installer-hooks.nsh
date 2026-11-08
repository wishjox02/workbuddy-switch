!macro NSIS_HOOK_PREINSTALL
  ; Preserve the original per-user install directory after the product rename.
  IfFileExists "$LOCALAPPDATA\小玉米\小玉米.exe" 0 +2
    StrCpy $INSTDIR "$LOCALAPPDATA\小玉米"
  ; Stop the pre-rename executable so it can no longer keep an old process alive.
  nsExec::ExecToLog 'taskkill /F /IM 小玉米.exe /T'
!macroend

!macro NSIS_HOOK_POSTINSTALL
  ; Keep old pinned shortcuts working after the product/binary rename.
  IfFileExists "$INSTDIR\小玉米API.exe" 0 +2
    CopyFiles /SILENT "$INSTDIR\小玉米API.exe" "$INSTDIR\小玉米.exe"
!macroend
