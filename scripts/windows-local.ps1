[CmdletBinding()]
param(
    [ValidateSet('Setup', 'Check', 'Start', 'Stop', 'Status')]
    [string]$Action = 'Check',
    [string]$Python = 'python',
    [ValidateRange(1024, 65535)][int]$BackendPort = 8010,
    [ValidateRange(1024, 65535)][int]$AgentPort = 8020,
    [ValidateRange(1024, 65535)][int]$FrontendPort = 5173
)

$ErrorActionPreference = 'Stop'
$OutputEncoding = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = $OutputEncoding
$env:PYTHONUTF8 = '1'
$Root = Split-Path $PSScriptRoot -Parent
$Runtime = Join-Path $Root '.runtime/windows-local'
$StateFile = Join-Path $Runtime 'processes.json'
$Backend = Join-Path $Root 'backend-next'
$Agent = Join-Path $Root 'agent-service'
$Frontend = Join-Path $Root 'frontend-vue'
$VenvPython = Join-Path $Backend '.venv/Scripts/python.exe'
$Utf8 = New-Object System.Text.UTF8Encoding($false)

function Invoke-Checked([string]$Program, [string[]]$Arguments, [string]$Directory, [string]$InputText) {
    Push-Location $Directory
    try {
        # PowerShell 5.1 会改写 -c/-e 中的双引号；脚本文本经 stdin 传递，避免本机配置被错误解释。
        if ($PSBoundParameters.ContainsKey('InputText')) { $InputText | & $Program @Arguments }
        else { & $Program @Arguments }
        if ($LASTEXITCODE -ne 0) { throw "命令执行失败，退出码 $LASTEXITCODE。请检查上方输出。" }
    } finally { Pop-Location }
}

function Assert-Tools {
    $nodeVersion = & node -p 'process.versions.node'
    if ($LASTEXITCODE -ne 0) { throw '请安装 Node.js 22.12+（22.x）或 24.x。' }
    $version = [version]$nodeVersion
    if (($version.Major -ne 22 -and $version.Major -ne 24) -or $version -lt [version]'22.12.0') {
        throw '请使用 Node.js 22.12+（22.x）或 24.x。'
    }
    $null = Get-Command npm.cmd -ErrorAction Stop
}

function Save-State($Records) {
    [IO.Directory]::CreateDirectory($Runtime) | Out-Null
    $values = @($Records | Where-Object { $null -ne $_ })
    [IO.File]::WriteAllText($StateFile, (ConvertTo-Json -InputObject $values -Depth 5), $Utf8)
}

function Read-State {
    if (Test-Path -LiteralPath $StateFile) {
        $records = Get-Content -LiteralPath $StateFile -Raw -Encoding UTF8 | ConvertFrom-Json
        # 5.1 的 ConvertFrom-Json 将 JSON 数组作为单个对象返回，显式枚举避免嵌套数组。
        foreach ($record in $records) { if ($null -ne $record) { Write-Output $record } }
    }
}

function Get-OwnedProcess($Record) {
    $process = Get-CimInstance Win32_Process -Filter "ProcessId=$([int]$Record.pid)"
    if (-not $process) { return $null }
    # 同时核对创建时间、可执行文件和命令行，避免 PID 被复用后误停其他服务。
    $created = $process.CreationDate.ToUniversalTime().ToString('o')
    if ($created -ne $Record.created -or $process.ExecutablePath -ine $Record.executable -or
        $process.CommandLine.IndexOf([string]$Record.marker, [StringComparison]::OrdinalIgnoreCase) -lt 0) {
        throw "PID $($Record.pid) 已不属于此启动记录，拒绝操作。"
    }
    return $process
}

function Stop-ProcessTree($Record) {
    $process = Get-OwnedProcess $Record
    if (-not $process) { return }
    # Windows venv 的 python.exe 会再启动实际解释器；先核对并停止后代，防止残留监听进程。
    $children = @(Get-CimInstance Win32_Process -Filter "ParentProcessId=$($process.ProcessId)")
    foreach ($child in $children) {
        if ($child.CreationDate -ge $process.CreationDate -and $child.CommandLine) {
            Stop-ProcessTree ([pscustomobject]@{pid=$child.ProcessId;created=$child.CreationDate.ToUniversalTime().ToString('o');executable=$child.ExecutablePath;marker=$child.CommandLine})
        }
    }
    $process = Get-OwnedProcess $Record
    if ($process) { Stop-Process -Id $process.ProcessId -ErrorAction Stop }
}

