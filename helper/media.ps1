# NotchClock media helper.
# Reads the current Windows media session (whatever shows in the volume flyout: Spotify,
# YouTube in a browser, VLC, ...) and prints one JSON line per update to stdout.
# Accepts commands on stdin, one per line: toggle | next | prev
# Exits when stdin closes, so it never outlives the app.

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

Add-Type -AssemblyName System.Runtime.WindowsRuntime
$null = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager, Windows.Media.Control, ContentType = WindowsRuntime]
$null = [Windows.Storage.Streams.IRandomAccessStreamWithContentType, Windows.Storage.Streams, ContentType = WindowsRuntime]
$null = [Windows.Storage.Streams.DataReader, Windows.Storage.Streams, ContentType = WindowsRuntime]

$null = [Windows.System.Power.PowerManager, Windows.System.Power, ContentType = WindowsRuntime]

# GetSystemPowerStatus's saver flag also covers Windows 11 Energy Saver while plugged in,
# which the WinRT EnergySaverStatus property can report as "Disabled".
Add-Type -Namespace NotchClock -Name Power -MemberDefinition @'
[StructLayout(LayoutKind.Sequential)]
public struct SYSTEM_POWER_STATUS { public byte ACLineStatus; public byte BatteryFlag; public byte BatteryLifePercent; public byte SystemStatusFlag; public int BatteryLifeTime; public int BatteryFullLifeTime; }
[DllImport("kernel32.dll")]
public static extern bool GetSystemPowerStatus(out SYSTEM_POWER_STATUS status);
[DllImport("kernel32.dll")]
public static extern bool SetProcessWorkingSetSize(IntPtr process, IntPtr min, IntPtr max);
'@

# Windows 11's Energy Saver (including on AC power) shows up as the "effective power mode".
# Windows pushes changes to the callback, so reading [Epm]::Mode costs nothing.
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class Epm {
    public delegate void Callback(int mode, IntPtr context);
    [DllImport("powrprof.dll")]
    static extern int PowerRegisterForEffectivePowerModeNotifications(uint version, Callback cb, IntPtr context, out IntPtr handle);
    static Callback keep;
    static IntPtr handle;
    public static volatile int Mode = -1;
    public static int Start() { keep = (m, c) => { Mode = m; }; return PowerRegisterForEffectivePowerModeNotifications(2, keep, IntPtr.Zero, out handle); }
}
'@
# 0 = Energy/Battery Saver, 1 = "Better battery" (what many laptops switch to when Energy Saver
# is turned on). Both count as saving power.
$EffectiveModeMaxSaving = 1
try { $null = [Epm]::Start() } catch { [Console]::Error.WriteLine("effective-power-mode: $($_.Exception.Message)") }

$BatteryFlagNoBattery = 128
$BatteryFlagUnknown = 255

# Whether this PC has a battery at all (desktops don't), straight from Windows.
function Get-HasBattery {
    try {
        $status = New-Object NotchClock.Power+SYSTEM_POWER_STATUS
        if (-not [NotchClock.Power]::GetSystemPowerStatus([ref]$status)) { return $true }
        return ($status.BatteryFlag -ne $BatteryFlagNoBattery) -and ($status.BatteryFlag -ne $BatteryFlagUnknown)
    }
    catch { return $true }
}

function Get-EnergySaver {
    try {
        $mode = [Epm]::Mode
        if ($mode -ge 0 -and $mode -le $EffectiveModeMaxSaving) { return $true }
        if ([Windows.System.Power.PowerManager]::EnergySaverStatus.ToString() -eq 'On') { return $true }
        $status = New-Object NotchClock.Power+SYSTEM_POWER_STATUS
        if ([NotchClock.Power]::GetSystemPowerStatus([ref]$status)) { return $status.SystemStatusFlag -eq 1 }
    }
    catch { [Console]::Error.WriteLine("energy-saver: $($_.Exception.Message)") }
    return $false
}

$asTaskMethod =[System.WindowsRuntimeSystemExtensions].GetMethods() |
    Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1' } |
    Select-Object -First 1

