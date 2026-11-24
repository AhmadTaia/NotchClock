# Bluetooth headphones battery (dot-sourced by media.ps1).
# Most headphones report a single battery level to Windows over the hands-free profile; we read it
# from the device's Windows properties. Add models to $HeadphoneModels to recognise more.

$HeadphoneModels = @(
    @{ id = 'bowie-d05'; name = 'Baseus Bowie D05'; match = '(?i)bowie\s*d05|baseus.*d05' }
)
$HeadphoneListRefreshSec = 120  # how often to re-scan paired devices (slow call)
$HeadphoneStatusRefreshSec = 10 # how often to read connection + battery (fast)
$KeyIsConnected = '{83DA6326-97A6-4088-9453-A1923F573B29} 15'
$KeyBattery = '{104EA319-6EE2-4701-BD47-8DDBF425BBE5} 2'

$script:Phones = @{
    devices = @(); listedAt = [datetime]::MinValue; checkedAt = [datetime]::MinValue
    state = @{ connected = $false }
}

function Update-HeadphoneList {
    $found = @()
    foreach ($dev in @(Get-PnpDevice -Class Bluetooth -ErrorAction SilentlyContinue)) {
        foreach ($model in $HeadphoneModels) {
            if ($dev.FriendlyName -match $model.match) { $found += @{ instanceId = $dev.InstanceId; model = $model } }
        }
    }
    $script:Phones.devices = $found
    $script:Phones.listedAt = Get-Date
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
            $battery = (Get-PnpDeviceProperty -InstanceId $d.instanceId -KeyName $KeyBattery -ErrorAction SilentlyContinue).Data
            $state = @{ connected = $true; id = $d.model.id; name = $d.model.name; battery = $(if ($null -ne $battery) { [int]$battery } else { -1 }) }
            break
        }
        $p.state = $state
    }
    catch {
        [Console]::Error.WriteLine("headphones: $($_.Exception.Message)")
    }
    return $p.state
}
