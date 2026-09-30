param([Parameter(Mandatory=$true)][string]$GhidraHome,[string]$Bundle)
$ErrorActionPreference='Stop'
$launcher=Join-Path $GhidraHome 'support/analyzeHeadless.bat'
if(-not (Test-Path -LiteralPath $launcher)){throw 'Ghidra headless launcher not found'}
Push-Location (Split-Path -Parent $PSScriptRoot)
try {
  $prepareArgs=@('scripts/prepare-ghidra-validation.mjs')
  if($Bundle){$prepareArgs+=$Bundle}
  $prepared=& node @prepareArgs
  if($LASTEXITCODE -ne 0){throw 'Unable to prepare the validation bundle'}
  $config=$prepared | ConvertFrom-Json
  $importLog=Join-Path $config.directory 'import.log'
  $importScriptLog=Join-Path $config.directory 'import-script.log'
  & $launcher $config.projects PSNValidation -scriptPath $config.scripts -preScript ImportPSNeighbourhood.java $config.bundle -postScript VerifyPSNImport.java -noanalysis -log $importLog -scriptlog $importScriptLog
  if($LASTEXITCODE -ne 0 -or -not (Select-String -LiteralPath $importScriptLog -Pattern 'PSN_IMPORT_VERIFIED' -Quiet)){throw 'Ghidra import verification failed; inspect the logs'}
  $analysisLog=Join-Path $config.directory 'analysis.log'
  $analysisScriptLog=Join-Path $config.directory 'analysis-script.log'
  & $launcher $config.projects PSNValidation -process $config.programName -scriptPath $config.scripts -postScript VerifyPSNImport.java -analysisTimeoutPerFile 60 -max-cpu 2 -log $analysisLog -scriptlog $analysisScriptLog
  if($LASTEXITCODE -ne 0 -or -not (Select-String -LiteralPath $analysisScriptLog -Pattern 'PSN_IMPORT_VERIFIED' -Quiet)){throw 'Ghidra reopen/analysis verification failed; inspect the logs'}
  if(Select-String -LiteralPath $analysisLog -Pattern 'REPORT: Analysis timed out|ERROR REPORT SCRIPT ERROR' -Quiet){throw 'Ghidra reported an incomplete verification'}
  Write-Output ('PASS Ghidra import, persisted program, analysis and byte/permission verification: '+$config.directory)
} finally {Pop-Location}
