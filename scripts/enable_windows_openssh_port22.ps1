try { Add-WindowsCapability -Online -Name OpenSSH.Server~~~~0.0.1.0 } catch { Write-Host "OpenSSH install warning: $($_.Exception.Message)" }
Set-Service -Name sshd -StartupType Automatic
Start-Service sshd
Remove-NetFirewallRule -Name "OpenSSH-Server-In-TCP" -ErrorAction SilentlyContinue
New-NetFirewallRule -Name "OpenSSH-Server-In-TCP" -DisplayName "OpenSSH Server (sshd)" -Enabled True -Direction Inbound -Protocol TCP -Action Allow -LocalPort 22
Get-Service sshd
netstat -ano | findstr :22
