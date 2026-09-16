; Windows installer for Klips Engine (Inno Setup 6).
; Built by .github/workflows/build-app.yml from the PyInstaller output in app\dist\Klips.
; The engine has no window: it runs in the background, starts at sign-in, and klips.pro/studio drives it.

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
Name: "desktopicon"; Description: "Create a desktop shortcut to Klips Studio"; GroupDescription: "Shortcuts:"

[Registry]
; Start the engine quietly whenever you sign in to Windows.
Root: HKCU; Subkey: "Software\Microsoft\Windows\CurrentVersion\Run"; ValueType: string; ValueName: "Klips Engine"; ValueData: """{app}\Klips.exe"" --background"; Flags: uninsdeletevalue

[Files]
Source: "..\dist\Klips\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{group}\{#AppName}"; Filename: "{app}\Klips.exe"
Name: "{group}\Uninstall {#AppName}"; Filename: "{uninstallexe}"
Name: "{autodesktop}\{#AppName}"; Filename: "{app}\Klips.exe"; Tasks: desktopicon

[Run]
Filename: "{app}\Klips.exe"; Description: "Start Klips and open Klips Studio"; Flags: nowait postinstall skipifsilent

[UninstallRun]
Filename: "{sys}\taskkill.exe"; Parameters: "/F /IM Klips.exe"; Flags: runhidden; RunOnceId: "StopKlipsEngine"

[Code]
// Stop a running engine first, so its files can be replaced during an update.
function PrepareToInstall(var NeedsRestart: Boolean): String;
var
  ResultCode: Integer;
begin
  Exec(ExpandConstant('{sys}\taskkill.exe'), '/F /IM Klips.exe', '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
  Result := '';
end;
