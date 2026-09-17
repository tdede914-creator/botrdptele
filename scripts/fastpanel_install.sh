#!/bin/bash
# ================================================
# 🇮🇩 SCRIPT INSTALL FASTPANEL 🇮🇩
# 🇮🇩 MOD By t.me/XXDonn 🇮🇩
# ================================================
# Design principle: match the OFFICIAL manual install as closely as possible.
# On a fresh DO/Linode/AWS Ubuntu image the manual install:
#     wget http://repo.fastpanel.direct/install_fastpanel.sh -O - | bash -
# works perfectly. Our bot version only adds:
#   1. Waiting for cloud-init & apt locks (cloud VMs boot with these still running)
#   2. Parsing Login/Password from installer output for the bot to relay
#   3. Optional password reset via mogwai for a user-supplied password
#   4. Canonical SUCCESS/PORT/FP_USER/FP_PASS/FP_URL trailer for the bot parser
#
# It intentionally does NOT purge packages or run apt upgrade — Fastpanel's
# own installer will refuse a dirty OS, but our images are clean, and
# heavy pre-cleanup was racing with cloud-init and causing the very failures
# we were trying to prevent.
# ================================================

# Do NOT use `set -e`. We want to see errors, not abort on the first non-zero.
set -uo pipefail

# ====== NON-INTERACTIVE MODE ======
export DEBIAN_FRONTEND=noninteractive
export DEBCONF_NONINTERACTIVE_SEEN=true
export NEEDRESTART_MODE=a

# ====== COLORS ======
GREEN="\033[1;32m"
BLUE="\033[1;34m"
YELLOW="\033[1;33m"
RED="\033[1;31m"
RESET="\033[0m"
say() { echo -e "${1}${2}${RESET}"; }

# ====== ALLOW OVERRIDES FROM ENV ======
FP_USER_INPUT="${FP_USER:-}"
FP_PASS_INPUT="${FP_PASS:-}"

say "$BLUE" "================================================="
say "$GREEN" "🚀 INSTALL FASTPANEL"
say "$GREEN" "🇮🇩 MOD By t.me/XXDonn 🇮🇩"
say "$BLUE" "================================================="

# ====== ROOT CHECK ======
if [ "$(id -u)" -ne 0 ]; then
  say "$RED" "❌ Script harus dijalankan sebagai root."
  exit 1
fi

# ====== OS DETECTION ======
say "$YELLOW" "🔍 Detecting Linux distribution..."
if [ -f /etc/os-release ]; then
  . /etc/os-release
  OS_ID=$ID
  OS_VER=${VERSION_ID%%.*}
else
  say "$RED" "❌ Cannot detect OS."
  exit 1
fi
say "$BLUE" "🖥️ Detected OS: $OS_ID $VERSION_ID"

case "$OS_ID" in
  ubuntu)
    if [[ "$OS_VER" != "20" && "$OS_VER" != "22" && "$OS_VER" != "24" ]]; then
      say "$RED" "❌ Ubuntu $VERSION_ID tidak didukung Fastpanel. Gunakan 20.04/22.04/24.04."
      exit 1
    fi
    ;;
  debian)
    if [[ "$OS_VER" != "10" && "$OS_VER" != "11" && "$OS_VER" != "12" ]]; then
      say "$RED" "❌ Debian $VERSION_ID tidak didukung Fastpanel. Gunakan 10/11/12."
      exit 1
    fi
    ;;
  *)
    say "$RED" "❌ OS $OS_ID tidak didukung Fastpanel. Hanya Ubuntu/Debian."
    exit 1
    ;;
esac

# ====== WAIT FOR CLOUD-INIT ======
# DO / Linode / AWS Ubuntu images run cloud-init on first boot which itself
# triggers unattended-upgrades. If we start apt while cloud-init is still
# running, dpkg lock is held and everything downstream breaks.
if command -v cloud-init >/dev/null 2>&1; then
  say "$YELLOW" "⏳ Waiting for cloud-init to finish (max 5 minutes)..."
  timeout 300 cloud-init status --wait >/dev/null 2>&1 || \
    say "$YELLOW" "⚠️ cloud-init masih jalan setelah 5 menit, lanjut coba install."
fi

# ====== WAIT FOR DPKG / APT LOCKS ======
say "$YELLOW" "⏳ Waiting for apt/dpkg locks to release (max 3 minutes)..."
LOCK_DEADLINE=$(( $(date +%s) + 180 ))
while : ; do
  if fuser /var/lib/dpkg/lock-frontend >/dev/null 2>&1 || \
     fuser /var/lib/dpkg/lock          >/dev/null 2>&1 || \
     fuser /var/lib/apt/lists/lock     >/dev/null 2>&1; then
    if [ "$(date +%s)" -ge "$LOCK_DEADLINE" ]; then
      say "$YELLOW" "⚠️ apt lock masih ditahan proses lain, coba lanjut."
      break
    fi
    sleep 5
  else
    break
  fi
