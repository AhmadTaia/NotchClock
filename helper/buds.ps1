# Galaxy Buds battery reader, dot-sourced by media.ps1.
# Talks to the buds over Samsung's own Bluetooth channel (the one Galaxy Wearable uses) and decodes
# their status messages: left / right / case battery and whether each bud is worn or in the case.
# Everything is non-blocking: Step-Buds is called on every helper tick and never waits.

$null = [Windows.Devices.Enumeration.DeviceInformation, Windows.Devices.Enumeration, ContentType = WindowsRuntime]
$null = [Windows.Devices.Bluetooth.Rfcomm.RfcommDeviceService, Windows.Devices.Bluetooth, ContentType = WindowsRuntime]
$null = [Windows.Networking.Sockets.StreamSocket, Windows.Networking.Sockets, ContentType = WindowsRuntime]

$BudsServiceUuid = '2e73a4ad-332d-41fc-90e2-16bef06523f2'  # Galaxy Buds2 / Pro / Buds3 series
$BudsRetryIdleSec = 20        # how often to look for the buds when not connected
$BudsRetryAfterDropSec = 5
$BudsConnectTimeoutSec = 15
$BudsReadChunk = 512
$MsgStatusUpdated = 0x60
$MsgExtendedStatusUpdated = 0x61
$PacketStart = 0xFD
$PacketEnd = 0xDD

$asTaskAction = [System.WindowsRuntimeSystemExtensions].GetMethods() |
    Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncAction' } |
    Select-Object -First 1

$script:Buds = @{
    phase = 'idle'; nextTry = [datetime]::MinValue; started = [datetime]::MinValue
    socket = $null; reader = $null; connectTask = $null; loadTask = $null
    buffer = New-Object System.Collections.Generic.List[byte]
    name = 'Galaxy Buds'; left = -1; right = -1; case = -1; wearLeft = 0; wearRight = 0; connected = $false
}

function Start-TaskForOperation($operation, [Type]$resultType) {
    return $asTaskMethod.MakeGenericMethod($resultType).Invoke($null, @($operation))
}

function Reset-BudsConnection([int]$retrySeconds) {
    $b = $script:Buds
    if ($b.socket) { try { $b.socket.Dispose() } catch { } }
    $b.socket = $null; $b.reader = $null; $b.connectTask = $null; $b.loadTask = $null
    $b.buffer.Clear()
    $b.connected = $false
    $b.phase = 'idle'
    $b.nextTry = (Get-Date).AddSeconds($retrySeconds)
}

function Start-BudsConnect {
    $b = $script:Buds
    $sid = [Windows.Devices.Bluetooth.Rfcomm.RfcommServiceId]::FromUuid([guid]$BudsServiceUuid)
    $selector = [Windows.Devices.Bluetooth.Rfcomm.RfcommDeviceService]::GetDeviceSelector($sid)
    $found = Await ([Windows.Devices.Enumeration.DeviceInformation]::FindAllAsync($selector)) ([Windows.Devices.Enumeration.DeviceInformationCollection])
    if ($found.Count -eq 0) { Reset-BudsConnection $BudsRetryIdleSec; return }

    $service = Await ([Windows.Devices.Bluetooth.Rfcomm.RfcommDeviceService]::FromIdAsync($found[0].Id)) ([Windows.Devices.Bluetooth.Rfcomm.RfcommDeviceService])
    if (-not $service) { Reset-BudsConnection $BudsRetryIdleSec; return }
    # Only try when Windows says the buds are actually connected, so we never wake them up.
    $device = $service.Device
    if ($device) {
        if ($device.ConnectionStatus.ToString() -ne 'Connected') { Reset-BudsConnection $BudsRetryIdleSec; return }
        if ($device.Name) { $b.name = [string]$device.Name }
    }

    $b.socket = New-Object Windows.Networking.Sockets.StreamSocket
    $b.connectTask = $asTaskAction.Invoke($null, @($b.socket.ConnectAsync($service.ConnectionHostName, $service.ConnectionServiceName)))
    $b.started = Get-Date
    $b.phase = 'connecting'
}