function Stop-Owned {
    foreach ($record in @(Read-State)) { Stop-ProcessTree $record }
    Save-State @()
    Write-Host '本目录启动的服务已停止。'
}

function Check-Configuration {
    Assert-Tools
    if (-not (Test-Path -LiteralPath $VenvPython)) { throw '请先执行 -Action Setup。' }
    foreach ($path in @("$Backend/.env", "$Agent/.env", "$Agent/dist/server.js", "$Frontend/node_modules/vite/bin/vite.js")) {
        if (-not (Test-Path -LiteralPath $path)) { throw "缺少 $path，请先执行 Setup 并填写配置。" }
    }
    # 只输出缺少的字段名，不回显配置值、数据库 URL 或模型密钥。
    $check = @'
from dotenv import dotenv_values
from ask_metric.core.config import Settings
from pydantic import ValidationError
values = dotenv_values('.env')
missing = [k for k in ('APP_DATABASE_URL','QUERY_DATABASE_URL','JWT_SECRET','MODEL_CHAT_API_KEY')
           if not (values.get(k) or '').strip() or '.example' in (values.get(k) or '')]
if missing:
    raise SystemExit('请配置 backend-next/.env 字段: ' + ', '.join(missing))
try:
    Settings()
except ValidationError as e:
    raise SystemExit('后端配置字段无效: ' + ', '.join('.'.join(map(str,x['loc'])) for x in e.errors()))
except Exception:
    raise SystemExit('后端配置加载失败，请检查本机配置及加密主密钥；不回显敏感值。') from None
print('后端配置格式通过（未连接数据库或模型）。')
'@
    Invoke-Checked $VenvPython @('-') $Backend $check
    $agentCheck = 'import {loadConfig} from "./dist/config.js"; try {loadConfig();console.log("Agent 配置格式通过（未调用模型）。")} catch {console.error("Agent 配置无效，请检查 .env 的模型、预算和鉴权字段。");process.exit(1)}'
    Invoke-Checked 'node' @('--env-file=.env', '--input-type=module', '-') $Agent $agentCheck
}