$AwaitTimeoutMs = 3000
$TickMs = 250
$TicksPerStatus = 4
$MaxArtBytes = 3MB

function Await($operation, [Type]$resultType) {
    $task = $asTaskMethod.MakeGenericMethod($resultType).Invoke($null, @($operation))
    if (-not $task.Wait($AwaitTimeoutMs)) { throw 'WinRT call timed out' }
    return $task.Result
}

function Read-Art($thumbnail) {
    if ($null -eq $thumbnail) { return $null }
    $stream = Await ($thumbnail.OpenReadAsync()) ([Windows.Storage.Streams.IRandomAccessStreamWithContentType])
    # PowerShell hides properties inherited from WinRT interfaces, so read them via the interface types.
    $size = [uint32][Windows.Storage.Streams.IRandomAccessStream].GetProperty('Size').GetValue($stream)
    if ($size -eq 0 -or $size -gt $MaxArtBytes) { return $null }
    $type = [string][Windows.Storage.Streams.IContentTypeProvider].GetProperty('ContentType').GetValue($stream)
    if (-not $type) { $type = 'image/jpeg' }
    # DataReader works on the raw WinRT stream without needing .NET stream adapters.
    $inputStream = [Windows.Storage.Streams.IRandomAccessStream].GetMethod('GetInputStreamAt').Invoke($stream, @([uint64]0))
    $reader = [Windows.Storage.Streams.DataReader].GetConstructor(@([Windows.Storage.Streams.IInputStream])).Invoke(@($inputStream))
    $null = Await ($reader.LoadAsync($size)) ([uint32])
    $bytes = New-Object byte[] $size
    $reader.ReadBytes($bytes)
    return "data:$type;base64," + [Convert]::ToBase64String($bytes)
}

$MaxWindowTitles = 12
$ProcRefreshEvery = 5  # status updates between process lookups
$script:procInfo = @{ exePath = ''; windows = @() }
$script:procSource = $null
$script:procAge = 0

# Finds the process behind a media session's app id ("Spotify.exe", "Chrome", "MSEdge", ...)
# so the app can show its real icon and, for browsers, which site is open.
function Get-SourceProcessInfo([string]$appId) {
    $info = @{ exePath = ''; windows = @() }
    if (-not $appId -or $appId.Contains('!')) { return $info }  # Store apps: no plain exe to look up
    $name = [System.IO.Path]::GetFileNameWithoutExtension($appId.Split('\')[-1])
    if (-not $name) { return $info }
    $procs = @(Get-Process -Name $name -ErrorAction SilentlyContinue)
    $withPath = $procs | Where-Object { $_.Path } | Select-Object -First 1
    if ($withPath) { $info.exePath = [string]$withPath.Path }
    $info.windows = @($procs | Where-Object { $_.MainWindowTitle } |
        Select-Object -First $MaxWindowTitles | ForEach-Object { $t = [string]$_.MainWindowTitle; $t.Substring(0, [Math]::Min(200, $t.Length)) })
    return $info
}

. "$PSScriptRoot\buds.ps1"   # Galaxy Buds battery (Step-Buds / Get-BudsState)
. "$PSScriptRoot\headphones.ps1"   # other Bluetooth headphones (Get-HeadphonesState)

$manager = Await ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager]::RequestAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager])
$script:lastKey = $null

