param(
  [switch]$DryRun,
  [switch]$ForceRestart,
  [switch]$InstallStartup,
  [switch]$UninstallStartup
)

$ErrorActionPreference = 'Stop'

if ($InstallStartup -and $UninstallStartup) {
  throw 'Use either -InstallStartup or -UninstallStartup, not both.'
}

function Get-StartupShortcutPath {
  Join-Path ([Environment]::GetFolderPath('Startup')) 'Codex Deck.lnk'
}

function Get-WatcherStopPath {
  Join-Path (Join-Path $env:LOCALAPPDATA 'CodexDeck') 'watcher.stop'
}

function Get-InstalledLauncherRoot {
  Join-Path (Join-Path $env:LOCALAPPDATA 'CodexDeck') 'launcher'
}

function Request-WatcherStop {
  $stopPath = Get-WatcherStopPath
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $stopPath) | Out-Null
  [IO.File]::WriteAllText($stopPath, [DateTimeOffset]::UtcNow.ToString('o'), [Text.UTF8Encoding]::new($false))
  Start-Sleep -Seconds 3
}

function Install-WatcherBundle {
  $destinationRoot = Get-InstalledLauncherRoot
  $sourceRoot = [IO.Path]::GetFullPath($PSScriptRoot).TrimEnd('\')
  if ($sourceRoot.Equals([IO.Path]::GetFullPath($destinationRoot).TrimEnd('\'), [StringComparison]::OrdinalIgnoreCase)) {
    return $destinationRoot
  }

  $runtimeSource = Join-Path $sourceRoot 'runtime-override.mjs'
  if (-not (Test-Path -LiteralPath $runtimeSource)) {
    $runtimeSource = Join-Path $sourceRoot '..\release\codex-deck-launcher\runtime-override.mjs'
  }
  $wsSource = Join-Path $sourceRoot 'node_modules\ws'
  if (-not (Test-Path -LiteralPath $wsSource)) { $wsSource = Join-Path $sourceRoot '..\node_modules\ws' }
  foreach ($required in @(
    (Join-Path $sourceRoot 'Start-CodexDeck.ps1'),
    (Join-Path $sourceRoot 'Watch-CodexDeck.ps1'),
    (Join-Path $sourceRoot 'Configure-CodexDeckRelay.ps1'),
    (Join-Path $sourceRoot 'Configure-CodexDeckMobile.ps1'),
    (Join-Path $sourceRoot 'mobile-pairing.mjs'),
    $runtimeSource,
    $wsSource
  )) {
    if (-not (Test-Path -LiteralPath $required)) { throw "Required launcher component not found: $required" }
  }

  New-Item -ItemType Directory -Force -Path (Join-Path $destinationRoot 'node_modules') | Out-Null
  foreach ($filename in @('Start-CodexDeck.ps1', 'Watch-CodexDeck.ps1', 'Configure-CodexDeckRelay.ps1', 'Configure-CodexDeckMobile.ps1', 'mobile-pairing.mjs', 'README.txt')) {
    $source = Join-Path $sourceRoot $filename
    if (Test-Path -LiteralPath $source) { Copy-Item -LiteralPath $source -Destination (Join-Path $destinationRoot $filename) -Force }
  }
  Copy-Item -LiteralPath $runtimeSource -Destination (Join-Path $destinationRoot 'runtime-override.mjs') -Force
  $wsDestination = Join-Path $destinationRoot 'node_modules\ws'
  Remove-Item -LiteralPath $wsDestination -Recurse -Force -ErrorAction SilentlyContinue
  Copy-Item -LiteralPath $wsSource -Destination $wsDestination -Recurse -Force
  return $destinationRoot
}

function Start-BridgeWatcher([string]$LauncherRoot = $PSScriptRoot) {
  $watcherPath = Join-Path $LauncherRoot 'Watch-CodexDeck.ps1'
  if (-not (Test-Path -LiteralPath $watcherPath)) { throw "Codex Deck watcher not found: $watcherPath" }
  $powerShellPath = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
  Start-Process -FilePath $powerShellPath -WindowStyle Hidden -ArgumentList @(
    '-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', "`"$watcherPath`""
  )
}

function Set-StartupShortcut {
  Request-WatcherStop
  $launcherRoot = Install-WatcherBundle
  $shortcutPath = Get-StartupShortcutPath
  $watcherPath = Join-Path $launcherRoot 'Watch-CodexDeck.ps1'
  if (-not (Test-Path -LiteralPath $watcherPath)) { throw "Codex Deck watcher not found: $watcherPath" }
  $stopPath = Get-WatcherStopPath
  Remove-Item -LiteralPath $stopPath -Force -ErrorAction SilentlyContinue
  $shell = New-Object -ComObject WScript.Shell
  $shortcut = $shell.CreateShortcut($shortcutPath)
  $shortcut.TargetPath = (Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe')
  $shortcut.Arguments = "-NoLogo -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$watcherPath`" -RecoverExistingSession"
  $shortcut.WorkingDirectory = $launcherRoot
  $shortcut.Description = 'Keep the Codex Deck bridge available while Codex is running'
  $shortcut.IconLocation = "$env:SystemRoot\System32\shell32.dll,44"
  $shortcut.Save()
  Start-BridgeWatcher $launcherRoot
  Write-Host "Startup shortcut installed: $shortcutPath"
  Write-Host "Durable launcher installed: $launcherRoot"
  Write-Host 'The background watcher is running. An existing normal Codex session was not restarted.'
}

if ($InstallStartup) {
  Set-StartupShortcut
  exit 0
}

if ($UninstallStartup) {
  $shortcutPath = Get-StartupShortcutPath
  Request-WatcherStop
  if (Test-Path -LiteralPath $shortcutPath) {
    Remove-Item -LiteralPath $shortcutPath -Force
    Write-Host "Startup shortcut removed: $shortcutPath"
  } else {
    Write-Host 'No Codex Deck startup shortcut was installed.'
  }
  $installedRoot = Get-InstalledLauncherRoot
  if (Test-Path -LiteralPath $installedRoot) {
    Remove-Item -LiteralPath $installedRoot -Recurse -Force
    Write-Host "Durable launcher removed: $installedRoot"
  }
  exit 0
}

function Get-CodexInstallation {
  $package = Get-AppxPackage -Name 'OpenAI.Codex' -ErrorAction SilentlyContinue |
    Sort-Object Version -Descending |
    Select-Object -First 1
  if ($null -eq $package -or [string]::IsNullOrWhiteSpace($package.InstallLocation)) {
    throw 'The OpenAI Codex Windows app is not installed.'
  }
  $appRoot = Join-Path $package.InstallLocation 'app'
  $executable = Join-Path $appRoot 'ChatGPT.exe'
  if (-not (Test-Path -LiteralPath $executable)) { throw "Codex executable not found: $executable" }

  $manifest = Get-AppxPackageManifest -Package $package.PackageFullName
  $application = @($manifest.Package.Applications.Application) | Select-Object -First 1
  if ($null -eq $application -or [string]::IsNullOrWhiteSpace($application.Id)) {
    throw 'The OpenAI Codex package does not expose an application ID.'
  }
  $aumid = "$($package.PackageFamilyName)!$($application.Id)"

  [pscustomobject]@{
    Root = [IO.Path]::GetFullPath($appRoot).TrimEnd('\')
    Executable = $executable
    Version = $package.Version.ToString()
    Aumid = $aumid
  }
}

function Start-CodexPackage([string]$Aumid, [int]$Port) {
  if (-not ('CodexDeckActivation.Activator' -as [type])) {
    Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;

namespace CodexDeckActivation
{
    [Flags]
    public enum ActivateOptions
    {
        None = 0,
        DesignMode = 1,
        NoErrorUI = 2,
        NoSplashScreen = 4
    }

    [ComImport]
    [Guid("2E941141-7F97-4756-BA1D-9DECDE894A3D")]
    [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    public interface IApplicationActivationManager
    {
        [PreserveSig]
        int ActivateApplication(
            [MarshalAs(UnmanagedType.LPWStr)] string appUserModelId,
            [MarshalAs(UnmanagedType.LPWStr)] string arguments,
            ActivateOptions options,
            out uint processId
        );
    }

    [ComImport]
    [Guid("45BA127D-10A8-46EA-8AB7-56EA9078943C")]
    public class ApplicationActivationManager
    {
    }

    public static class Activator
    {
        public static uint Launch(string aumid, string arguments)
        {
            var manager =
                (IApplicationActivationManager)new ApplicationActivationManager();

            uint processId;
            int hr = manager.ActivateApplication(
                aumid,
                arguments,
                ActivateOptions.None,
                out processId
            );

            if (hr < 0)
                Marshal.ThrowExceptionForHR(hr);

            return processId;
        }
    }
}
"@
  }

  $arguments = "--remote-debugging-address=127.0.0.1 --remote-debugging-port=$Port"
  [CodexDeckActivation.Activator]::Launch($Aumid, $arguments)
}

function Get-CodexProcesses([string]$AppRoot) {
  $prefix = $AppRoot.TrimEnd('\') + '\'
  @(Get-CimInstance Win32_Process -ErrorAction Stop | Where-Object {
    -not [string]::IsNullOrWhiteSpace($_.ExecutablePath) -and
    $_.ExecutablePath.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)
  })
}

function Get-HealthyDebugPort($Processes) {
  foreach ($process in $Processes) {
    if ([string]::IsNullOrWhiteSpace($process.CommandLine)) { continue }
    if ($process.CommandLine -match '--remote-debugging-port=(\d+)') {
      $candidate = [int]$Matches[1]
      try {
        $response = Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:$candidate/json/version" -TimeoutSec 1
        if ($response.StatusCode -ge 200 -and $response.StatusCode -lt 300) { return $candidate }
      }
      catch { }
    }
  }
  return $null
}

$node = Get-Command node -ErrorAction SilentlyContinue
if ($null -eq $node) { throw 'Node.js 20 or newer is required. Install it from https://nodejs.org/ and try again.' }
$major = [int]((& $node.Source --version).TrimStart('v').Split('.')[0])
if ($major -lt 20) { throw "Node.js 20 or newer is required. Found: $(& $node.Source --version)" }

$codex = Get-CodexInstallation
$processes = Get-CodexProcesses $codex.Root
$existingPort = Get-HealthyDebugPort $processes
if ($DryRun) {
  Write-Host "Codex version: $($codex.Version)"
  Write-Host "Executable: $($codex.Executable)"
  Write-Host "AUMID: $($codex.Aumid)"
  Write-Host "Node: $(& $node.Source --version)"
  if ($existingPort) { Write-Host "Reusable debug port: $existingPort" }
  elseif ($processes.Count -gt 0) { Write-Host 'Codex is running without a reusable debug bridge; a restart is required.' }
  else { Write-Host 'Codex is not running; the launcher will start it.' }
  exit 0
}

$port = $existingPort
if ($ForceRestart -or -not $port) {
  if ($processes.Count -gt 0) {
  Write-Host "Closing $($processes.Count) Codex process(es)..."
  foreach ($process in ($processes | Sort-Object ParentProcessId -Descending)) {
    Stop-Process -Id $process.ProcessId -Force -ErrorAction SilentlyContinue
  }
  $deadline = (Get-Date).AddSeconds(10)
  do { Start-Sleep -Milliseconds 250; $remaining = Get-CodexProcesses $codex.Root }
  while ($remaining.Count -gt 0 -and (Get-Date) -lt $deadline)
  if ($remaining.Count -gt 0) { throw 'Some Codex background processes could not be closed.' }
  }

  $listener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, 0)
  $listener.Start()
  $port = ([Net.IPEndPoint]$listener.LocalEndpoint).Port
  $listener.Stop()
}

if ($existingPort -and -not $ForceRestart) {
  Write-Host "Reusing the existing Codex session on loopback port $port..."
}
else {
  Write-Host "Starting Codex $($codex.Version) with a loopback-only bridge on port $port..."
  $launchedPid = Start-CodexPackage $codex.Aumid $port
  Write-Host "Codex package activated as PID $launchedPid."
}

$stateRoot = Join-Path $env:LOCALAPPDATA 'CodexDeck'
$statePath = Join-Path $stateRoot 'codex-micro-bridge.json'
New-Item -ItemType Directory -Force -Path $stateRoot | Out-Null
[IO.File]::WriteAllText(
  $statePath,
  (@{ port = $port; updatedAt = [DateTimeOffset]::UtcNow.ToString('o') } | ConvertTo-Json -Compress),
  [Text.UTF8Encoding]::new($false)
)

$runtimeScript = Join-Path $PSScriptRoot 'runtime-override.mjs'
if (-not (Test-Path -LiteralPath $runtimeScript)) {
  $runtimeScript = Join-Path $PSScriptRoot '..\release\codex-deck-launcher\runtime-override.mjs'
}
if (-not (Test-Path -LiteralPath $runtimeScript)) {
  throw 'The bundled runtime-override.mjs is missing. Run npm run build or use the extracted release launcher folder.'
}

& $node.Source $runtimeScript $port
if ($LASTEXITCODE -ne 0) { throw 'The Codex Micro runtime could not be enabled.' }

Write-Host 'Codex Deck is ready. Keep this Codex session open while using Stream Deck.'
