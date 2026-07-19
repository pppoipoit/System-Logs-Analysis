$ErrorActionPreference = "Continue"
$WarningPreference = "SilentlyContinue"

# =============================================================================
# Metadata
# =============================================================================
$scriptVersion = "1.0.7"
$collectionStartTime = Get-Date

# =============================================================================
# Helper: Safe event collector with metadata
# =============================================================================
function Get-Events {
    param(
        [string]$LogName,
        [int[]]$Level,
        [int]$MaxEvents = 20,
        [DateTime]$StartTime = (Get-Date).AddDays(-7),
        [DateTime]$EndTime = (Get-Date),
        [switch]$IncludeWarningInfo
    )
    $meta = @{
        queryStart = $StartTime.ToString('o')
        queryEnd   = $EndTime.ToString('o')
        maxEvents  = $MaxEvents
        wasTruncated = $false
    }

    $eventsArray = @()
    try {
        $filter = @{ LogName=$LogName; StartTime=$StartTime; EndTime=$EndTime }
        if ($IncludeWarningInfo) {
            $filter.Level = @(1,2,3,4)
        } else {
            $filter.Level = $Level
        }

        $events = Get-WinEvent -FilterHashtable $filter -MaxEvents $MaxEvents -ErrorAction Stop
        if ($null -eq $events) { $events = @() }
        $meta.wasTruncated = $events.Count -ge $MaxEvents

        $eventsArray = @($events | Select-Object `
            @{Name='TimeCreated'; Expression={$_.TimeCreated.ToString('s')}},
            Id,
            ProviderName,
            LevelDisplayName,
            Message)
    } catch {
        return @{ events = @(); metadata = $meta; error = $_.Exception.Message }
    }

    return @{ events = $eventsArray; metadata = $meta; error = $null }
}

# =============================================================================
# Output + debug accumulators
# =============================================================================
$output = @{}
$debug = @()
$collectionMetadata = @{}

# =============================================================================
# 1. System Info
# =============================================================================
try {
    $os = $null; $cs = $null; $cpu = $null
    try {
        $os = Get-CimInstance Win32_OperatingSystem -ErrorAction Stop
    } catch {
        $debug += "CIM OS failed: $_"
        $os = Get-WmiObject Win32_OperatingSystem -ErrorAction Stop
    }
    try {
        $cs = Get-CimInstance Win32_ComputerSystem -ErrorAction Stop
    } catch {
        $debug += "CIM CS failed: $_"
        $cs = Get-WmiObject Win32_ComputerSystem -ErrorAction Stop
    }
    try {
        $cpu = Get-CimInstance Win32_Processor -ErrorAction Stop | Select-Object -First 1
    } catch {
        $debug += "CIM CPU failed: $_"
        $cpu = Get-WmiObject Win32_Processor -ErrorAction Stop | Select-Object -First 1
    }

    $ramTotal = if ($cs.TotalPhysicalMemory) { [math]::Round($cs.TotalPhysicalMemory / 1GB, 1) } else { 0 }
    $ramFree  = if ($os.FreePhysicalMemory) { [math]::Round($os.FreePhysicalMemory / 1MB, 1) } else { 0 }
    $ramFreePct = if ($os.FreePhysicalMemory -and $cs.TotalPhysicalMemory -and $cs.TotalPhysicalMemory -gt 0) {
        [math]::Round(($os.FreePhysicalMemory * 1KB) / $cs.TotalPhysicalMemory * 100, 1)
    } else { 0 }
    $lastBoot = if ($os.LastBootUpTime) { $os.LastBootUpTime.ToString('s') } else { "" }
    $uptime = if ($os.LastBootUpTime) { [math]::Round((New-TimeSpan -Start $os.LastBootUpTime -End (Get-Date)).TotalHours, 1) } else { 0 }

    $output.systemInfo = @{
        computerName = $env:COMPUTERNAME
        os = if ($os.Caption) { $os.Caption } else { "Windows" }
        osBuild = if ($os.BuildNumber) { $os.BuildNumber } else { "" }
        cpu = if ($cpu -and $cpu.Name) { $cpu.Name.Trim() } else { "Unknown" }
        ramGB = $ramTotal
        freeRamGB = $ramFree
        freeRamPct = $ramFreePct
        lastBoot = $lastBoot
        uptime = $uptime
    }
} catch {
    $debug += "SystemInfo failed: $_"
    $output.systemInfo = @{
        computerName = $env:COMPUTERNAME; os = "Windows"; osBuild = ""; cpu = "Unknown"
        ramGB = 0; freeRamGB = 0; freeRamPct = 0; lastBoot = ""; uptime = 0
    }
}

# =============================================================================
# 2. Disk Info
# =============================================================================
try {
    $disks = $null
    try {
        $disks = Get-CimInstance Win32_LogicalDisk -Filter "DriveType=3" -ErrorAction Stop
    } catch {
        $debug += "CIM Disk failed: $_"
        $disks = Get-WmiObject Win32_LogicalDisk -Filter "DriveType=3" -ErrorAction Stop
    }

    $output.diskInfo = if ($disks) {
        foreach ($d in $disks) {
            $total = if ($d.Size -and $d.Size -gt 0) { [math]::Round($d.Size / 1GB, 1) } else { 0 }
            $free  = if ($d.FreeSpace) { [math]::Round($d.FreeSpace / 1GB, 1) } else { 0 }
            $usedPct = if ($d.Size -and $d.FreeSpace -and $d.Size -gt 0) {
                [math]::Round(($d.Size - $d.FreeSpace) / $d.Size * 100, 1) } else { 0 }
            @{ drive = $d.DeviceID; freeGB = $free; totalGB = $total; usedPercent = $usedPct }
        }
    } else { @() }
} catch {
    $debug += "DiskInfo failed: $_"
    $output.diskInfo = @()
}

# =============================================================================
# 3. Crash Dumps — with config awareness (localDumps path + registry)
# =============================================================================
try {
    $dumpPaths = @(
        (Join-Path $env:LOCALAPPDATA "CrashDumps"),
        (Join-Path $env:windir "Minidump"),
        (Join-Path $env:windir "Memory.dmp")
    )

    $allDumps = @()
    foreach ($p in $dumpPaths) {
        try {
            $found = Get-ChildItem -Path $p -Filter "*.dmp" -ErrorAction SilentlyContinue
            if ($found) { $allDumps += $found }
        } catch { /* skip inaccessible path */ }
    }

    $localDumpsConfigured = $false
    $localDumpsDetails = @{}
    try {
        $werKey = 'HKLM:\SOFTWARE\Microsoft\Windows\Windows Error Reporting\LocalDumps'
        if (Test-Path $werKey) {
            $localDumpsConfigured = $true
            $props = Get-ItemProperty -Path $werKey -ErrorAction SilentlyContinue
            $localDumpsDetails = @{
                dumpFolder = if ($props.DumpFolder) { $props.DumpFolder } else { $null }
                dumpCount  = if ($props.DumpCount)  { [int]$props.DumpCount }  else { $null }
                dumpType   = if ($props.DumpType)   { [int]$props.DumpType }   else { $null }
                customDumpFlags = if ($props.CustomDumpFlags) { [int]$props.CustomDumpFlags } else { $null }
            }
        }
    } catch {
        $debug += "WER registry check failed: $_"
    }

    $output.crashDumps = @{
        count                = @($allDumps).Count
        recent               = @(
            if ($allDumps) {
                $allDumps | Sort-Object LastWriteTime -Descending | Select-Object -First 3 | Select-Object `
                    Name,
                    @{Name='Date'; Expression={$_.LastWriteTime.ToString('s')}},
                    @{Name='SizeMB'; Expression={[math]::Round($_.Length / 1MB, 1)}}
            }
        )
        localDumpsConfigured = $localDumpsConfigured
        localDumpsDetails    = $localDumpsDetails
        scannedPaths         = $dumpPaths
    }
} catch {
    $debug += "CrashDumps failed: $_"
    $output.crashDumps = @{
        count = 0; recent = @(); localDumpsConfigured = $false; localDumpsDetails = @{}; scannedPaths = @()
    }
}

