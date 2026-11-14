param([string]$dir = 'up', [int]$steps = 1)
$sig = @'
using System;
using System.Runtime.InteropServices;
public class QfKey {
  [DllImport("user32.dll")] public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo);
}
'@
Add-Type -TypeDefinition $sig -ErrorAction Stop
$vk = if ($dir -eq 'up') { 0xAF } else { 0xAE }
for ($i = 0; $i -lt $steps; $i++) {
  [QfKey]::keybd_event([byte]$vk, 0, 0, [UIntPtr]::Zero)
  [QfKey]::keybd_event([byte]$vk, 0, 2, [UIntPtr]::Zero)
  Start-Sleep -Milliseconds 10
}
Write-Output "ok $dir $steps"
