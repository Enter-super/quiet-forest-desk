param([string]$path, [string]$out, [int]$index = 0)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public class QfIcon {
  [DllImport("shell32.dll", CharSet = CharSet.Unicode)]
  public static extern uint ExtractIconEx(string file, int index, IntPtr[] large, IntPtr[] small, uint count);
  [DllImport("user32.dll")] public static extern bool DestroyIcon(IntPtr h);
}
'@
try {
  $large = New-Object IntPtr[] 1
  $small = New-Object IntPtr[] 1
  $n = [QfIcon]::ExtractIconEx($path, $index, $large, $small, 1)
  if ($n -gt 0 -and $large[0] -ne [IntPtr]::Zero) {
    $ico = [System.Drawing.Icon]::FromHandle($large[0])
    $bmp = $ico.ToBitmap()
    $bmp.Save($out, [System.Drawing.Imaging.ImageFormat]::Png)
    $bmp.Dispose(); $ico.Dispose()
    [QfIcon]::DestroyIcon($large[0]) | Out-Null
    Write-Output ("OK " + $out)
    exit 0
  }
  # 退路：关联图标
  $ico2 = [System.Drawing.Icon]::ExtractAssociatedIcon($path)
  if ($ico2) {
    $ico2.ToBitmap().Save($out, [System.Drawing.Imaging.ImageFormat]::Png)
    $ico2.Dispose()
    Write-Output ("OK2 " + $out)
    exit 0
  }
  Write-Output 'FAIL'
} catch {
  Write-Output ('ERR ' + $_.Exception.Message)
  exit 1
}
