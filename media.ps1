# 输出必须是 UTF-8，否则中文标题经管道到 Node 会变成乱码（GBK 被当 UTF-8 读）
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$OutputEncoding = [Console]::OutputEncoding

Add-Type -AssemblyName System.Runtime.WindowsRuntime

$asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
  $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
})[0]

function Await($op, $type) {
  $t = $asTaskGeneric.MakeGenericMethod($type).Invoke($null, @($op))
  $t.Wait(-1) | Out-Null
  $t.Result
}

try {
  $null = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager, Windows.Media.Control, ContentType = WindowsRuntime]
  $mgr = Await ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager]::RequestAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager])
  $s = $mgr.GetCurrentSession()
  if (-not $s) { Write-Output '{}'; exit }
  $p = Await ($s.TryGetMediaPropertiesAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties])
  $tl = $s.GetTimelineProperties()
  $pb = $s.GetPlaybackInfo()
  $o = [ordered]@{
    title   = [string]$p.Title
    artist  = [string]$p.Artist
    app     = [string]$s.SourceAppUserModelId
    pos     = [int]$tl.Position.TotalSeconds
    dur     = [int]$tl.EndTime.TotalSeconds
    playing = ($pb.PlaybackStatus -eq 4)
  }
  Write-Output ($o | ConvertTo-Json -Compress)
} catch {
  Write-Output ('{"error":"' + ($_.Exception.Message -replace '"','') + '"}')
}