function Start-ServiceProcess([string]$Name, [string]$Program, [string]$Arguments, [string]$Directory, [string]$Marker, [hashtable]$Environment) {
    $previous = @{}
    try {
        foreach ($key in $Environment.Keys) {
            $previous[$key] = [Environment]::GetEnvironmentVariable($key, 'Process')
            [Environment]::SetEnvironmentVariable($key, $Environment[$key], 'Process')
        }
        $process = Start-Process -FilePath $Program -ArgumentList $Arguments -WorkingDirectory $Directory -WindowStyle Hidden -PassThru `
            -RedirectStandardOutput (Join-Path $Runtime "$Name.out.log") -RedirectStandardError (Join-Path $Runtime "$Name.err.log")
        $cim = Get-CimInstance Win32_Process -Filter "ProcessId=$($process.Id)"
        if (-not $cim) { throw "$Name 启动后退出，请检查 $Runtime 中对应日志。" }
        return [pscustomobject]@{name=$Name;pid=$process.Id;created=$cim.CreationDate.ToUniversalTime().ToString('o');executable=$cim.ExecutablePath;marker=$Marker}
    } finally {
        foreach ($key in $previous.Keys) { [Environment]::SetEnvironmentVariable($key, $previous[$key], 'Process') }
    }
}

function Wait-Http([string]$Url, $Record) {
    $deadline = [DateTime]::UtcNow.AddSeconds(45)
    do {
        if (-not (Get-OwnedProcess $Record)) { throw "$($Record.name) 已退出，请查看 $Runtime 中对应日志。" }
        try {
            $response = Invoke-WebRequest -Uri $Url -UseBasicParsing -TimeoutSec 2
            if ($response.StatusCode -eq 200) { return }
        } catch { }
        Start-Sleep -Milliseconds 500
    } while ([DateTime]::UtcNow -lt $deadline)
    throw "$($Record.name) 未在 45 秒内提供 HTTP 服务，请查看 $Runtime 中对应日志。"
}

try {
    switch ($Action) {
        'Setup' {
            Assert-Tools
            Invoke-Checked $Python @('-') $Root 'import sys; assert (3,11) <= sys.version_info[:2] <= (3,13), "需要 Python 3.11-3.13"'
            if (Get-Command uv -ErrorAction SilentlyContinue) {
                Invoke-Checked 'uv' @('sync', '--frozen', '--no-dev', '--python', $Python) $Backend
            } else {
                if (-not (Test-Path -LiteralPath $VenvPython)) { Invoke-Checked $Python @('-m', 'venv', '.venv') $Backend }
                Invoke-Checked $VenvPython @('-m', 'pip', 'install', '-e', '.') $Backend
            }
            foreach ($directory in @($Backend, $Agent)) {
                if (-not (Test-Path -LiteralPath "$directory/.env")) { Copy-Item -LiteralPath "$directory/.env.example" -Destination "$directory/.env" }
            }
            $keySetup = 'import secrets; from dotenv import dotenv_values,set_key; v=dotenv_values(".env"); [set_key(".env", k, secrets.token_urlsafe(48)) for k in ("JWT_SECRET",) if not (v.get(k) or "").strip()]'
            Invoke-Checked $VenvPython @('-') $Backend $keySetup
            Invoke-Checked 'npm.cmd' @('ci') $Agent
            Invoke-Checked 'npm.cmd' @('run', 'build') $Agent
            Invoke-Checked 'npm.cmd' @('ci') $Frontend
            Write-Host '安装完成。请填写 backend-next/.env、agent-service/.env，按 docs/Windows本机快速启动.md 准备数据库和账号，再执行 Check、Start。'
        }
        'Check' { Check-Configuration }
        'Start' {
            if (@($BackendPort, $AgentPort, $FrontendPort | Select-Object -Unique).Count -ne 3) { throw '三个服务必须使用不同端口。' }
            foreach ($record in @(Read-State)) {
                if (Get-OwnedProcess $record) { throw '本目录已有运行服务，请执行 Status 或 Stop。' }
            }
            Check-Configuration
            foreach ($port in @($BackendPort, $AgentPort, $FrontendPort)) {
                $listener = New-Object Net.Sockets.TcpListener([Net.IPAddress]::Loopback, $port)
                try { $listener.Start() } finally { $listener.Stop() }
            }
            [IO.Directory]::CreateDirectory($Runtime) | Out-Null
            $node = (Get-Command node).Source
            $records = @()
            try {
                $records += Start-ServiceProcess 'backend' $VenvPython "-m uvicorn ask_metric.main:app --app-dir src --host 127.0.0.1 --port $BackendPort --no-access-log" $Backend 'ask_metric.main:app' @{
                    CORS_ORIGINS="http://127.0.0.1:$FrontendPort,http://localhost:$FrontendPort"; LOG_FILE_ENABLED='false'; LOG_CONSOLE_ENABLED='true'
                }
                Save-State $records
                $records += Start-ServiceProcess 'agent' $node '--env-file=.env dist/server.js' $Agent 'dist/server.js' @{
                    AGENT_SERVICE_HOST='127.0.0.1'; AGENT_SERVICE_PORT="$AgentPort"; BACKEND_BASE_URL="http://127.0.0.1:$BackendPort"; AGENT_DATA_DIR=(Join-Path $Runtime 'agent')
                }
                Save-State $records
                $records += Start-ServiceProcess 'frontend' $node "node_modules/vite/bin/vite.js --host 127.0.0.1 --port $FrontendPort --strictPort" $Frontend 'node_modules/vite/bin/vite.js' @{
                    VITE_BACKEND_NEXT_BASE_URL="http://127.0.0.1:$BackendPort"; VITE_AGENT_SERVICE_BASE_URL="http://127.0.0.1:$AgentPort"
                }
                Save-State $records
                Wait-Http "http://127.0.0.1:$BackendPort/health" $records[0]
                Wait-Http "http://127.0.0.1:$AgentPort/health" $records[1]
                Wait-Http "http://127.0.0.1:$FrontendPort/" $records[2]
            } catch { Stop-Owned; throw }
            Write-Host "服务已启动：http://127.0.0.1:$FrontendPort  日志：$Runtime"
            try {
                $null = Invoke-RestMethod "http://127.0.0.1:$BackendPort/health/ready" -TimeoutSec 3
                Write-Host '后端就绪检查通过。请继续验证登录和真实业务查询。'
            } catch { Write-Warning 'HTTP 服务已启动，后端尚未就绪。请等待目录预热，并检查数据库、迁移和日志；当前结果不能代表问数可用。' }
        }
        'Stop' { Stop-Owned }
        'Status' {
            foreach ($record in @(Read-State)) {
                $running = [bool](Get-OwnedProcess $record)
                Write-Host "$($record.name): running=$running pid=$($record.pid)"
            }
        }
    }
} catch {
    Write-Error $_ -ErrorAction Continue
    exit 1
}