# =============================================================================
# 4. System & App Events  (+ metadata)
# =============================================================================
$sysResult = Get-Events -LogName "System" -Level @(1,2) -MaxEvents 40
$output.systemEvents = $sysResult.events
$collectionMetadata.systemEvents = $sysResult.metadata
if ($sysResult.error) { $debug += "SystemEvents error: $($sysResult.error)" }

$appResult = Get-Events -LogName "Application" -Level @(1,2) -MaxEvents 20
$output.appEvents = $appResult.events
$collectionMetadata.appEvents = $appResult.metadata
if ($appResult.error) { $debug += "AppEvents error: $($appResult.error)" }

# =============================================================================
# (Priority 1-5) Pre-Error Events: Warning + Information 15–30 min before now
# =============================================================================
try {
    $preStart = (Get-Date).AddMinutes(-30)
    $preResult = Get-Events -LogName "System" -Level @(3,4) -MaxEvents 30 `
                -StartTime $preStart -EndTime (Get-Date) -IncludeWarningInfo
    $output.preErrorEvents = $preResult.events
    $collectionMetadata.preErrorEvents = $preResult.metadata
    if ($preResult.error) { $debug += "PreErrorEvents error: $($preResult.error)" }
} catch {
    $debug += "PreErrorEvents failed: $_"
    $output.preErrorEvents = @()
    $collectionMetadata.preErrorEvents = @{ queryStart = (Get-Date).AddMinutes(-30).ToString('o'); queryEnd = (Get-Date).ToString('o'); maxEvents = 30; wasTruncated = $false }
}

# =============================================================================
# 5. Recent Windows Updates
# =============================================================================
try {
    $updates = Get-HotFix | Sort-Object InstalledOn -Descending | Select-Object -First 5
    $output.recentUpdates = foreach ($u in $updates) {
        @{ HotFixID = $u.HotFixID; Description = $u.Description
           InstalledOn = if ($u.InstalledOn) { $u.InstalledOn.ToString('s') } else { "" } }
    }
} catch {
    $debug += "Updates failed: $_"
    $output.recentUpdates = @()
}

# =============================================================================
# 6. Network Events — query validated, debug if fail
# =============================================================================
try {
    $netResult = Get-Events -LogName "Microsoft-Windows-WLAN-AutoConfig/Operational" `
                -Level @(1,2,3) -MaxEvents 20 -StartTime (Get-Date).AddDays(-7) -EndTime (Get-Date)
    $output.networkEvents = $netResult.events
    if ($netResult.error) { $debug += "NetworkEvents error (query returned empty or failed): $($netResult.error)" }
} catch {
    $debug += "NetworkEvents failed: $_"
    $output.networkEvents = @()
}

