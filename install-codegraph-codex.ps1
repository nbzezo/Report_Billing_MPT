param(
  [switch]$InitCurrentProject
)

$ErrorActionPreference = "Stop"

Write-Host "Installing CodeGraph CLI..."
Invoke-RestMethod "https://raw.githubusercontent.com/colbymchenry/codegraph/main/install.ps1" | Invoke-Expression

Write-Host "Configuring CodeGraph for Codex globally..."
$codegraph = Get-Command codegraph -ErrorAction SilentlyContinue
if ($codegraph) {
  & codegraph install --target=codex --location=global --yes
} else {
  & npx -y @colbymchenry/codegraph install --target=codex --location=global --yes
}

if ($InitCurrentProject) {
  Write-Host "Initializing CodeGraph index for current project..."
  $codegraph = Get-Command codegraph -ErrorAction SilentlyContinue
  if ($codegraph) {
    & codegraph init
  } else {
    & npx -y @colbymchenry/codegraph init
  }
}

Write-Host ""
Write-Host "Done. Restart Codex to load the new CodeGraph skill/MCP config."
Write-Host "For each code project, run: codegraph init"
Write-Host "Or initialize this folder now by rerunning with: .\install-codegraph-codex.ps1 -InitCurrentProject"
