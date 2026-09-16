; Windows installer for Klips (Inno Setup 6).
; Built by .github/workflows/build-app.yml from the PyInstaller output in app\dist\Klips.

#define AppName "Klips"
#ifndef AppVersion
  #define AppVersion "1.0.0"
#endif

[Setup]
AppId={{6F1C2A9E-4B7D-4C1A-9E57-3B2D8A6C4F10}
AppName={#AppName}
AppVersion={#AppVersion}
AppPublisher=Kirby Chan Digital
AppPublisherURL=https://klips.pro
AppSupportURL=https://klips.pro
DefaultDirName={autopf}\{#AppName}
DefaultGroupName={#AppName}
DisableProgramGroupPage=yes
OutputDir=..\dist
OutputBaseFilename=Klips-windows-setup
Compression=lzma2
SolidCompression=yes
WizardStyle=modern
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
PrivilegesRequired=lowest
PrivilegesRequiredOverridesAllowed=dialog
UninstallDisplayName={#AppName}

[Tasks]
Name: "desktopicon"; Description: "Create a desktop shortcut"; GroupDescription: "Shortcuts:"

[Files]
Source: "..\dist\Klips\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{group}\{#AppName}"; Filename: "{app}\Klips.exe"
Name: "{group}\Uninstall {#AppName}"; Filename: "{uninstallexe}"
Name: "{autodesktop}\{#AppName}"; Filename: "{app}\Klips.exe"; Tasks: desktopicon

[Run]
Filename: "{app}\Klips.exe"; Description: "Open Klips"; Flags: nowait postinstall skipifsilent
