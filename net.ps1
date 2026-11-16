param()
try {
  $s1 = (Get-NetAdapterStatistics | Measure-Object -Property ReceivedBytes -Sum).Sum
  Start-Sleep -Milliseconds 400
  $s2 = (Get-NetAdapterStatistics | Measure-Object -Property ReceivedBytes -Sum).Sum
  Write-Output ([math]::Round((($s2 - $s1) / 0.4) / 1KB, 1))
} catch { Write-Output '0' }
