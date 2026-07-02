$ErrorActionPreference = "SilentlyContinue"

# Helper function to get event logs safely
function Get-Events {
    param(
        [string]$LogName,
        [int[]]$Level,
        [int]$MaxEvents = 20
    )
    try {
        # Level: 1=Critical, 2=Error, 3=Warning
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

# 1. System Info
try {
    $os = Get-CimInstance Win32_OperatingSystem
    $cs = Get-CimInstance Win32_ComputerSystem
    $cpu = Get-CimInstance Win32_Processor | Select-Object -First 1

    $output.systemInfo = @{
        computerName = $env:COMPUTERNAME
        os = $os.Caption
        osBuild = $os.BuildNumber
        cpu = if ($cpu) { $cpu.Name.Trim() } else { "Unknown" }
        ramGB = if ($cs) { [math]::Round($cs.TotalPhysicalMemory / 1GB, 1) } else { 0 }
        freeRamGB = if ($os) { [math]::Round($os.FreePhysicalMemory / 1MB, 1) } else { 0 }
        freeRamPct = if ($os -and $cs -and $cs.TotalPhysicalMemory -gt 0) { [math]::Round(($os.FreePhysicalMemory * 1024) / $cs.TotalPhysicalMemory * 100, 1) } else { 0 }
        lastBoot = if ($os) { $os.LastBootUpTime.ToString('s') } else { "" }
        uptime = if ($os) { [math]::Round((New-TimeSpan -Start $os.LastBootUpTime -End (Get-Date)).TotalHours, 1) } else { 0 }
    }
} catch {
    $output.systemInfo = @{}
}

# 2. Disk Info
try {
    $disks = Get-CimInstance Win32_LogicalDisk -Filter "DriveType=3"
    $output.diskInfo = foreach ($d in $disks) {
        @{
            drive = $d.DeviceID
            freeGB = [math]::Round($d.FreeSpace / 1GB, 1)
            totalGB = [math]::Round($d.Size / 1GB, 1)
            usedPercent = [math]::Round(($d.Size - $d.FreeSpace) / $d.Size * 100, 1)
        }
    }
} catch {
    $output.diskInfo = @()
}

# 3. Crash Dumps (BSODs)
try {
    $dumpPath = Join-Path $env:windir "Minidump"
    $dumps = Get-ChildItem -Path $dumpPath -Filter "*.dmp" -ErrorAction SilentlyContinue
    
    $output.crashDumps = @{
        count = if ($dumps) { @($dumps).Count } else { 0 }
        recent = if ($dumps) { 
            @($dumps | Sort-Object LastWriteTime -Descending | Select-Object -First 3 | Select-Object `
                Name, 
                @{Name='Date'; Expression={$_.LastWriteTime.ToString('s')}})
        } else { @() }
    }
} catch {
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
    $output.topProcesses = @()
}

# Output as JSON
$json = $output | ConvertTo-Json -Depth 5 -Compress
Write-Output $json
