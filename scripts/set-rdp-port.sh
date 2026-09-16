#!/bin/bash
PORT="$1"
reg add "HKLM\\System\\CurrentControlSet\\Control\\Terminal Server\\WinStations\\RDP-Tcp" /v PortNumber /t REG_DWORD /d $PORT /f
netsh advfirewall firewall add rule name="RDP $PORT" dir=in action=allow protocol=TCP localport=$PORT
net stop TermService
net start TermService
