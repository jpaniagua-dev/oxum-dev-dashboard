; Hooks into electron-builder's NSIS templates (node_modules/app-builder-lib/templates/nsis).

; The uninstaller already exists, in the install folder and under Installed apps; this puts it next to
; the app in the Start menu, where it is found without knowing either.
!macro customInstall
  CreateShortCut "$SMPROGRAMS\Uninstall ${SHORTCUT_NAME}.lnk" "$INSTDIR\${UNINSTALL_FILENAME}"
!macroend

!macro customUnInstall
  Delete "$SMPROGRAMS\Uninstall ${SHORTCUT_NAME}.lnk"

  ; An update runs the previous uninstaller silently with --updated: asking there, or deleting, would
  ; wipe the settings of an app that is being kept. Only a person uninstalling by hand is asked, and
  ; No is the default because the data outlives a reinstall otherwise.
  ${IfNot} ${Silent}
  ${AndIfNot} ${isUpdated}
    MessageBox MB_YESNO|MB_ICONQUESTION|MB_DEFBUTTON2 \
      "Also delete the settings and data of ${PRODUCT_NAME}?$\r$\n$\r$\nChoose No to keep them for a later reinstall." \
      /SD IDNO IDNO keepAppData
      ; The same folders the template's own --delete-app-data removes. The app is already closed:
      ; the uninstaller checked for a running instance before this macro.
      RMDir /r "$APPDATA\${APP_FILENAME}"
      !ifdef APP_PRODUCT_FILENAME
        RMDir /r "$APPDATA\${APP_PRODUCT_FILENAME}"
      !endif
      !ifdef APP_PACKAGE_NAME
        RMDir /r "$APPDATA\${APP_PACKAGE_NAME}"
      !endif
    keepAppData:
  ${EndIf}
!macroend
