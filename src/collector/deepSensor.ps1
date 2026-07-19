[CmdletBinding()]
param(
    [string]$DllPath = '',
    [string]$OutputFile = ''
)

$ErrorActionPreference = 'Stop'

function Write-Result {
    param($Obj)
    $j = $Obj | ConvertTo-Json -Depth 6 -Compress
    if ($OutputFile) {
        try { Set-Content -Path $OutputFile -Value $j -Encoding UTF8 } catch {}
    }
    Write-Output $j
    exit 0
}

if (-not $DllPath) {
    $DllPath = Join-Path $PSScriptRoot 'LibreHardwareMonitorLib.dll'
}
if (-not (Test-Path $DllPath)) {
    $fallback = @{
        hasAdminAccess   = $false
        elevated         = $false
        error            = "LibreHardwareMonitorLib.dll not found at: $DllPath"
        motherboardName  = $null
        motherboardBrand = $null
        chipsetTemp      = $null
        gpuTemp          = $null
        cpuTemps         = @()
        cpuPackageTemp   = $null
        cpuLoad          = $null
        fanSpeeds        = @{}
    }
    Write-Result $fallback
}

function Test-IsAdmin {
    $id = [System.Security.Principal.WindowsIdentity]::GetCurrent()
    $p  = New-Object System.Security.Principal.WindowsPrincipal($id)
    return $p.IsInRole([System.Security.Principal.WindowsBuiltInRole]::Administrator)
}

if (-not (Test-IsAdmin)) {
    $argList = "-ExecutionPolicy Bypass -NoProfile -File `"$PSCommandPath`""
    if ($DllPath)   { $argList += " -DllPath `"$DllPath`"" }
    if ($OutputFile) { $argList += " -OutputFile `"$OutputFile`"" }

    try {
        $proc = Start-Process -FilePath 'powershell.exe' `
            -Verb RunAs `
            -ArgumentList $argList `
            -WindowStyle Hidden `
            -PassThru `
            -Wait
    } catch {
        $denied = @{
            hasAdminAccess   = $false
            elevated         = $false
            uacDenied        = $true
            error            = "UAC elevation denied by user."
            motherboardName  = $null
            motherboardBrand = $null
            chipsetTemp      = $null
            gpuTemp          = $null
            cpuTemps         = @()
            cpuPackageTemp   = $null
            cpuLoad          = $null
            fanSpeeds        = @{}
        }
        Write-Result $denied
    }

    if ($OutputFile -and (Test-Path $OutputFile)) {
        $content = Get-Content -Path $OutputFile -Raw -Encoding UTF8
        Write-Output $content
        exit 0
    }

    $unknown = @{
        hasAdminAccess   = $false
        elevated         = $false
        uacDenied        = $true
        error            = "Elevated child process produced no output."
        motherboardName  = $null
        motherboardBrand = $null
        chipsetTemp      = $null
        gpuTemp          = $null
        cpuTemps         = @()
        cpuPackageTemp   = $null
        cpuLoad          = $null
        fanSpeeds        = @{}
    }
    Write-Result $unknown
}

$result = @{
    hasAdminAccess   = $true
    elevated         = $true
    motherboardName  = $null
    motherboardBrand = $null
    chipsetTemp      = $null
    gpuTemp          = $null
    cpuTemps         = @()
    cpuPackageTemp   = $null
    cpuLoad          = $null
    fanSpeeds        = @{}
    error            = $null
}

$dllDir = Split-Path -Parent $DllPath
try {
    if ($dllDir -and (Test-Path $dllDir)) {
        Set-Location -Path $dllDir
    }
    $asm = [System.Reflection.Assembly]::LoadFrom($DllPath)
    if (-not $asm) { throw 'Assembly load returned null' }
} catch {
    $le = $_.Exception.LoaderExceptions
    $detail = if ($le) { ($le | ForEach-Object { $_.Message }) -join '; ' } else { $_.Exception.Message }
    $result.error = "Failed to load LibreHardwareMonitorLib: $detail"
    Write-Result $result
}

