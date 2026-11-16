# 各进程内存占用（按名字合并同名进程），输出 UTF-8
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$OutputEncoding = [Console]::OutputEncoding
try {
  $list = Get-Process |
    Where-Object { $_.WS -gt 0 } |
    Group-Object -Property ProcessName |
    ForEach-Object {
      [pscustomobject]@{
        name = $_.Name
        ws   = [int64](($_.Group | Measure-Object -Property WS -Sum).Sum)
      }
    } |
    Sort-Object ws -Descending |
    Select-Object -First 9
  Write-Output ($list | ConvertTo-Json -Compress)
} catch {
  Write-Output '[]'
}
