; Script Injector setup (Inno Setup 6). Built by tools/pack.mjs, which writes defines.iss next to the staged
; team-config.json and runs ISCC. The setup downloads the latest version from GitHub (progress bar), installs it to
; %LOCALAPPDATA%\Script Injector (no admin needed), registers an uninstaller in Windows "Installed apps",
; and keeps a copy of itself as the "Update Script Injector" Start menu entry.
#include AddBackslash(StageDir) + "defines.iss"

[Setup]
AppId={{6F3A0C52-9B7E-4C1D-A4D2-5E8B1F0A7C31}
AppName=Script Injector
AppVersion={#AppVersion}
AppVerName=Script Injector
VersionInfoVersion={#AppVersion}
DefaultDirName={localappdata}\Script Injector
DefaultGroupName=Script Injector
DisableDirPage=yes
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
ArchiveExtraction=full
OutputDir={#OutDir}
OutputBaseFilename=ScriptInjector-Setup-{#AppVersion}
SetupIconFile={#StageDir}\setup.ico
UninstallDisplayIcon={app}\icons\icon128.png
UninstallDisplayName=Script Injector
WizardStyle=modern
Compression=lzma2
SolidCompression=yes

[Files]
#ifdef EMBED
Source: "{#StageDir}\team-config.json"; DestDir: "{app}"; Flags: ignoreversion
#endif
Source: "{tmp}\ext.zip"; DestDir: "{tmp}\ext"; Flags: external extractarchive recursesubdirs createallsubdirs ignoreversion deleteafterinstall
; keep a copy of this setup for updates (skipped when already running that copy)
Source: "{srcexe}"; DestDir: "{app}"; DestName: "ScriptInjector-Setup.exe"; Flags: external ignoreversion; Check: NotRunningFromApp

[Tasks]
Name: "autoupdate"; Description: "Update automatically (checks every 6 hours, installs quietly)"; Flags: checkedonce

[Icons]
Name: "{group}\Update Script Injector"; Filename: "{app}\ScriptInjector-Setup.exe"
Name: "{group}\Uninstall Script Injector"; Filename: "{uninstallexe}"
; switch the automatic updater off / on again without reinstalling (pauses / resumes the scheduled task)
Name: "{group}\Script Injector auto-update OFF"; Filename: "{sys}\schtasks.exe"; Parameters: "/Change /TN ""Script Injector Update"" /DISABLE"; IconFilename: "{sys}\shell32.dll"; IconIndex: 131; Tasks: autoupdate
Name: "{group}\Script Injector auto-update ON"; Filename: "{sys}\schtasks.exe"; Parameters: "/Change /TN ""Script Injector Update"" /ENABLE"; IconFilename: "{sys}\shell32.dll"; IconIndex: 238; Tasks: autoupdate

[Run]
Filename: "{cmd}"; Parameters: "/c echo|set /p=""{app}""|clip"; Flags: runhidden; Check: IsFirstInstall
Filename: "chrome.exe"; Parameters: "chrome://extensions"; Description: "Open Chrome's extensions page"; Flags: postinstall shellexec nowait skipifsilent; Check: IsFirstInstall
; quiet updater: Windows scheduled task for this user, every 6 hours (re-created on every install / update)
Filename: "{sys}\schtasks.exe"; Parameters: "/Create /F /SC HOURLY /MO 6 /TN ""Script Injector Update"" /TR ""\""{app}\ScriptInjector-Setup.exe\"" /VERYSILENT /SUPPRESSMSGBOXES /NORESTART"""; Flags: runhidden; Tasks: autoupdate
Filename: "{sys}\schtasks.exe"; Parameters: "/Delete /F /TN ""Script Injector Update"""; Flags: runhidden; Tasks: not autoupdate

[UninstallRun]
Filename: "{sys}\schtasks.exe"; Parameters: "/Delete /F /TN ""Script Injector Update"""; Flags: runhidden; RunOnceId: "DelUpdateTask"

[UninstallDelete]
Type: filesandordirs; Name: "{app}"

[Code]
const
  KEEP = 'manifest.json,icons,src,README.md,CHANGELOG.md';
var
  DownloadPage: TDownloadWizardPage;
  TeamPage: TInputQueryWizardPage;
  WasInstalled: Boolean;
  InstalledVer, LatestVer, Mode: String; // Mode: install | update | repair

function NotRunningFromApp: Boolean;
begin
  Result := CompareText(ExpandConstant('{srcexe}'), ExpandConstant('{app}\ScriptInjector-Setup.exe')) <> 0;
end;

function IsFirstInstall: Boolean;
begin
  Result := not WasInstalled;
end;

// "version": "1.2.3" from manifest.json text
function VersionFrom(S: String): String;
var
  P: Integer;
begin
  Result := '';
  P := Pos('"version"', S);
  if P = 0 then Exit;
  Delete(S, 1, P + 8);
  Delete(S, 1, Pos('"', S));
  Result := Copy(S, 1, Pos('"', S) - 1);
end;

function ManifestVersion(const Dir: String): String;
var
  S: AnsiString;
begin
  Result := '';
  if LoadStringFromFile(Dir + '\manifest.json', S) then Result := VersionFrom(String(S));
end;

// latest version = manifest.json on GitHub (small request, before anything is downloaded)
function FetchLatestVersion: String;
var
  Http: Variant;
begin
  Result := '';
  try
    Http := CreateOleObject('WinHttp.WinHttpRequest.5.1');
    Http.Open('GET', 'https://api.github.com/repos/{#Repo}/contents/manifest.json?ref={#Branch}', False);
    Http.SetRequestHeader('Accept', 'application/vnd.github.raw');
    Http.SetRequestHeader('User-Agent', 'ScriptInjector-Setup');
    if '{#Token}' <> '' then Http.SetRequestHeader('Authorization', 'Bearer {#Token}');
    Http.Send('');
    if Http.Status = 200 then Result := VersionFrom(Http.ResponseText);
  except
    Log('Latest version check failed: ' + GetExceptionMessage);
  end;
end;

function IsNewer(const A, B: String): Boolean; // A > B
var
  PA, PB: Int64;
begin
  Result := StrToVersion(A, PA) and StrToVersion(B, PB) and (ComparePackedVersion(PA, PB) > 0);
end;

function VerText(const V: String): String;
begin
  if V = '' then Result := 'the latest version' else Result := 'v' + V;
end;

function InitializeSetup: Boolean;
var
  Q: String;
begin
  Result := True;
  InstalledVer := ManifestVersion(ExpandConstant('{localappdata}\Script Injector'));
  WasInstalled := InstalledVer <> '';
  LatestVer := FetchLatestVersion;
  if not WasInstalled then Mode := 'install'
  else if (LatestVer = '') or IsNewer(LatestVer, InstalledVer) then Mode := 'update'
  else Mode := 'repair';
  Log('Installed: ' + InstalledVer + ', latest: ' + LatestVer + ', mode: ' + Mode);
  // quiet run (scheduled updater): nothing newer on GitHub, so stop here (nothing is downloaded)
  if WizardSilent and (Mode = 'repair') then begin Result := False; Exit; end;
  if WizardSilent or not WasInstalled then Exit;
  if Mode = 'update' then
    Q := 'Script Injector v' + InstalledVer + ' is already installed.' + #13#10 +
         'Version ' + VerText(LatestVer) + ' is available.' + #13#10#13#10 + 'Do you want to update it?'
  else
    Q := 'Script Injector v' + InstalledVer + ' is already installed and up to date.' + #13#10#13#10 +
         'Do you want to repair it (download and reinstall v' + InstalledVer + ')?';
  Result := MsgBox(Q, mbConfirmation, MB_YESNO) = IDYES;
end;

function HasTeamConfig: Boolean;
begin
  Result := FileExists(ExpandConstant('{localappdata}\Script Injector\team-code.txt')) or FileExists(ExpandConstant('{localappdata}\Script Injector\team-config.json'));
end;

procedure InitializeWizard;
var
  Note: String;
begin
  // team code (the team settings: sync, team scripts, signing key) - pasted once, kept on updates
  if HasTeamConfig then Note := 'Leave it empty to keep your current team code (nothing changes).' else Note := 'You get it from your team admin.';
  TeamPage := CreateInputQueryPage(wpSelectTasks, 'Team code', 'Connect Script Injector to your team',
    'Paste the team code you received (it starts with SI1.). ' + Note);
  TeamPage.Add('Team code:', False);
  DownloadPage := CreateDownloadPage('Downloading Script Injector ' + VerText(LatestVer), 'Getting it from GitHub...', nil);
  DownloadPage.ShowBaseNameInsteadOfUrl := True;
end;

function NextButtonClick(CurPageID: Integer): Boolean;
var
  Code: String;
begin
  Result := True;
  if CurPageID = TeamPage.ID then begin
    Code := Trim(TeamPage.Values[0]);
    if (Code = '') and not HasTeamConfig then begin
      Result := MsgBox('No team code entered. Script Injector will work, but without your team''s scripts and sync until you add one.' + #13#10#13#10 + 'Continue without it?', mbConfirmation, MB_YESNO) = IDYES;
      Exit;
    end;
    if (Code <> '') and ((Copy(Code, 1, 4) <> 'SI1.') or (Length(Code) < 20)) then begin
      MsgBox('That is not a valid team code (it starts with SI1.). Please paste the whole code.', mbError, MB_OK);
      Result := False;
    end;
    Exit;
  end;
  if CurPageID <> wpReady then Exit;
  DownloadPage.Clear;
  if '{#Token}' <> '' then
    // credentials in the URL: AddEx(..., user, password) crashes Inno Setup 6.7 at start-up
    DownloadPage.Add('https://x-access-token:{#Token}@api.github.com/repos/{#Repo}/zipball/{#Branch}', 'ext.zip', '')
  else
    DownloadPage.Add('https://api.github.com/repos/{#Repo}/zipball/{#Branch}', 'ext.zip', '');
  DownloadPage.Show;
  try
    try
      DownloadPage.Download;
    except
      if not DownloadPage.AbortedByUser then
        SuppressibleMsgBox('Download failed: ' + GetExceptionMessage + #13#10#13#10 +
          'Check your internet connection. If it keeps failing, ask for a new installer.', mbCriticalError, MB_OK, IDOK);
      Result := False;
    end;
  finally
    DownloadPage.Hide;
  end;
end;

procedure CopyTree(const Src, Dst: String);
var
  FR: TFindRec;
begin
  ForceDirectories(Dst);
  if FindFirst(Src + '\*', FR) then
  try
    repeat
      if (FR.Name <> '.') and (FR.Name <> '..') then
        if FR.Attributes and FILE_ATTRIBUTE_DIRECTORY <> 0 then
          CopyTree(Src + '\' + FR.Name, Dst + '\' + FR.Name)
        else
          FileCopy(Src + '\' + FR.Name, Dst + '\' + FR.Name, False);
    until not FindNext(FR);
  finally
    FindClose(FR);
  end;
end;

// the GitHub zip has one top folder (OWNER-REPO-sha)
function RepoRoot: String;
var
  FR: TFindRec;
begin
  Result := '';
  if FindFirst(ExpandConstant('{tmp}\ext\*'), FR) then
  try
    repeat
      if (FR.Name <> '.') and (FR.Name <> '..') and (FR.Attributes and FILE_ATTRIBUTE_DIRECTORY <> 0) then
        Result := ExpandConstant('{tmp}\ext\') + FR.Name;
    until (Result <> '') or not FindNext(FR);
  finally
    FindClose(FR);
  end;
end;

procedure CurStepChanged(CurStep: TSetupStep);
var
  Root, Item, Rest, App, Ver: String;
  P: Integer;
begin
  if CurStep <> ssPostInstall then Exit;
  Root := RepoRoot;
  if Root = '' then RaiseException('The downloaded package is empty.');
  App := ExpandConstant('{app}');
  Rest := KEEP + ',';
  while Rest <> '' do begin
    P := Pos(',', Rest);
    Item := Copy(Rest, 1, P - 1);
    Delete(Rest, 1, P);
    if DirExists(Root + '\' + Item) then begin
      DelTree(App + '\' + Item, True, True, True);
      CopyTree(Root + '\' + Item, App + '\' + Item);
    end else if FileExists(Root + '\' + Item) then
      FileCopy(Root + '\' + Item, App + '\' + Item, False);
  end;
  DelTree(ExpandConstant('{tmp}\ext'), True, True, True);
  // marker: this copy was installed by the setup (a copy loaded from a folder has none = developer mode, no auto-apply)
  SaveStringToFile(App + '\install.json', '{"channel":"setup"}', False);
  // a new team code replaces the old settings (an old team-config.json would win over it); empty = keep the current ones
  if (TeamPage <> nil) and (Trim(TeamPage.Values[0]) <> '') then begin
    DeleteFile(App + '\team-config.json');
    SaveStringToFile(App + '\team-code.txt', Trim(TeamPage.Values[0]), False);
  end;
  Ver := ManifestVersion(App);
  if Ver <> '' then
    RegWriteStringValue(HKCU, 'Software\Microsoft\Windows\CurrentVersion\Uninstall\{6F3A0C52-9B7E-4C1D-A4D2-5E8B1F0A7C31}_is1', 'DisplayVersion', Ver);
end;

procedure CurPageChanged(CurPageID: Integer);
var
  Action: String;
begin
  if Mode = 'update' then Action := 'Update' else if Mode = 'repair' then Action := 'Repair' else Action := 'Install';
  if CurPageID = wpReady then begin
    WizardForm.PageNameLabel.Caption := Action + ' Script Injector';
    if Mode = 'update' then
      WizardForm.ReadyLabel.Caption := 'Installed: v' + InstalledVer + #13#10 + 'New: ' + VerText(LatestVer) + #13#10#13#10 +
        'Click Update to download and install it. Your settings and scripts are kept.'
    else if Mode = 'repair' then
      WizardForm.ReadyLabel.Caption := 'Installed: v' + InstalledVer + ' (up to date)' + #13#10#13#10 +
        'Click Repair to download and reinstall it. Your settings and scripts are kept.'
    else
      WizardForm.ReadyLabel.Caption := 'Script Injector ' + VerText(LatestVer) + ' will be downloaded from GitHub and installed to:' + #13#10 +
        ExpandConstant('{app}') + #13#10#13#10 + 'Click Install to continue.';
    WizardForm.ReadyMemo.Visible := False;
    WizardForm.NextButton.Caption := Action;
    Exit;
  end;
  if CurPageID = wpInstalling then begin
    WizardForm.PageNameLabel.Caption := 'Installing Script Injector ' + VerText(LatestVer);
    if Mode = 'update' then WizardForm.PageDescriptionLabel.Caption := 'Updating from v' + InstalledVer + ' to ' + VerText(LatestVer) + '...'
    else WizardForm.PageDescriptionLabel.Caption := 'Please wait while ' + VerText(LatestVer) + ' is installed.';
    Exit;
  end;
  if CurPageID <> wpFinished then Exit;
  if WasInstalled then
    WizardForm.FinishedLabel.Caption := 'Script Injector v' + ManifestVersion(ExpandConstant('{app}')) + ' is installed.' + #13#10#13#10 +
      'In Chrome, open the extension popup and press "Reload extension" (or the reload icon on its card in chrome://extensions).'
  else
    WizardForm.FinishedLabel.Caption := 'Almost done. Finish in Chrome:' + #13#10#13#10 +
      '1. Turn on "Developer mode" (top right of chrome://extensions)' + #13#10 +
      '2. Click "Load unpacked"' + #13#10 +
      '3. Paste the folder path (already copied: Ctrl+V), press Enter, then "Select Folder"' + #13#10 +
      '4. On the extension''s Details page, turn on "Allow User Scripts"' + #13#10#13#10 +
      'Folder: ' + ExpandConstant('{app}');
end;

procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
begin
  if CurUninstallStep = usPostUninstall then
    SuppressibleMsgBox('Script Injector files were removed.' + #13#10#13#10 +
      'Also remove it from Chrome: open chrome://extensions and click "Remove" on its card.', mbInformation, MB_OK, IDOK);
end;
