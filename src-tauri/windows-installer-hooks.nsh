!macro NSIS_HOOK_PREINSTALL
  ; Preserve the original per-user install directory after the product rename.
  IfFileExists "$LOCALAPPDATA\小玉米\小玉米.exe" 0 +2
    StrCpy $INSTDIR "$LOCALAPPDATA\小玉米"
!macroend
