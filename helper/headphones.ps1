# Bluetooth headphones battery (dot-sourced by media.ps1).
# Most headphones report a single battery level to Windows over the hands-free profile; we read it
# from the device's Windows properties. Add models to $HeadphoneModels to recognise more.

$HeadphoneModels = @(
    @{ id = 'bowie-d05'; name = 'Baseus Bowie D05'; match = '(?i)bowie\s*d05|baseus.*d05' }
)
$HeadphoneListRefreshSec = 30   # how often to re-scan paired devices for newly paired headphones
$HeadphoneStatusRefreshSec = 2  # how often to check the Bluetooth link (fast)
$HeadphoneBatteryRefreshSec = 30 # battery changes slowly; read it less often
$HeadphoneSystemRefreshSec = 300 # the System-class scan is slow; do it at most every 5 minutes
$KeyIsConnected = '{83DA6326-97A6-4088-9453-A1923F573B29} 15'
$KeyBattery = '{104EA319-6EE2-4701-BD47-8DDBF425BBE5} 2'

$script:Phones = @{
    devices = @(); listedAt = [datetime]::MinValue; checkedAt = [datetime]::MinValue
    state = @{ connected = $false }
    batteryAt = [datetime]::MinValue; battery = -1; linkedId = $null
    systemDevices = @(); systemListedAt = [datetime]::MinValue
}

function Find-ModelDevices($devices) {
    $found = @()
    foreach ($dev in @($devices)) {
        foreach ($model in $HeadphoneModels) {
            if ($dev.FriendlyName -match $model.match) { $found += @{ instanceId = $dev.InstanceId; model = $model } }
        }
    }
    return $found
}

function Update-HeadphoneList {
    $p = $script:Phones
    $now = Get-Date
    $found = @(Find-ModelDevices (Get-PnpDevice -Class Bluetooth -ErrorAction SilentlyContinue))
    # Windows often keeps the battery level on the "<name> Hands-Free AG" entry (System class).
    # That class is large, so only scan it when a known model is paired, and rarely.
    if ($found.Count -gt 0) {
        if (($now - $p.systemListedAt).TotalSeconds -ge $HeadphoneSystemRefreshSec) {
            $p.systemDevices = @(Find-ModelDevices (Get-PnpDevice -Class System -ErrorAction SilentlyContinue))
            $p.systemListedAt = $now
        }
        $found += $p.systemDevices
    }
    $p.devices = $found
    $p.listedAt = $now
}

function Get-ModelBattery([string]$modelId) {
    # Use whichever Windows entry for this headphone model actually carries a battery level.
    foreach ($d in $script:Phones.devices) {
        if ($d.model.id -ne $modelId) { continue }
        $value = (Get-PnpDeviceProperty -InstanceId $d.instanceId -KeyName $KeyBattery -ErrorAction SilentlyContinue).Data
        if ($null -ne $value) { return [int]$value }
    }
    return -1
}

function Get-HeadphonesState {
    $p = $script:Phones
    $now = Get-Date
    if (($now - $p.checkedAt).TotalSeconds -lt $HeadphoneStatusRefreshSec) { return $p.state }
    $p.checkedAt = $now
    try {
        if (($now - $p.listedAt).TotalSeconds -ge $HeadphoneListRefreshSec) { Update-HeadphoneList }
        $state = @{ connected = $false }
        foreach ($d in $p.devices) {
            $connected = (Get-PnpDeviceProperty -InstanceId $d.instanceId -KeyName $KeyIsConnected -ErrorAction SilentlyContinue).Data
            if ($connected -ne $true) { continue }
            $justLinked = $p.linkedId -ne $d.instanceId
            if ($justLinked -or ($now - $p.batteryAt).TotalSeconds -ge $HeadphoneBatteryRefreshSec) {
                $p.battery = Get-ModelBattery $d.model.id
                $p.batteryAt = $now
            }
            $p.linkedId = $d.instanceId
            $state = @{ connected = $true; linked = $true; id = $d.model.id; name = $d.model.name; battery = $p.battery }
            break
        }
        if (-not $state.connected) { $p.linkedId = $null }
        $p.state = $state
    }
    catch {
        [Console]::Error.WriteLine("headphones: $($_.Exception.Message)")
    }
    return $p.state
}