function Start-BudsRead {
    $b = $script:Buds
    $b.loadTask = Start-TaskForOperation ($b.reader.LoadAsync($BudsReadChunk)) ([uint32])
}

function Read-BudsPackets {
    # Packet: FD | size (2 bytes, little endian, low 10 bits) | id | payload | crc (2) | DD
    $b = $script:Buds
    $buf = $b.buffer
    while ($buf.Count -ge 4) {
        if ($buf[0] -ne $PacketStart) { $buf.RemoveAt(0); continue }
        $size = ($buf[1] -bor ($buf[2] -shl 8)) -band 0x3FF
        $total = $size + 4
        if ($size -lt 3) { $buf.RemoveAt(0); continue }
        if ($buf.Count -lt $total) { return }
        if ($buf[$total - 1] -ne $PacketEnd) { $buf.RemoveAt(0); continue }

        $id = $buf[3]
        $payload = $buf.GetRange(4, $size - 3).ToArray()
        $buf.RemoveRange(0, $total)

        if ($id -eq $MsgExtendedStatusUpdated -and $payload.Length -ge 8) {
            Set-BudsStatus $payload[2] $payload[3] $payload[6] $payload[7]
        }
        elseif ($id -eq $MsgStatusUpdated -and $payload.Length -ge 7) {
            Set-BudsStatus $payload[1] $payload[2] $payload[5] $payload[6]
        }
    }
}

function Set-BudsStatus([int]$left, [int]$right, [int]$placement, [int]$case) {
    $b = $script:Buds
    $b.left = $left; $b.right = $right; $b.case = $case
    $b.wearLeft = ($placement -shr 4) -band 0xF   # 0 disconnected, 1 worn, 2 out, 3 in case
    $b.wearRight = $placement -band 0xF
}

function Step-Buds {
    $b = $script:Buds
    try {
        switch ($b.phase) {
            'idle' {
                if ((Get-Date) -ge $b.nextTry) { Start-BudsConnect }
            }
            'connecting' {
                if ($b.connectTask.IsCompleted) {
                    if ($b.connectTask.IsFaulted -or $b.connectTask.IsCanceled) { Reset-BudsConnection $BudsRetryIdleSec; return }
                    $inStream = $b.socket.InputStream
                    $b.reader = [Windows.Storage.Streams.DataReader].GetConstructor(@([Windows.Storage.Streams.IInputStream])).Invoke(@($inStream))
                    $b.reader.InputStreamOptions = [Windows.Storage.Streams.InputStreamOptions]::Partial
                    $b.connected = $true
                    $b.phase = 'connected'
                    Start-BudsRead
                }
                elseif (((Get-Date) - $b.started).TotalSeconds -gt $BudsConnectTimeoutSec) {
                    Reset-BudsConnection $BudsRetryIdleSec
                }
            }
            'connected' {
                if (-not $b.loadTask.IsCompleted) { return }
                if ($b.loadTask.IsFaulted -or $b.loadTask.IsCanceled -or $b.loadTask.Result -eq 0) {
                    Reset-BudsConnection $BudsRetryAfterDropSec  # buds turned off / went out of range
                    return
                }
                $count = [int]$b.loadTask.Result
                $bytes = New-Object byte[] $count
                $b.reader.ReadBytes($bytes)
                $b.buffer.AddRange($bytes)
                Read-BudsPackets
                Start-BudsRead
            }
        }
    }
    catch {
        [Console]::Error.WriteLine("buds: $($_.Exception.Message)")
        Reset-BudsConnection $BudsRetryIdleSec
    }
}

function Get-BudsState {
    $b = $script:Buds
    if (-not $b.connected -or $b.left -lt 0) { return @{ connected = $false } }
    return @{
        connected = $true; name = $b.name
        left = $b.left; right = $b.right; case = $b.case
        wearLeft = $b.wearLeft; wearRight = $b.wearRight
    }
}