try {
    $computer = New-Object LibreHardwareMonitor.Hardware.Computer
    $computer.IsCpuEnabled         = $true
    $computer.IsGpuEnabled         = $true
    $computer.IsMotherboardEnabled = $true
    $computer.IsControllerEnabled  = $true
    $computer.IsStorageEnabled     = $true
    $computer.IsNetworkEnabled     = $false
    $computer.IsMemoryEnabled      = $false
    $computer.Open()

    $gpuTemps    = @()
    $cpuCoreTemps = @()
    $cpuPkgTemp  = $null
    $cpuLoadVal  = $null
    $fans        = @{}
    $mbName      = $null
    $mbBrand     = $null
    $chipTemps   = @()

    function Visit-Hardware($hw) {
        try { $hw.Update() } catch { return }

        try {
            if ($hw.HardwareType.ToString() -eq 'Motherboard') {
                if (-not $script:mbName -and $hw.Name) {
                    $script:mbName = $hw.Name.Trim()
                    $script:mbBrand = ($hw.Name.Trim() -split '\s+')[0]
                }
            }
        } catch {}

        foreach ($sensor in $hw.Sensors) {
            try {
                $st   = $sensor.SensorType.ToString()
                $name = $sensor.Name
                $val  = $sensor.Value
                if ($null -eq $val) { continue }

                if ($st -eq 'Temperature') {
                    $t = [math]::Round([double]$val, 1)
                    try {
                        if ($hw.HardwareType.ToString() -match 'Gpu') {
                            $script:gpuTemps += $t
                        } elseif ($hw.HardwareType.ToString() -eq 'Cpu') {
                            if ($name -match 'package|รวม|total|cpu package') {
                                $script:cpuPkgTemp = $t
                            } else {
                                $script:cpuCoreTemps += $t
                            }
                        } elseif ($hw.HardwareType.ToString() -eq 'Motherboard') {
                            if ($name -match 'chipset|พื้นบอร์ด|southbridge|northbridge') {
                                $script:chipTemps += $t
                            }
                        }
                    } catch {}
                }

                if ($st -eq 'Load') {
                    try {
                        if ($hw.HardwareType.ToString() -eq 'Cpu') {
                            if ($name -match 'total|รวม|average|cpu load') {
                                $script:cpuLoadVal = [math]::Round([double]$val, 1)
                            }
                        }
                    } catch {}
                }

                if ($st -eq 'Fan') {
                    try {
                        $rpm = [int]$val
                        if ($rpm -gt 0 -and $rpm -le 30000) {
                            $key = $name -replace '[^A-Za-z0-9]', ''
                            if (-not $script:fans.ContainsKey($key)) { $script:fans[$key] = $rpm }
                        }
                    } catch {}
                }
            } catch { continue }
        }

        foreach ($sub in $hw.SubHardware) {
            Visit-Hardware $sub
        }
    }

    foreach ($h in $computer.Hardware) {
        Visit-Hardware $h
    }

    $result.motherboardName  = if ($mbName)  { $mbName  } else { $null }
    $result.motherboardBrand = if ($mbBrand) { $mbBrand } else { $null }

    if ($gpuTemps.Count -gt 0) {
        $result.gpuTemp = ($gpuTemps | Measure-Object -Maximum).Maximum
    }

    if ($cpuCoreTemps.Count -gt 0) {
        $result.cpuTemps = $cpuCoreTemps
    }

    if ($null -ne $cpuPkgTemp) {
        $result.cpuPackageTemp = $cpuPkgTemp
    }

    if ($null -ne $cpuLoadVal) {
        $result.cpuLoad = $cpuLoadVal
    }

    if ($chipTemps.Count -gt 0) {
        $result.chipsetTemp = ($chipTemps | Measure-Object -Maximum).Maximum
    }

    if ($fans.Count -gt 0) {
        $result.fanSpeeds = $fans
    }

    try { $computer.Close() } catch {}
} catch {
    $result.error = "Sensor enumeration failed: $_"
}

Write-Result $result