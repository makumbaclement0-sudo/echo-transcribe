#!/usr/bin/env bash
# =============================================================================
# Echo — one-command setup for an Oracle Cloud "Always Free" Ubuntu ARM VM.
#
# Usage (on the VM, after SSH-ing in):
#   curl -fsSL <raw-url-of-this-script> -o oracle-setup.sh   # or scp it over
#   chmod +x oracle-setup.sh
#   REPO_URL="https://github.com/<you>/echo-transcribe.git" DOMAIN="" ./oracle-setup.sh
#
# Env vars you can pass:
#   REPO_URL  git URL to clone the app from (required on first run)
#   DOMAIN    optional hostname for automatic HTTPS (e.g. 1-2-3-4.sslip.io).
#             If empty, the app is served over plain HTTP on port 80.
# =============================================================================
set -euo pipefail

APP_BASE="/opt/echo"
APP_DIR="$APP_BASE/app"
DATA_DIR="$APP_BASE/data"
REPO_URL="${REPO_URL:-}"
DOMAIN="${DOMAIN:-}"
ME="$(whoami)"

echo "==> Installing system packages..."
sudo apt-get update -y
sudo apt-get install -y curl git ca-certificates python3 python3-venv python3-pip build-essential

echo "==> Installing Node.js 22..."
if ! command -v node >/dev/null 2>&1; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
  sudo apt-get install -y nodejs
fi
node --version

echo "==> Fetching the app..."
sudo mkdir -p "$APP_BASE"
sudo chown -R "$ME":"$ME" "$APP_BASE"
if [ -d "$APP_DIR/.git" ]; then
  git -C "$APP_DIR" pull --ff-only
elif [ -n "$REPO_URL" ]; then
  git clone "$REPO_URL" "$APP_DIR"
else
  echo "ERROR: $APP_DIR not found and REPO_URL not set. Pass REPO_URL=..." >&2
  exit 1
fi
mkdir -p "$DATA_DIR"
cd "$APP_DIR"

echo "==> Setting up Python + faster-whisper (this can take a few minutes)..."
python3 -m venv .venv
./.venv/bin/pip install --upgrade pip
./.venv/bin/pip install faster-whisper

echo "==> Building the Next.js app..."
npm ci
npm run build

echo "==> Writing environment file (if missing)..."
if [ ! -f "$APP_DIR/app.env" ]; then
  RANDPW="$(head -c 9 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c 12)"
  cat > "$APP_DIR/app.env" <<EOF
# Fill in ANTHROPIC_API_KEY, then: sudo systemctl restart echo
ANTHROPIC_API_KEY=
ANTHROPIC_MODEL=claude-sonnet-4-6
WHISPER_MODEL=base
WHISPER_DEVICE=cpu
PYTHON_BIN=$APP_DIR/.venv/bin/python3
DATA_DIR=$DATA_DIR
HF_HOME=$DATA_DIR/hf
PORT=3000
APP_USER=admin
APP_PASSWORD=$RANDPW
EOF
  echo "    Generated login -> admin / $RANDPW   (change in $APP_DIR/app.env)"
fi

echo "==> Creating systemd service 'echo'..."
sudo tee /etc/systemd/system/echo.service >/dev/null <<EOF
[Unit]
Description=Echo transcription app
After=network.target

[Service]
Type=simple
User=$ME
WorkingDirectory=$APP_DIR
EnvironmentFile=$APP_DIR/app.env
ExecStart=/usr/bin/node $APP_DIR/node_modules/next/dist/bin/next start -p 3000 -H 0.0.0.0
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF
sudo systemctl daemon-reload
sudo systemctl enable --now echo

echo "==> Opening the firewall (ports 80/443)..."
sudo iptables -I INPUT -p tcp --dport 80 -j ACCEPT || true
sudo iptables -I INPUT -p tcp --dport 443 -j ACCEPT || true
sudo netfilter-persistent save 2>/dev/null || sudo bash -c 'iptables-save > /etc/iptables/rules.v4' 2>/dev/null || true

echo "==> Setting up the web front-end..."
if [ -n "$DOMAIN" ]; then
  # Caddy = automatic HTTPS via Let's Encrypt.
  if ! command -v caddy >/dev/null 2>&1; then
    sudo apt-get install -y debian-keyring debian-archive-keyring apt-transport-https
    curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
    curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list >/dev/null
    sudo apt-get update -y
    sudo apt-get install -y caddy
  fi
  sudo tee /etc/caddy/Caddyfile >/dev/null <<EOF
$DOMAIN {
    reverse_proxy localhost:3000
}
EOF
  sudo systemctl restart caddy
  echo "    HTTPS site: https://$DOMAIN"
else
  # No domain: expose the app directly on port 80 via a tiny Caddy proxy.
  if ! command -v caddy >/dev/null 2>&1; then
    sudo apt-get install -y debian-keyring debian-archive-keyring apt-transport-https
    curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
    curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list >/dev/null
    sudo apt-get update -y
    sudo apt-get install -y caddy
  fi
  sudo tee /etc/caddy/Caddyfile >/dev/null <<EOF
:80 {
    reverse_proxy localhost:3000
}
EOF
  sudo systemctl restart caddy
  echo "    HTTP site: http://<your-VM-public-IP>"
fi

echo ""
echo "================================================================"
echo " Done. Next:"
echo "  1) Edit $APP_DIR/app.env and set ANTHROPIC_API_KEY (+ password)."
echo "  2) sudo systemctl restart echo"
echo "  3) Open your site (URL shown above)."
echo " Logs:  journalctl -u echo -f"
echo "================================================================"
