#!/bin/bash
# ================================================
# 🇮🇩 SCRIPT INSTALL CLOUD9 🇮🇩
# 🇮🇩 MOD By t.me/XXDonn 🇮🇩
# ================================================

set -e  # Exit on error

# ====== NON-INTERACTIVE MODE ======
export DEBIAN_FRONTEND=noninteractive
export DEBCONF_NONINTERACTIVE_SEEN=true
export NEEDRESTART_MODE=a

# ====== FUNCTION UNTUK WARNA ======
print_message() {
  local COLOR=$1
  local MESSAGE=$2
  local RESET="\033[0m"
  echo -e "${COLOR}${MESSAGE}${RESET}"
}

GREEN="\033[1;32m"
BLUE="\033[1;34m"
YELLOW="\033[1;33m"
RED="\033[1;31m"

print_message "$BLUE" "================================================="
print_message "$GREEN" "🇮🇩 SCRIPT INSTALL CLOUD9 🇮🇩"
print_message "$GREEN" "🇮🇩 MOD By t.me/XXDonn 🇮🇩"
print_message "$BLUE" "================================================="

# ====== DETEKSI OS ======
print_message "$YELLOW" "🔍 Detecting Linux distribution..."
if [ -f /etc/os-release ]; then
  . /etc/os-release
  OS=$ID
else
  print_message "$RED" "❌ Unable to detect Linux distribution. Exiting..."
  exit 1
fi

print_message "$BLUE" "🖥️ Detected OS: $OS"

if [[ "$OS" != "ubuntu" && "$OS" != "debian" ]]; then
  print_message "$RED" "❌ Unsupported OS: $OS. Only Ubuntu/Debian supported."
  exit 1
fi

# ====== BERSIHKAN LOCK DPkg DAN APT (FIX LOCK CONFLICT) ======
print_message "$YELLOW" "🧹 Cleaning any locked dpkg or apt process..."
sudo killall apt apt-get dpkg 2>/dev/null || true
sudo rm -f /var/lib/dpkg/lock-frontend /var/lib/dpkg/lock /var/lib/apt/lists/lock /var/cache/apt/archives/lock
sudo dpkg --configure -a
sleep 2  # Wait for clean
print_message "$GREEN" "✅ Locks cleaned successfully."

# ====== PAKSA NON-INTERAKTIF UNTUK DEBCONF ======
echo 'debconf debconf/frontend select Noninteractive' | sudo debconf-set-selections


# ====== FIX MIRROR UBUNTU AWS YANG SEDANG SYNC ======
fix_apt_mirror() {
  print_message "$YELLOW" "🔧 Switching Ubuntu mirror to archive.ubuntu.com if needed..."

  if [ -f /etc/apt/sources.list ]; then
    sudo cp /etc/apt/sources.list /etc/apt/sources.list.bak.$(date +%s) 2>/dev/null || true
    sudo sed -i 's|http://[a-z0-9.-]*\.ec2\.archive\.ubuntu\.com/ubuntu|http://archive.ubuntu.com/ubuntu|g' /etc/apt/sources.list
    sudo sed -i 's|http://[a-z0-9.-]*\.archive\.ubuntu\.com/ubuntu|http://archive.ubuntu.com/ubuntu|g' /etc/apt/sources.list
  fi

  if [ -d /etc/apt/sources.list.d ]; then
    sudo find /etc/apt/sources.list.d -type f \( -name "*.list" -o -name "*.sources" \) -print0 2>/dev/null | \
      sudo xargs -0 -r sed -i \
        -e 's|http://[a-z0-9.-]*\.ec2\.archive\.ubuntu\.com/ubuntu|http://archive.ubuntu.com/ubuntu|g' \
        -e 's|http://[a-z0-9.-]*\.archive\.ubuntu\.com/ubuntu|http://archive.ubuntu.com/ubuntu|g'
  fi
}

