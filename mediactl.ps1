param([string]$action = 'playpause')
$sig = @'
using System;
using System.Runtime.InteropServices;
public class QfMedia {
  [DllImport("user32.dll")] public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo);
}
'@
Add-Type -TypeDefinition $sig -ErrorAction Stop
$vk = switch ($action) {
  'next' { 0xB0 }
  'prev' { 0xB1 }
  'stop' { 0xB2 }
  default { 0xB3 }
}
[QfMedia]::keybd_event([byte]$vk, 0, 0, [UIntPtr]::Zero)
[QfMedia]::keybd_event([byte]$vk, 0, 2, [UIntPtr]::Zero)
Write-Output "ok $action"
