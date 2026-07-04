$ErrorActionPreference = "Continue"
$WarningPreference = "SilentlyContinue"

# Helper function to get event logs safely
function Get-Events {
    param(
        [string]$LogName,
        [int[]]$Level,
        [int]$MaxEvents = 20
    )
    try {
        $events = Get-WinEvent -FilterHashtable @{LogName=$LogName; Level=$Level; StartTime=(Get-Date).AddDays(-7)} -MaxEvents $MaxEvents -ErrorAction Stop
        
        $events | Select-Object `
            @{Name='TimeCreated'; Expression={$_.TimeCreated.ToString('s')}},
            Id,
            ProviderName,
            LevelDisplayName,
            Message
    } catch {
        @()
    }
}

$output = @{}
$debug = @()

# 1. System Info
try {
    # Try CIM first (requires admin on some systems), fallback to WMI
    $os = $null
    $cs = $null
    $cpu = $null
    
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
    $ramFree = if ($os.FreePhysicalMemory) { [math]::Round($os.FreePhysicalMemory / 1MB, 1) } else { 0 }
    # Fix: FreePhysicalMemory is in KB, TotalPhysicalMemory is in bytes
    # Use 1KB (1024) to convert KB to bytes, not 1024KB (1048576)
    $ramFreePct = if ($os.FreePhysicalMemory -and $cs.TotalPhysicalMemory -and $cs.TotalPhysicalMemory -gt 0) { [math]::Round(($os.FreePhysicalMemory * 1KB) / $cs.TotalPhysicalMemory * 100, 1) } else { 0 }
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
        computerName = $env:COMPUTERNAME
        os = "Windows"
        osBuild = ""
        cpu = "Unknown"
        ramGB = 0
        freeRamGB = 0
        freeRamPct = 0
        lastBoot = ""
        uptime = 0
    }
}

# 2. Disk Info
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
            $free = if ($d.FreeSpace) { [math]::Round($d.FreeSpace / 1GB, 1) } else { 0 }
            $usedPct = if ($d.Size -and $d.FreeSpace -and $d.Size -gt 0) { [math]::Round(($d.Size - $d.FreeSpace) / $d.Size * 100, 1) } else { 0 }
            @{
                drive = $d.DeviceID
                freeGB = $free
                totalGB = $total
                usedPercent = $usedPct
            }
        }
    } else {
        @()
    }
} catch {
    $debug += "DiskInfo failed: $_"
    $output.diskInfo = @()
}

# 3. Crash Dumps (BSODs)
try {
    $dumpPath = Join-Path $env:windir "Minidump"
    $dumps = Get-ChildItem -Path $dumpPath -Filter "*.dmp" -ErrorAction SilentlyContinue
    
    $output.crashDumps = @{
        count = if ($dumps) { @($dumps).Count } else { 0 }
        # Fix: ensure recent is always an array, even when empty
        recent = @(if ($dumps) { 
            $dumps | Sort-Object LastWriteTime -Descending | Select-Object -First 3 | Select-Object `
                Name, 
                @{Name='Date'; Expression={$_.LastWriteTime.ToString('s')}}
        })
    }
} catch {
    $debug += "CrashDumps failed: $_"
    $output.crashDumps = @{ count = 0; recent = @() }
}

# 4. System & App Events
$output.systemEvents = Get-Events -LogName "System" -Level 1,2 -MaxEvents 40
$output.appEvents = Get-Events -LogName "Application" -Level 1,2 -MaxEvents 20

# 5. Recent Windows Updates
try {
    $updates = Get-HotFix | Sort-Object InstalledOn -Descending | Select-Object -First 5
    $output.recentUpdates = foreach ($u in $updates) {
        @{
            HotFixID = $u.HotFixID
            Description = $u.Description
            InstalledOn = if ($u.InstalledOn) { $u.InstalledOn.ToString('s') } else { "" }
        }
    }
} catch {
    $debug += "Updates failed: $_"
    $output.recentUpdates = @()
}

# 6. Network Events (WiFi disconnects, etc.)
try {
    $netEvents = Get-WinEvent -FilterHashtable @{ProviderName='Microsoft-Windows-WLAN-AutoConfig'; StartTime=(Get-Date).AddDays(-7)} -MaxEvents 20 -ErrorAction Stop
    $output.networkEvents = $netEvents | Select-Object `
        @{Name='TimeCreated'; Expression={$_.TimeCreated.ToString('s')}},
        Id,
        Message
} catch {
    $output.networkEvents = @()
}

# 7. Driver Events (Hardware issues)
try {
    $driverEvents = Get-WinEvent -FilterHashtable @{ProviderName='Microsoft-Windows-Kernel-PnP'; Level=2,3; StartTime=(Get-Date).AddDays(-7)} -MaxEvents 15 -ErrorAction Stop
    $output.driverEvents = $driverEvents | Select-Object `
        @{Name='TimeCreated'; Expression={$_.TimeCreated.ToString('s')}},
        Id,
        LevelDisplayName,
        Message
} catch {
    $output.driverEvents = @()
}

# 8. Top Processes (High RAM usage)
try {
    $procs = Get-Process | Sort-Object WorkingSet -Descending | Select-Object -First 10
    $output.topProcesses = foreach ($p in $procs) {
        @{
            Name = $p.Name
            RAM_MB = [math]::Round($p.WorkingSet / 1MB, 1)
        }
    }
} catch {
    $debug += "Processes failed: $_"
    $output.topProcesses = @()
}

# Add debug info if any errors occurred
if ($debug.Count -gt 0) {
    $output._debug = $debug -join ' | '
}

# Output as JSON
$json = $output | ConvertTo-Json -Depth 5 -Compress
Write-Output $json