function Get-State {
    $session = $manager.GetCurrentSession()
    if ($null -eq $session) {
        $script:lastKey = $null
        return @{ has = $false }
    }

    $props = Await ($session.TryGetMediaPropertiesAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties])
    $playback = $session.GetPlaybackInfo()
    $timeline = $session.GetTimelineProperties()
    $playing = ($playback.PlaybackStatus.ToString() -eq 'Playing')

    $duration = ($timeline.EndTime - $timeline.StartTime).TotalSeconds
    $position = $timeline.Position.TotalSeconds
    if ($playing -and $duration -gt 0) {
        # Apps report position only occasionally; extrapolate from the last report.
        $position += ([DateTimeOffset]::Now - $timeline.LastUpdatedTime).TotalSeconds
    }
    if ($duration -le 0) { $duration = 0; $position = 0 }
    $position = [Math]::Max(0, [Math]::Min($position, $duration))

    $state = @{
        has     = $true
        playing = $playing
        title   = [string]$props.Title
        artist  = [string]$props.Artist
        album   = [string]$props.AlbumTitle
        source  = [string]$session.SourceAppUserModelId
        pos     = [Math]::Round($position, 1)
        dur     = [Math]::Round($duration, 1)
    }

    $script:procAge++
    if ($state.source -ne $script:procSource -or $script:procAge -ge $ProcRefreshEvery) {
        $script:procInfo = Get-SourceProcessInfo $state.source
        $script:procSource = $state.source
        $script:procAge = 0
    }
    $state.exePath = $script:procInfo.exePath
    $state.windows = $script:procInfo.windows

    $key = "$($state.source)|$($state.title)|$($state.artist)"
    if ($key -ne $script:lastKey) {
        $script:lastKey = $key
        $state.artChanged = $true
        try { $state.art = Read-Art $props.Thumbnail }
        catch { [Console]::Error.WriteLine("art: $($_.Exception.Message)") }
    }
    return $state
}

function Send-MediaCommand([string]$command) {
    $session = $manager.GetCurrentSession()
    if ($null -eq $session) { return }
    if ($command -match '^seek (\d{1,6}(\.\d+)?)$') {
        # Position is in 100ns ticks, measured from the timeline start.
        $ticks = [int64]([double]$Matches[1] * 10000000)
        $null = Await ($session.TryChangePlaybackPositionAsync($ticks)) ([bool])
        return
    }
    switch ($command) {
        'toggle' { $null = Await ($session.TryTogglePlayPauseAsync()) ([bool]) }
        'next'   { $null = Await ($session.TrySkipNextAsync()) ([bool]) }
        'prev'   { $null = Await ($session.TrySkipPreviousAsync()) ([bool]) }
    }
}

function Write-State {
    try {
        $state = Get-State
        $state.saver = Get-EnergySaver
        $state.hasBattery = Get-HasBattery
        $state.buds = Get-BudsState
        $state.headphones = Get-HeadphonesState
        $json = $state | ConvertTo-Json -Compress
    }
    catch {
        [Console]::Error.WriteLine("state: $($_.Exception.Message)")
        $script:lastKey = $null
        $json = '{"has":false}'
    }
    [Console]::Out.WriteLine($json)
    [Console]::Out.Flush()
}

# StreamReader over the raw stdin stream gives a truly non-blocking ReadLineAsync.
$MemoryTrimTicks = 240  # about once a minute

# PowerShell keeps memory it no longer needs (old album art, JSON strings, device queries).
# Hand it back to Windows periodically so the always-on helper stays small.
function Clear-HelperMemory {
    [System.GC]::Collect()
    [System.GC]::WaitForPendingFinalizers()
    $self = [System.Diagnostics.Process]::GetCurrentProcess()
    $null = [NotchClock.Power]::SetProcessWorkingSetSize($self.Handle, [IntPtr](-1), [IntPtr](-1))
}

$stdin = New-Object System.IO.StreamReader([Console]::OpenStandardInput())
$pendingLine = $stdin.ReadLineAsync()
$tick = 0

while ($true) {
    $forceStatus = $false
    Step-Buds
    if ($pendingLine.IsCompleted) {
        $line = $pendingLine.Result
        if ($null -eq $line) { exit 0 }  # parent closed the pipe
        try { Send-MediaCommand $line.Trim() }
        catch { [Console]::Error.WriteLine("command: $($_.Exception.Message)") }
        $pendingLine = $stdin.ReadLineAsync()
        $forceStatus = $true
        Start-Sleep -Milliseconds 120  # let the player apply the change before re-reading
    }

    if ($forceStatus -or ($tick % $TicksPerStatus -eq 0)) { Write-State }
    Start-Sleep -Milliseconds $TickMs
    $tick++
    if ($tick % $MemoryTrimTicks -eq 0) { Clear-HelperMemory }
}
