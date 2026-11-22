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

$asTaskMethod = [System.WindowsRuntimeSystemExtensions].GetMethods() |
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

    $procInfo = Get-SourceProcessInfo $state.source
    $state.exePath = $procInfo.exePath
    $state.windows = $procInfo.windows

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
    try { $json = (Get-State) | ConvertTo-Json -Compress }
    catch {
        [Console]::Error.WriteLine("state: $($_.Exception.Message)")
        $script:lastKey = $null
        $json = '{"has":false}'
    }
    [Console]::Out.WriteLine($json)
    [Console]::Out.Flush()
}

# StreamReader over the raw stdin stream gives a truly non-blocking ReadLineAsync.
$stdin = New-Object System.IO.StreamReader([Console]::OpenStandardInput())
$pendingLine = $stdin.ReadLineAsync()
$tick = 0

while ($true) {
    $forceStatus = $false
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
}