# =============================================================================
# 7. Driver Events
# =============================================================================
try {
    $drvResult = Get-Events -LogName "Microsoft-Windows-Kernel-PnP/Configuration" `
                -Level @(1,2,3) -MaxEvents 15 -StartTime (Get-Date).AddDays(-7) -EndTime (Get-Date)
    $output.driverEvents = $drvResult.events
    if ($drvResult.error) { $debug += "DriverEvents error: $($drvResult.error)" }
} catch {
    $debug += "DriverEvents failed: $_"
    $output.driverEvents = @()
}

# =============================================================================
# 8. Top Processes (enhanced with PID, CPU%, StartTime)
# =============================================================================
try {
    $procs = Get-Process | Sort-Object CPU -Descending | Select-Object -First 10
    $output.topProcesses = foreach ($p in $procs) {
        $cpuSec = if ($p.CPU) { [math]::Round([double]$p.CPU, 2) } else { 0 }
        $startTime = if ($p.StartTime) { $p.StartTime.ToString('s') } else { $null }
        @{
            Name       = $p.Name
            PID        = $p.Id
            RAM_MB     = [math]::Round($p.WorkingSet / 1MB, 1)
            CPU_Percent = $cpuSec
            StartTime  = $startTime
        }
    }
} catch {
    $debug += "Processes failed: $_"
    $output.topProcesses = @()
}

# =============================================================================
# 9. Hardware Sensor Data  (+ sensorAvailability)
# =============================================================================
try {
    $sensorData = @{
        cpuTemp        = $null
        gpuTemp        = $null
        fanSpeed       = $null
        batteryHealth  = $null
        cpuLoad        = $null
        isDesktop      = $true
        hasBattery     = $false
    }
    $sensorAvailability = @{}

    # --- Chassis ---
    try {
        $encl = @(Get-CimInstance -ClassName 'Win32_SystemEnclosure' -ErrorAction SilentlyContinue)
        $portableTypes = @(8, 9, 10, 11, 14)
        $chassisTypes = $encl | ForEach-Object { $_.ChassisTypes } | Where-Object { $_ -ne $null }
        $cs = Get-CimInstance -ClassName 'Win32_ComputerSystem' -ErrorAction SilentlyContinue
        $isPortable = (($chassisTypes | Where-Object { $portableTypes -contains $_ }).Count -gt 0) -or ($cs -and $cs.PCSystemType -eq 2)
        if ($isPortable) { $sensorData.isDesktop = $false }
    } catch { $debug += "Sensor-Chassis failed: $_" }

    # Helper: try read a thermal value; returns $null on fail
    function Read-ThermalCelsius {
        param($Source, $Class, $Namespace = 'root\WMI')
        try {
            $items = @(Get-CimInstance -Namespace $Namespace -ClassName $Class -ErrorAction Stop)
            foreach ($item in $items) {
                try {
                    $c = switch ($Class) {
                        'MSSMBios_ThermalZoneType' {
                            $k = [math]::Round($_.CurrentTemperature / 10, 1)
                            [math]::Round($k - 273.15, 1)
                        }
                        'MSAcpi_ThermalZoneTemperature' {
                            [math]::Round(($_.CurrentTemperature / 10) - 273.15, 1)
                        }
                        'Win32_TemperatureProbe' {
                            $raw = $_.CurrentReading
                            if ($null -eq $raw) { return $null }
                            if ($raw -gt 200) { [math]::Round($raw - 273.15, 1) } else { [math]::Round($raw, 1) }
                        }
                        'Win32_PerfFormattedData_Counters_ThermalZoneInformation' {
                            [math]::Round([double]$_.Temperature / 10, 1)
                        }
                        default { $null }
                    }
                    if ($c -gt 0 -and $c -lt 150) { return $c }
                } catch { continue }
            }
        } catch { return $null }
        return $null
    }

    $cpuTemps = @()
    $gpuTemps = @()

    # 1. MSSMBios
    try {
        $thermal = @(Get-CimInstance -Namespace 'root\WMI' -ClassName 'MSSMBios_ThermalZoneType' -ErrorAction Stop)
        if ($thermal.Count -gt 0) {
            foreach ($t in $thermal) {
                try {
                    $k = [math]::Round($t.CurrentTemperature / 10, 1)
                    $c = [math]::Round($k - 273.15, 1)
                    if ($c -gt 0 -and $c -lt 150) { $cpuTemps += $c }
                } catch {}
            }
        }
    } catch { $sensorAvailability.cpuTemp = "not_supported" }

    # 2. MSAcpi fallback
    if ($cpuTemps.Count -eq 0) {
        try {
            $acpi = @(Get-CimInstance -Namespace 'root\WMI' -ClassName 'MSAcpi_ThermalZoneTemperature' -ErrorAction Stop)
            if ($acpi.Count -gt 0) {
                foreach ($a in $acpi) {
                    try {
                        $c = [math]::Round(($a.CurrentTemperature / 10) - 273.15, 1)
                        if ($c -gt 0 -and $c -lt 150) { $cpuTemps += $c }
                    } catch {}
                }
            }
        } catch { $sensorAvailability.cpuTemp = "not_supported" }
    }

    # 3. Probe fallback
    if ($cpuTemps.Count -eq 0) {
        try {
            $probe = @(Get-CimInstance -ClassName 'Win32_TemperatureProbe' -ErrorAction SilentlyContinue)
            foreach ($p in $probe) {
                try {
                    $c = Read-ThermalCelsius -Class 'Win32_TemperatureProbe' -Namespace 'root\CIMV2'
                    if ($c) { $cpuTemps += $c }
                } catch {}
            }
        } catch { $sensorAvailability.cpuTemp = "not_supported" }
    }

    if ($cpuTemps.Count -gt 0) {
        $sensorData.cpuTemp = ($cpuTemps | Measure-Object -Maximum).Maximum
    }
    if ($null -eq $sensorData.cpuTemp) {
        if (-not $sensorAvailability.ContainsKey('cpuTemp')) {
            $sensorAvailability.cpuTemp = "wmi_class_missing"
        }
    }

    # --- OpenHardwareMonitor WMI fallback (no admin needed if service is running) ---
    if ($null -eq $sensorData.cpuTemp -or $null -eq $sensorData.gpuTemp -or $null -eq $sensorData.fanSpeed) {
        try {
            $ohm = @(Get-CimInstance -Namespace 'root\OpenHardwareMonitor' -ClassName 'Sensor' -ErrorAction SilentlyContinue)
            if ($ohm.Count -gt 0) {
                $cpuCandidates = @()
                $gpuCandidates = @()
                $fanCandidates = @()
                foreach ($s in $ohm) {
                    try {
                        if ($null -eq $s.Value) { continue }
                        if ($s.SensorType -eq 2 -and $s.Value -gt 0 -and $s.Value -lt 150) {
                            $t = [math]::Round([double]$s.Value, 1)
                            if ($s.Name -match 'GPU|VGA') { $gpuCandidates += $t }
                            else { $cpuCandidates += $t }
                        }
                        if ($s.SensorType -eq 3 -and [int]$s.Value -gt 0 -and [int]$s.Value -le 30000) {
                            $fanCandidates += [int]$s.Value
                        }
                    } catch {}
                }
                if ($cpuCandidates.Count -gt 0 -and $null -eq $sensorData.cpuTemp) {
                    $sensorData.cpuTemp = ($cpuCandidates | Measure-Object -Maximum).Maximum
                }
                if ($gpuCandidates.Count -gt 0 -and $null -eq $sensorData.gpuTemp) {
                    $sensorData.gpuTemp = ($gpuCandidates | Measure-Object -Maximum).Maximum
                }
                if ($fanCandidates.Count -gt 0 -and $null -eq $sensorData.fanSpeed) {
                    $sensorData.fanSpeed = ($fanCandidates | Measure-Object -Minimum).Minimum
                }
            }
        } catch { $debug += "Sensor-OHM WMI fallback failed: $_" }
    }

    # Fan speed
    try {
        $fans = @(Get-CimInstance -ClassName 'Win32_Fan' -ErrorAction SilentlyContinue)
        $fanReadings = $fans | ForEach-Object {
            try {
                if ($_.CurrentReading -and [int]$_.CurrentReading -gt 0) { [int]$_.CurrentReading } else { $null }
            } catch { $null }
        } | Where-Object { $_ -ne $null -and $_ -le 25000 }

        if ($fanReadings.Count -gt 0) {
            $sensorData.fanSpeed = ($fanReadings | Measure-Object -Minimum).Minimum
        } else {
            $cooling = @(Get-CimInstance -ClassName 'Win32_CoolingDevice' -ErrorAction SilentlyContinue)
            $coolReadings = $cooling | ForEach-Object {
                try {
                    $v = if ($_.DesiredSpeed) { $_.DesiredSpeed } elseif ($_.ActiveCooling) { $_.ActiveCooling } else { $null }
                    if ($v -and [int]$v -gt 0) { [int]$v } else { $null }
                } catch { $null }
            } | Where-Object { $_ -ne $null -and $_ -le 25000 }
            if ($coolReadings.Count -gt 0) {
                $sensorData.fanSpeed = ($coolReadings | Measure-Object -Minimum).Minimum
            } else {
                $sensorAvailability.fanSpeed = "not_supported"
            }
        }
    } catch {
        $debug += "Sensor-Fan failed: $_"
        $sensorAvailability.fanSpeed = "not_supported"
    }

    # Battery
    try {
        $batt = Get-CimInstance -ClassName 'Win32_Battery' -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($batt -and $batt.DesignCapacity -and $batt.DesignCapacity -gt 0) {
            $sensorData.hasBattery = $true
            $fc = if ($batt.FullChargeCapacity) { $batt.FullChargeCapacity } else { $null }
            if ($fc) {
                $pct = [math]::Round(($fc / $batt.DesignCapacity) * 100)
                if ($pct -gt 0 -and $pct -le 120) { $sensorData.batteryHealth = $pct }
            } else {
                $sensorData.batteryHealth = if ($batt.Status) { $batt.Status } else { $null }
            }
        } else {
            $sensorData.hasBattery = $false
        }
    } catch {
        $debug += "Sensor-Battery failed: $_"
        $sensorData.hasBattery = $false
    }

    # Load %
    try {
        $load = (Get-CimInstance -ClassName 'Win32_Processor' -ErrorAction Stop | Select-Object -First 1).LoadPercentage
        if ($load -ne $null) { $sensorData.loadPercentage = [math]::Round([double]$load, 1) }
    } catch {
        try {
            $pc = (Get-Counter '\Processor(_Total)\% Processor Time' -ErrorAction Stop).CounterSamples.CookedValue
            $sensorData.loadPercentage = [math]::Round($pc, 1)
        } catch {
            $debug += "Sensor-Load failed: $_"
            $sensorAvailability.loadPercentage = "not_supported"
        }
    }

    $output.sensorData = $sensorData
    $output.sensorAvailability = $sensorAvailability
} catch {
    $debug += "SensorData failed: $_"
    $output.sensorData = @{ cpuTemp=$null; gpuTemp=$null; fanSpeed=$null; batteryHealth=$null; cpuLoad=$null; isDesktop=$true; hasBattery=$false; _adminMode=$false; _demoSensor=$false }
    $output.sensorAvailability = @{}
}

# =============================================================================
# Service Status
# =============================================================================
try {
    $svcNames = @('wuauserv','BITS','WinDefend')
    $svcResults = @()
    foreach ($sName in $svcNames) {
        try {
            $svc = $null
            try { $svc = Get-CimInstance Win32_Service -Filter "Name='$sName'" -ErrorAction Stop }
            catch { $svc = Get-WmiObject Win32_Service -Filter "Name='$sName'" -ErrorAction SilentlyContinue }

            $svcDisplay = if ($svc -and $svc.DisplayName) { $svc.DisplayName } else { $sName }
            $svcStatus = if ($svc -and $svc.State) { $svc.State } else { $null }
            $startMode = if ($svc -and $svc.StartMode) { $svc.StartMode } else { $null }
            if ($null -eq $svc) { $svcStatus = "not_found"; $startMode = $null }
            $svcResults += @{ name=$sName; displayName=$svcDisplay; status=$svcStatus; startType=$startMode }
        } catch {
            $svcResults += @{ name=$sName; displayName=$sName; status="error"; startType=$null }
        }
    }
    $output.serviceStatus = $svcResults
} catch {
    $debug += "ServiceStatus failed: $_"
    $output.serviceStatus = @(@{ name='wuauserv'; displayName='Windows Update'; status=$null; startType=$null },
                             @{ name='BITS'; displayName='Background Intelligent Transfer Service'; status=$null; startType=$null },
                             @{ name='WinDefend'; displayName='Windows Defender Antivirus Service'; status=$null; startType=$null })
}

# =============================================================================
# Update Policy
# =============================================================================
try {
    $upKey = 'HKLM:\SOFTWARE\Policies\Microsoft\Windows\WindowsUpdate'
    $policyExists = Test-Path $upKey
    $policyValues = @{}
    if ($policyExists) {
        try {
            $props = Get-ItemProperty -Path $upKey -ErrorAction Stop
            foreach ($p in ($props.PSObject.Properties | Where-Object { $_.Name -notmatch '^PS' })) {
                $policyValues[$p.Name] = $p.Value
            }
        } catch { $debug += "UpdatePolicy values read failed: $_" }
    }
    $output.updatePolicy = @{ policyKeyExists = $policyExists; values = $policyValues }
} catch {
    $debug += "UpdatePolicy failed: $_"
    $output.updatePolicy = @{ policyKeyExists = $false; values = @{} }
}

# =============================================================================
# Driver Inventory
# =============================================================================
try {
    $drvs = @(Get-CimInstance Win32_PnPSignedDriver -ErrorAction Stop)
    $output.driverInventory = $drvs | ForEach-Object {
        @{
            name        = if ($_.DeviceName) { $_.DeviceName } else { $_.DriverProviderName }
            infName     = $_.InfName
            version     = $_.DriverVersion
            signed      = $_.Signed
            installDate = if ($_.InstallDate) { $_.InstallDate.ToString('s') } else { $null }
        }
    }
} catch {
    $debug += "DriverInventory failed: $_"
    $output.driverInventory = @()
}

# =============================================================================
# Security Software
# =============================================================================
try {
    $avProducts = @(Get-CimInstance -Namespace 'root/SecurityCenter2' -ClassName 'AntivirusProduct' -ErrorAction Stop)
    $output.securitySoftware = $avProducts | ForEach-Object {
        @{
            displayName           = $_.displayName
            productState          = $_.productState
            realTimeProtection    = if ($_.realTimeProtection) { $_.realTimeProtection } else { $null }
        }
    }
} catch {
    $debug += "SecuritySoftware failed: $_"
    $output.securitySoftware = @()
}

# =============================================================================
# Firmware Info
# =============================================================================
try {
    $secureBootOk = $null
    try {
        $secureBootResult = Confirm-SecureBootUEFI -ErrorAction Stop
        if ($secureBootResult -eq $true) { $secureBootOk = $true }
        elseif ($secureBootResult -eq $false) { $secureBootOk = $false }
    } catch {
        $debug += "SecureBootUEFI check failed: $_"
        $secureBootOk = $null
    }

    $bcdEntry = & bcdedit /enum '{current}' 2>&1 | Out-String
    $bootMethod = if ($bcdEntry -match '\\Windows\s+(\S+)') { $Matches[1] } else { $null }
    if (-not $bootMethod) { $bootMethod = "unknown" }

    $output.firmwareInfo = @{ secureBootEnabled = $secureBootOk; bootMethod = $bootMethod }
} catch {
    $debug += "FirmwareInfo failed: $_"
    $output.firmwareInfo = @{ secureBootEnabled = $null; bootMethod = $null }
}

# =============================================================================
# Disk Health
# =============================================================================
try {
    $physDisks = @(Get-PhysicalDisk -ErrorAction SilentlyContinue)
    $diskHealth = @()
    foreach ($pd in $physDisks) {
        try {
            $ctr = Get-StorageReliabilityCounter -PhysicalDisk $pd -ErrorAction SilentlyContinue
            if ($null -eq $ctr) { $ctr = [pscustomobject]@{} }
            $diskHealth += @{
                deviceId            = $pd.DeviceId
                friendlyName        = $pd.FriendlyName
                mediaType           = $pd.MediaType
                temperature         = if ($ctr.Temperature) { $ctr.Temperature } else { $null }
                wear                = if ($ctr.Wear) { $ctr.Wear } else { $null }
                errorsCorrected     = if ($ctr.ErrorsCorrected) { $ctr.ErrorsCorrected } else { $null }
                errorsNotFound      = if ($ctr.ErrorsNotFound) { $ctr.ErrorsNotFound } else { $null }
                uncorrectableErrors = if ($ctr.UncorrectableErrors) { $ctr.UncorrectableErrors } else { $null }
            }
        } catch {
            $diskHealth += @{ deviceId = $pd.DeviceId; friendlyName = $pd.FriendlyName; mediaType = $pd.MediaType; readError = $_.Exception.Message }
        }
    }
    $output.diskHealth = $diskHealth
} catch {
    $debug += "DiskHealth failed: $_"
    $output.diskHealth = @()
}

# =============================================================================
# Resource Timeline — background rolling buffer (~30 min)
# =============================================================================
$timelineFile = Join-Path $env:TEMP "syslog_ai_resource_timeline.json"
$resourceTimeline = @()
try {
    if (Test-Path $timelineFile) {
        try {
            $resourceTimeline = @(Get-Content $timelineFile -Raw -ErrorAction SilentlyContinue | ConvertFrom-Json)
        } catch { $resourceTimeline = @() }
        if ($resourceTimeline.Count -gt 180) {
            $resourceTimeline = $resourceTimeline | Select-Object -Last 180
        }
    }

    $now = Get-Date
    $t = $now.ToString('HH:mm:ss')
    $cpuVal = $null; $ramVal = $null
    try { $cpuVal = [math]::Round((Get-Counter '\Processor(_Total)\% Processor Time' -ErrorAction Stop).CounterSamples.CookedValue, 1) } catch {}
    try { $ramVal = [math]::Round((Get-CimInstance Win32_OperatingSystem -ErrorAction SilentlyContinue).FreePhysicalMemory / 1MB, 1) } catch {}

    $resourceTimeline += [pscustomobject]@{ time=$t; cpuPercent=$cpuVal; ramFreeGB=$ramVal }
    $resourceTimeline = $resourceTimeline | Select-Object -Last 180
    $resourceTimeline | ConvertTo-Json -Depth 4 -Compress | Set-Content $timelineFile -Encoding UTF8
} catch {
    $debug += "ResourceTimeline init failed: $_"
}

try {
    $jobAction = {
        param($TimelineFile)
        while ($true) {
            Start-Sleep -Seconds 60
            $tl = @()
            if (Test-Path $TimelineFile) {
                try { $tl = @(Get-Content $TimelineFile -Raw | ConvertFrom-Json) } catch { $tl = @() }
            }
            if ($tl.Count -gt 180) { $tl = $tl | Select-Object -Last 180 }
            $now = Get-Date
            $cpuVal = $null; $ramVal = $null
            try { $cpuVal = [math]::Round((Get-Counter '\Processor(_Total)\% Processor Time' -ErrorAction Stop).CounterSamples.CookedValue, 1) } catch {}
            try { $ramVal = [math]::Round((Get-CimInstance Win32_OperatingSystem -ErrorAction SilentlyContinue).FreePhysicalMemory / 1MB, 1) } catch {}
            $tl += [pscustomobject]@{ time=$now.ToString('HH:mm:ss'); cpuPercent=$cpuVal; ramFreeGB=$ramVal }
            $tl = $tl | Select-Object -Last 180
            try { $tl | ConvertTo-Json -Depth 4 -Compress | Set-Content $TimelineFile -Encoding UTF8 } catch {}
        }
    }
    $bgJob = Start-Job -ScriptBlock $jobAction -ArgumentList $timelineFile -ErrorAction SilentlyContinue
    if ($bgJob) { $debug += "ResourceTimeline job started (id=$($bgJob.Id))" }
} catch {
    $debug += "ResourceTimeline background job failed: $_"
}

$output.resourceTimeline = $resourceTimeline
$output.collectionMetadata = $collectionMetadata

if ($debug.Count -gt 0) {
    $output._debug = $debug -join ' | '
    $output._scriptVersion = $scriptVersion
}

$json = $output | ConvertTo-Json -Depth 6 -Compress
Write-Output $json