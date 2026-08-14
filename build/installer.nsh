; BepInExManager 自定义 NSIS 卸载逻辑
; 目的：卸载/升级时删除程序文件，但保留 <安装目录>/data/（插件库、档案、缓存等用户数据）
; 原理：electron-builder 卸载模板检测到 customRemoveFiles 宏时跳过默认的 RMDir /r $INSTDIR
; 注意：本文件必须保持纯 ASCII（NSIS 编译器对非 ASCII 敏感）

!macro customRemoveFiles
  ; 删除程序文件（保留 data/）
  RMDir /r "$INSTDIR\locales"
  RMDir /r "$INSTDIR\resources"
  RMDir /r "$INSTDIR\swiftshader"
  Delete "$INSTDIR\BepInExManager.exe"
  Delete "$INSTDIR\Uninstall BepInExManager.exe"
  Delete "$INSTDIR\*.dll"
  Delete "$INSTDIR\*.pak"
  Delete "$INSTDIR\*.bin"
  Delete "$INSTDIR\*.dat"
  Delete "$INSTDIR\*.json"
  Delete "$INSTDIR\*.yml"
  Delete "$INSTDIR\*.html"
  Delete "$INSTDIR\*.txt"
  Delete "$INSTDIR\LICENSES*"
  ; 清理空的安装目录（data/ 存在时 RMDir 非递归删除会失败并保留，正好保护数据）
  RMDir "$INSTDIR"
!macroend
