#!/usr/bin/env bash
# ตั้ง launchd บน Mac ให้รัน pull-backups.sh ทุกวัน 09:30 (ถ้าเครื่องหลับอยู่ จะรันเมื่อตื่น) · รันซ้ำได้
# คัดลอกสคริปต์ไปไว้นอก ~/Documents เพราะ launchd ไม่มีสิทธิ์อ่าน ~/Documents (TCC) ถ้าไม่ให้ Full Disk Access
set -euo pipefail

LABEL=com.fridaymanage.backup-pull
BIN="$HOME/Library/Application Support/FridayManage"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOG="$HOME/Library/Logs/friday-backup-pull.log"

mkdir -p "$BIN" "$HOME/Library/LaunchAgents" "$HOME/Library/Logs"
install -m 755 "$(dirname "$0")/pull-backups.sh" "$BIN/pull-backups.sh"

cat >"$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array><string>/bin/bash</string><string>$BIN/pull-backups.sh</string></array>
  <key>StartCalendarInterval</key>
  <dict><key>Hour</key><integer>9</integer><key>Minute</key><integer>30</integer></dict>
  <key>StandardOutPath</key><string>$LOG</string>
  <key>StandardErrorPath</key><string>$LOG</string>
</dict>
</plist>
EOF

launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"
echo "ตั้งแล้ว: $PLIST · log: $LOG · ไฟล์: ~/FridayBackups/vps"
echo "รันทันที: launchctl kickstart gui/$(id -u)/$LABEL"
