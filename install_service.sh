#!/usr/bin/env bash
#
# Installs tutordb as a systemd service so it:
#   - starts automatically on boot
#   - restarts automatically if it crashes
#   - keeps running after you close PowerShell/SSH, since it's no longer
#     a child process of your shell session at all
#
# Run this ON THE ODROID, from inside the project folder:
#   chmod +x install_service.sh
#   ./install_service.sh
#
# It needs sudo (to write a systemd unit file and control the service).
# You'll be prompted for your password.

set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SERVICE_USER="$(whoami)"
PYTHON_BIN="$(command -v python3)"
SERVICE_FILE="/etc/systemd/system/tutordb.service"

if [ ! -f "$APP_DIR/app.py" ]; then
  echo "Couldn't find app.py in $APP_DIR -- run this from inside the tutordb project folder."
  exit 1
fi

echo "Installing tutordb as a systemd service..."
echo "  App directory: $APP_DIR"
echo "  Running as user: $SERVICE_USER"
echo "  Python: $PYTHON_BIN"
echo ""

sudo tee "$SERVICE_FILE" > /dev/null <<EOF
[Unit]
Description=TutorDB Flask app
After=network.target

[Service]
User=$SERVICE_USER
WorkingDirectory=$APP_DIR
ExecStart=$PYTHON_BIN $APP_DIR/app.py
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable tutordb
sudo systemctl restart tutordb

echo ""
echo "Done. tutordb is now running as a background service."
echo ""
echo "Useful commands:"
echo "  sudo systemctl status tutordb     # check it's running"
echo "  journalctl -u tutordb -f          # watch live logs (Ctrl+C to stop watching)"
echo "  sudo systemctl restart tutordb    # restart it (e.g. after pulling new code)"
echo "  sudo systemctl stop tutordb       # stop it"
echo ""
echo "You can now close PowerShell/SSH entirely -- it'll keep running."