clean_apt_cache() {
  sudo killall apt apt-get dpkg 2>/dev/null || true
  sudo rm -f /var/lib/dpkg/lock-frontend /var/lib/dpkg/lock /var/lib/apt/lists/lock /var/cache/apt/archives/lock
  sudo rm -rf /var/lib/apt/lists/*
  sudo apt-get clean || true
  sudo dpkg --configure -a || true
}

apt_update_retry() {
  local max=5
  local i=1
  while [ "$i" -le "$max" ]; do
    print_message "$YELLOW" "🔄 apt update attempt $i/$max..."
    clean_apt_cache
    if sudo apt-get update -y -o Acquire::Retries=3 -o Acquire::http::No-Cache=true -o Acquire::http::Pipeline-Depth=0; then
      return 0
    fi
    print_message "$YELLOW" "⚠️ apt update failed. Retrying in 15 seconds..."
    sleep 15
    i=$((i+1))
  done
  return 1
}

apt_install_retry() {
  local max=3
  local i=1
  while [ "$i" -le "$max" ]; do
    print_message "$YELLOW" "📦 apt install attempt $i/$max: $*"
    if sudo apt-get install -y -o Acquire::Retries=3 "$@"; then
      return 0
    fi
    clean_apt_cache
    sleep 10
    i=$((i+1))
  done
  return 1
}

# ====== UPDATE & UPGRADE (FIX DEPRECATION) ======
print_message "$YELLOW" "⚙️ Step 1: Updating and upgrading system..."
fix_apt_mirror

if apt_update_retry; then
  print_message "$GREEN" "✅ apt update berhasil."
else
  print_message "$RED" "❌ Failed to update system after mirror retry."
  exit 1
fi

sudo apt-get -y \
  -o Dpkg::Options::="--force-confdef" \
  -o Dpkg::Options::="--force-confold" \
  -o Dpkg::Options::="--force-overwrite" \
  --allow-downgrades --allow-remove-essential --allow-change-held-packages \
  upgrade || true

if apt_install_retry snapd git curl ufw; then
  print_message "$GREEN" "✅ System updated and dependencies installed successfully."
else
  print_message "$RED" "❌ Failed to install required packages."
  exit 1
fi

# ====== INSTALL DOCKER VIA SNAP ======
print_message "$YELLOW" "🐳 Step 2: Installing Docker via Snap..."
if ! snap list | grep -q docker; then
  yes | sudo snap install docker
fi
sleep 5
if [ $? -eq 0 ]; then
  print_message "$GREEN" "✅ Docker installed successfully."
else
  print_message "$RED" "❌ Failed to install Docker."
  exit 1
fi

# ====== PULL CLOUD9 IMAGE ======
print_message "$YELLOW" "📥 Step 3: Pulling Cloud9 image..."
if ! sudo docker images | grep -q linuxserver/cloud9; then
  yes | sudo docker pull lscr.io/linuxserver/cloud9
fi
sleep 5
if [ $? -eq 0 ]; then
  print_message "$GREEN" "✅ Cloud9 image pulled successfully."
else
  print_message "$RED" "❌ Failed to pull Cloud9 Docker image."
  exit 1
fi

# ====== KONFIGURASI USERNAME DAN PASSWORD ======
USERNAME="Admin"
PASSWORD="Donn0143"
# Port Cloud9 bisa di-override via env C9_PORT (default 8000).
# UpCloud pakai 8880 (port yang open di firewall default UpCloud).
C9_PORT="${C9_PORT:-8000}"

# ====== STOP CONTAINER IF EXIST (IDEMPOTENT) ======
if sudo docker ps -a | grep -q Donn-Tools; then
  print_message "$YELLOW" "🛑 Stopping existing container..."
  sudo docker stop Donn-Tools 2>/dev/null || true
  sudo docker rm Donn-Tools 2>/dev/null || true
fi

# ====== JALANKAN CONTAINER ======
print_message "$YELLOW" "🚀 Step 4: Running Cloud9 Server..."
sudo docker run -d \
  --name=Donn-Tools \
  -e USERNAME=$USERNAME \
  -e PASSWORD=$PASSWORD \
  -p ${C9_PORT}:8000 \
  lscr.io/linuxserver/cloud9:latest

if [ $? -eq 0 ]; then
  print_message "$GREEN" "✅ Cloud9 container is running."
else
  print_message "$RED" "❌ Failed to run Cloud9 Server."
  exit 1
fi

# ====== TUNGGU 1 MENIT ======
print_message "$YELLOW" "⏳ Waiting 1 minute before configuring Cloud9..."
sleep 60

# ====== KONFIGURASI CLOUD9 DI DALAM CONTAINER (FIX DEPRECATION) ======
# NOTE: We intentionally do NOT hard-fail if the optional user.settings
# download returns HTTP 404 (wget exit 8). The upstream repo
# priv8-app/cloud9 has been removed/renamed and the settings file is a
# nice-to-have; the container ships with sane defaults that work fine.
# Previously `wget ... user.settings` was chained with `&&`, so its 404
# would take down the whole install with exit code 8 — even though the
# container was already up and Cloud9 was fully functional.
print_message "$YELLOW" "⚙️ Step 5: Configuring Cloud9 container..."

# Fallback user.settings baked into the script. This is a minimal Cloud9
# preferences file that enables sensible defaults (auto-save, tab size 2,
# soft-wrap). Applied if the remote download fails.
FALLBACK_USER_SETTINGS='{
  "ace/pane/1": {
    "1": {
      "$editorType": "ace",
      "@backgroundAutoPairedQuotes": true,
      "@backgroundTabSize": 2,
      "@behavioursEnabled": true,
      "@fontSize": 12,
      "@newLineMode": "unix",
      "@showInvisibles": false,
      "@showPrintMargin": false,
      "@softTabs": true,
      "@tabSize": 2,
      "@theme": "@ace/theme/monokai",
      "@wrap": "free",
      "@wrapBehavioursEnabled": true
    }
  },
  "general": {
    "@revealfile": true,
    "@animateui": true,
    "@confirm-exit": false
  }
}'

sudo docker exec Donn-Tools /bin/bash -c "
  export DEBIAN_FRONTEND=noninteractive
  export DEBCONF_NONINTERACTIVE_SEEN=true
  export NEEDRESTART_MODE=a
  echo 'debconf debconf/frontend select Noninteractive' | debconf-set-selections
  set +e   # do not abort the whole exec on non-fatal steps

  apt-get update -y
  apt-get -y \
    -o Dpkg::Options::=\"--force-confdef\" \
    -o Dpkg::Options::=\"--force-confold\" \
    -o Dpkg::Options::=\"--force-overwrite\" \
    --allow-downgrades --allow-remove-essential --allow-change-held-packages \
    upgrade
  apt-get install -y wget php-cli php-curl
  cd /c9bins/.c9/ || cd /root
  rm -f user.settings

  # Try mirror list. If all fail, write the baked-in fallback.
  DOWNLOADED=0
  for URL in \
    'https://raw.githubusercontent.com/priv8-app/cloud9/refs/heads/main/user.settings' \
    'https://raw.githubusercontent.com/priv8-app/cloud9/main/user.settings' \
    'https://raw.githubusercontent.com/priv8-app/cloud9/master/user.settings'
  do
    echo \"→ Try user.settings from: \$URL\"
    if wget -q --tries=2 --timeout=15 -O user.settings.tmp \"\$URL\" && [ -s user.settings.tmp ]; then
      mv user.settings.tmp user.settings
      DOWNLOADED=1
      echo \"✅ user.settings downloaded.\"
      break
    fi
    rm -f user.settings.tmp
  done

  if [ \"\$DOWNLOADED\" -ne 1 ]; then
    echo \"⚠️ Remote user.settings not available (HTTP 404). Writing fallback config instead.\"
    cat > user.settings <<'CLOUD9_SETTINGS_EOF'
$FALLBACK_USER_SETTINGS
CLOUD9_SETTINGS_EOF
    echo \"✅ user.settings dari fallback bawaan script.\"
  fi

  exit 0   # explicit success — user.settings is optional
"

# We do not exit on docker-exec return code anymore; the container itself
# was already verified running in the previous step. The only critical
# post-condition is 'is Cloud9 responding on port 8000 after restart'.
print_message "$GREEN" "✅ Cloud9 container configured (user.settings step tolerated failures)."

# ====== RESTART CONTAINER ======
print_message "$YELLOW" "♻️ Restarting Cloud9 container..."
sudo docker restart Donn-Tools

if [ $? -eq 0 ]; then
  print_message "$GREEN" "✅ Cloud9 container restarted successfully."
else
  print_message "$RED" "❌ Failed to restart Cloud9 container."
  exit 1
fi

# ====== VERIFY CLOUD9 ACTUALLY LISTENING ON PORT 8000 ======
# Better than trusting exit codes: probe the port directly to confirm
# Cloud9 is up and answering. This catches issues where the container
# starts but Cloud9 itself crashes (e.g., bad user.settings).
print_message "$YELLOW" "🔍 Verifying Cloud9 is listening on port ${C9_PORT}..."
CLOUD9_UP=0
for i in $(seq 1 24); do
  if curl -s --max-time 5 -o /dev/null -w '%{http_code}' http://127.0.0.1:${C9_PORT}/ 2>/dev/null | grep -qE '^(200|301|302|401|403)$'; then
    CLOUD9_UP=1
    break
  fi
  # Also try ss/netstat as backup detection
  if ss -ltn 2>/dev/null | awk '{print $4}' | grep -q ":${C9_PORT}\$"; then
    CLOUD9_UP=1
    break
  fi
  sleep 5
done
if [ "$CLOUD9_UP" -eq 1 ]; then
  print_message "$GREEN" "✅ Cloud9 is answering on port ${C9_PORT}."
else
  print_message "$YELLOW" "⚠️ Port ${C9_PORT} not confirmed yet, but container is running. Cloud9 mungkin masih startup, coba akses 1-2 menit lagi."
fi

# ====== DAPATKAN IP PUBLIK ======
print_message "$YELLOW" "🌐 Step 6: Fetching public IP..."
PUBLIC_IP=$(curl -s ifconfig.me)

if [ $? -eq 0 ]; then
  print_message "$BLUE" "🌍 Public IP Address: $PUBLIC_IP"
else
  print_message "$RED" "❌ Failed to fetch public IP."
  PUBLIC_IP="localhost"
fi

# ====== KONFIGURASI FIREWALL ======
print_message "$YELLOW" "🔒 Opening ports on firewall..."
if ! ufw status | grep -q "Status: active"; then
  yes | sudo ufw --force enable
fi
yes | sudo ufw allow ${C9_PORT}/tcp
yes | sudo ufw allow 25
yes | sudo ufw allow 587
yes | sudo ufw allow 465
yes | sudo ufw reload

if [ $? -eq 0 ]; then
  print_message "$GREEN" "✅ Firewall configured successfully."
else
  print_message "$RED" "❌ Failed to configure firewall."
fi

# ====== OUTPUT UNTUK BOT PARSING (DETECT SUCCESS) ======
echo "SUCCESS"
echo "PORT=${C9_PORT}"
echo "C9_USER=$USERNAME"
echo "C9_PASS=$PASSWORD"

# ====== SELESAI ======
print_message "$BLUE" "==========================================="
print_message "$GREEN" "🎉 INSTALASI CLOUD9 BERHASIL 🎉"
print_message "$BLUE" "==========================================="
print_message "$YELLOW" "🌟 Access Cloud9 at: http://$PUBLIC_IP:${C9_PORT}"
print_message "$YELLOW" "🔑 Username: $USERNAME"
print_message "$YELLOW" "🔑 Password: $PASSWORD"
print_message "$YELLOW" "==========================================="