done

# ====== INSTALL wget IF MISSING (usually already present) ======
if ! command -v wget >/dev/null 2>&1; then
  say "$YELLOW" "📦 Installing wget (missing)..."
  apt-get update -y -o Acquire::Retries=3 >/dev/null 2>&1 || true
  apt-get install -y wget || {
    say "$RED" "❌ Gagal install wget."
    exit 1
  }
fi

# ====== DOWNLOAD OFFICIAL INSTALLER ======
say "$YELLOW" "⬇️ Downloading Fastpanel installer..."
INSTALLER=/tmp/install_fastpanel.sh
rm -f "$INSTALLER"

FP_MIRRORS=(
  "http://repo.fastpanel.direct/install_fastpanel.sh"
  "https://repo.fastpanel.direct/install_fastpanel.sh"
)
DOWNLOADED=0
for url in "${FP_MIRRORS[@]}"; do
  say "$YELLOW" "→ Try: $url"
  if wget -q --tries=3 --timeout=60 "$url" -O "$INSTALLER" && [ -s "$INSTALLER" ]; then
    DOWNLOADED=1
    break
  fi
done

if [ "$DOWNLOADED" -ne 1 ]; then
  say "$RED" "❌ Gagal download install_fastpanel.sh dari semua mirror."
  say "$YELLOW" "Repo status:"
  curl -sSI --max-time 10 http://repo.fastpanel.direct/ | head -5 || echo "(unreachable)"
  exit 1
fi

chmod +x "$INSTALLER"

# ====== DETECT INSTALLER FLAGS SUPPORT ======
FP_ARGS=""
if grep -qE '(^|[^A-Za-z0-9])-u[^A-Za-z0-9]' "$INSTALLER" 2>/dev/null && \
   grep -qE '(^|[^A-Za-z0-9])-p[^A-Za-z0-9]' "$INSTALLER" 2>/dev/null; then
  if [ -n "$FP_USER_INPUT" ] && [ -n "$FP_PASS_INPUT" ]; then
    FP_ARGS="-u $FP_USER_INPUT -p $FP_PASS_INPUT"
  fi
fi

# ====== RUN THE INSTALLER ======
say "$YELLOW" "🚀 Running Fastpanel installer (8-15 minutes)..."
INSTALL_LOG=/tmp/fastpanel_install.log
: > "$INSTALL_LOG"

# NOTE: no `set -e`. We check exit code manually so we can dump logs.
bash "$INSTALLER" $FP_ARGS 2>&1 | tee "$INSTALL_LOG"
FP_RC=${PIPESTATUS[0]}

# ====== ON FAILURE: DUMP DIAGNOSTICS AND STOP ======
if [ "$FP_RC" -ne 0 ]; then
  say "$RED" "❌ Fastpanel installer exit code: $FP_RC"

  say "$YELLOW" "== Tail runner log (last 150 lines) =="
  tail -n 150 "$INSTALL_LOG" || true

  for LOG_FILE in \
    /var/log/fastpanel-install.log \
    /var/log/fastpanel/install.log \
    /var/log/fastpanel.log \
    /var/log/fastpanel/mogwai-install.log
  do
    if [ -f "$LOG_FILE" ]; then
      say "$YELLOW" "== $LOG_FILE (last 100 lines) =="
      tail -n 100 "$LOG_FILE" || true
    fi
  done

  say "$YELLOW" "== Recent dpkg errors =="
  grep -iE "error|fail|conflict" /var/log/dpkg.log 2>/dev/null | tail -n 30 || true

  say "$YELLOW" "== Preinstalled packages that Fastpanel considers conflicts =="
  dpkg -l 2>/dev/null | grep -iE 'apache|nginx|mysql|mariadb|php|proftpd|dovecot|exim|postfix' | head -30 || true

  say "$YELLOW" "== Disk / Memory =="
  df -h / | tail -n 2 || true
  free -m || true

  say "$YELLOW" "== Fastpanel repo reachability =="
  curl -sSI --max-time 10 http://repo.fastpanel.direct/ | head -5 || echo "(unreachable)"

  exit 1
fi

