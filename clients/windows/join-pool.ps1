# Add this Windows machine's GPU to a ShareGPU pool.
#
#   powershell -ExecutionPolicy Bypass -File join-pool.ps1 -Gateway http://gpu-box:8770
#
# There is no ShareGPU server to install here. A machine joins the pool by
# running Ollama and letting the gateway reach it -- the gateway routes whole
# requests to whichever machine holds the model, so nothing platform-specific
# is needed on this side.
param(
  [Parameter(Mandatory=$true)][string]$Gateway,
  [string]$Name = $env:COMPUTERNAME,
  [int]$Port = 11434
)

function Ok($m)   { Write-Host "  [ok] $m"   -ForegroundColor Green }
function Bad($m)  { Write-Host "  [!!] $m"   -ForegroundColor Red }
function Info($m) { Write-Host "  $m" }

Write-Host "`n== checking Ollama =="
if (-not (Get-Command ollama -ErrorAction SilentlyContinue)) {
  Bad "Ollama is not installed. Get it from https://ollama.com/download/windows"
  exit 1
}
Ok "ollama found: $((ollama --version) -join ' ')"

# Ollama binds loopback by default, so the gateway cannot see it until this is
# set. It is a machine-wide setting and needs a restart of the service.
Write-Host "`n== making Ollama reachable on the network =="
$current = [Environment]::GetEnvironmentVariable("OLLAMA_HOST", "User")
if ($current -ne "0.0.0.0:$Port") {
  [Environment]::SetEnvironmentVariable("OLLAMA_HOST", "0.0.0.0:$Port", "User")
  Ok "set OLLAMA_HOST=0.0.0.0:$Port (was '$current')"
  Info "Restart Ollama for this to take effect: quit it from the tray, then reopen."
} else { Ok "OLLAMA_HOST already 0.0.0.0:$Port" }

Write-Host "`n== firewall =="
$rule = Get-NetFirewallRule -DisplayName "Ollama ($Port)" -ErrorAction SilentlyContinue
if (-not $rule) {
  try {
    New-NetFirewallRule -DisplayName "Ollama ($Port)" -Direction Inbound -Protocol TCP `
      -LocalPort $Port -Action Allow -Profile Private | Out-Null
    Ok "allowed inbound TCP $Port on private networks"
  } catch { Bad "could not add a firewall rule -- run this as Administrator, or add it by hand" }
} else { Ok "firewall rule already present" }

Write-Host "`n== registering with the gateway =="
$ip = (Get-NetIPAddress -AddressFamily IPv4 |
       Where-Object { $_.IPAddress -notlike "127.*" -and $_.IPAddress -notlike "169.254.*" } |
       Select-Object -First 1).IPAddress
$url = "http://${ip}:$Port"
Info "this machine: $url"

try {
  $body = @{ url = $url; name = $Name } | ConvertTo-Json
  $resp = Invoke-RestMethod -Method Post -Uri "$Gateway/api/providers" `
            -ContentType "application/json" -Body $body -TimeoutSec 20
  Ok "registered as '$($resp.id)'"
} catch {
  Bad "could not register: $($_.Exception.Message)"
  Info "Add it from the gateway's dashboard instead: paste $url into 'Add a machine'."
  exit 1
}

Write-Host "`n== done =="
Info "Models you pull here (ollama pull <model>) become available on the pool."
Info "The gateway routes a request to whichever machine already holds the model,"
Info "so pull the ones this GPU can serve well and leave the rest to other hosts."