# ====== PARSE CREDENTIALS FROM INSTALL LOG ======
say "$YELLOW" "🔎 Parsing credentials..."
PARSED_USER=$(grep -Eo 'Login:[[:space:]]*[^[:space:]]+' "$INSTALL_LOG" | tail -n1 | sed -E 's/Login:[[:space:]]*//')
PARSED_PASS=$(grep -Eo 'Password:[[:space:]]*[^[:space:]]+' "$INSTALL_LOG" | tail -n1 | sed -E 's/Password:[[:space:]]*//')
PARSED_URL=$(grep -Eo 'https?://[^[:space:]]+:8888[^[:space:]]*' "$INSTALL_LOG" | tail -n1)

# ====== DECIDE FINAL USER / PASSWORD ======
FINAL_USER="${FP_USER_INPUT:-${PARSED_USER:-fastuser}}"
if [ -n "$FP_PASS_INPUT" ]; then
  FINAL_PASS="$FP_PASS_INPUT"
else
  FINAL_PASS="${PARSED_PASS:-}"
fi

# ====== ATTEMPT PASSWORD RESET IF USER-PROVIDED ======
# Only touch mogwai if user provided a specific password AND it differs from
# what installer printed. Skip if we're using installer-generated password
# (safer than risking mogwai flag differences between versions).
if [ -n "$FP_PASS_INPUT" ] && [ "$FP_PASS_INPUT" != "$PARSED_PASS" ] && command -v mogwai >/dev/null 2>&1; then
  say "$YELLOW" "🔐 Setting Fastpanel password via mogwai..."
  CHANGE_OK=0
  # Attempt 1: newer syntax
  if mogwai users change-password --username "$FINAL_USER" --password "$FINAL_PASS" >/dev/null 2>&1; then
    CHANGE_OK=1
  fi
  # Attempt 2: positional args
  if [ "$CHANGE_OK" -ne 1 ]; then
    if mogwai users change-password "$FINAL_USER" "$FINAL_PASS" >/dev/null 2>&1; then
      CHANGE_OK=1
    fi
  fi
  if [ "$CHANGE_OK" -ne 1 ]; then
    say "$YELLOW" "⚠️ mogwai password reset gagal, fallback ke password installer-generated."
    FINAL_USER="${PARSED_USER:-$FINAL_USER}"
    FINAL_PASS="${PARSED_PASS:-$FINAL_PASS}"
  fi
fi

# ====== FIREWALL: OPEN PORT 8888 IF UFW ACTIVE ======
if command -v ufw >/dev/null 2>&1; then
  ufw allow 8888/tcp >/dev/null 2>&1 || true
  ufw allow 80/tcp   >/dev/null 2>&1 || true
  ufw allow 443/tcp  >/dev/null 2>&1 || true
fi

# ====== VERIFY PORT 8888 IS LISTENING ======
say "$YELLOW" "🔍 Verifying Fastpanel service on port 8888..."
LISTEN_OK=0
for i in $(seq 1 24); do
  if ss -ltn 2>/dev/null | awk '{print $4}' | grep -q ':8888$' \
     || curl -sk --max-time 5 -o /dev/null -w '%{http_code}' https://127.0.0.1:8888/ | grep -qE '^(200|301|302|401|403)$'; then
    LISTEN_OK=1
    break
  fi
  sleep 5
done

if [ "$LISTEN_OK" -ne 1 ]; then
  say "$YELLOW" "⚠️ Port 8888 belum listening, tapi installer sukses. Tunggu 1-2 menit sebelum akses UI."
fi

# ====== PUBLIC IP ======
PUBLIC_IP=$(curl -s --max-time 5 ifconfig.me || curl -s --max-time 5 api.ipify.org || hostname -I | awk '{print $1}')
FINAL_URL="${PARSED_URL:-https://${PUBLIC_IP:-127.0.0.1}:8888/}"

# ====== SAVE CREDENTIALS FILE ======
CRED_FILE=/root/.fastpanel_credentials
umask 077
{
  echo "FASTPANEL_URL=$FINAL_URL"
  echo "FASTPANEL_USER=$FINAL_USER"
  echo "FASTPANEL_PASS=$FINAL_PASS"
} > "$CRED_FILE"

# ====== CANONICAL OUTPUT FOR BOT PARSER ======
echo "SUCCESS"
echo "PORT=8888"
echo "FP_USER=$FINAL_USER"
echo "FP_PASS=$FINAL_PASS"
echo "FP_URL=$FINAL_URL"

say "$BLUE" "==========================================="
say "$GREEN" "🎉 INSTALASI FASTPANEL BERHASIL"
say "$BLUE" "==========================================="
say "$YELLOW" "🌟 URL     : $FINAL_URL"
say "$YELLOW" "👤 User    : $FINAL_USER"
say "$YELLOW" "🔑 Password: $FINAL_PASS"
say "$YELLOW" "==========================================="
