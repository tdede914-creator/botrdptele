#!/bin/bash

#+
# tele.sh bisa dipanggil dengan 2 argumen:
#   tele.sh <password> <img_version | direct .gz URL>
# atau tanpa argumen dengan env:
#   WIN_PASS="..." IMG_VERSION="..." tele.sh
#

# Ambil password & versi OS dari argumen atau environment
if [ "$#" -ne 2 ]; then
  if [ -n "$WIN_PASS" ] && [ -n "$IMG_VERSION" ]; then
    PASSWORD="$WIN_PASS"
    # IMG_VERSION sudah tersedia dari env
  else
    echo "Usage: $0 <password> <img_version | direct .gz URL>"
  echo "Available img_version:"
  echo " win_10atlas, win_10ghost, win_22, win_19, win_12"
  echo " win_2008, win_2012R2, win_2016, win_2019, win_7, win_10_ent, win_11_pro"
  echo " win_2022_lite, win_2016_lite, win_2012R2_lite, win_7_sp1_lite"
  echo " win_2012R2_uefi, win_2016_uefi, win_2019_uefi, win_2022_uefi, win_10_uefi, win_11_uefi, win_2025"
  echo "Or provide a direct image URL (must contain .gz)"
  exit 1
  fi
else
  PASSWORD=$1
  IMG_VERSION=$2
fi

# Cek apakah IMG_VERSION adalah URL langsung yang mengandung .gz
if [[ "$IMG_VERSION" =~ ^https?://.*\.gz.*$ ]]; then
  IMG_URL="$IMG_VERSION"
else
  # Mapping img_version ke URL
  case $IMG_VERSION in
    win_10atlas)
      IMG_URL="http://103.93.132.217/win10ghost.gz"
      ;;
    win_10ghost)
      IMG_URL="http://103.93.132.217/win10ghost.gz"
      ;;
    win_22)
      IMG_URL="http://103.93.132.217/win2022.gz"
      ;;
    win_19)
      IMG_URL="http://103.93.132.217/win2019.gz"
      ;;
    # Standard Versions
    win_2008)
      IMG_URL="http://103.93.132.217/win2008.gz"
      ;;
    win_2012R2)
      IMG_URL="http://103.93.132.217/win2012.gz"
      ;;
    win_2016)
      IMG_URL="http://103.93.132.217/win2016.gz"
      ;;
    win_2019)
      IMG_URL="http://103.93.132.217/win2019.gz"
      ;;
    win_7)
      IMG_URL="http://103.93.132.217/win7.gz"
      ;;
    win_10_ent)
      IMG_URL="http://103.93.132.217/windows10ent.gz"
      ;;
    win_11_pro)
      IMG_URL="http://103.93.132.217/windows11pro.gz"
      ;;
    # Lite Versions
    win_2022_lite)
      IMG_URL="http://103.93.132.217/win2022.gz"
      ;;
    win_2016_lite)
      IMG_URL="http://103.93.132.217/win2016.gz"
      ;;
    win_2012R2_lite)
      IMG_URL="http://103.93.132.217/win2012.gz"
      ;;
    win_7_sp1_lite)
      IMG_URL="https://byte.meocloud.my.id/11:/win7lite.gz"
      ;;
    # UEFI Versions
    win_2012R2_uefi)
      IMG_URL="http://103.93.132.217/win2012.gz"
      ;;
    win_2016_uefi)
      IMG_URL="http://103.93.132.217/win2016.gz"
      ;;
    win_2019_uefi)
      IMG_URL="http://103.93.132.217/win2019.gz"
      ;;
    win_2022_uefi)
      IMG_URL="https://byte.meocloud.my.id/13:/UEFI/Windows2022_UEFI.gz"
      ;;
    win_10_uefi)
      IMG_URL="http://103.93.132.217/windows10ent.gz"
      ;;
    win_11_uefi)
      IMG_URL="http://103.93.132.217/windows11pro.gz"
      ;;
    win_2025)
      IMG_URL="https://files.meocloud.my.id/10:/windows2025.gz"
      ;;
    *)
      echo "Invalid img_version or unsupported URL format."
      echo "Use one of: win_10atlas, win_10ghost, win_22, win_19, win_12, win_2008, win_2012R2, win_2016,"
      echo "win_2019, win_7, win_10_ent, win_11_pro, win_2022_lite, win_2016_lite,"
      echo "win_2012R2_lite, win_7_sp1_lite, win_2012R2_uefi, win_2016_uefi, win_2019_uefi,"
      echo "win_2022_uefi, win_10_uefi, win_11_uefi, win_2025"
      echo "Or provide a direct .gz URL"
      exit 1
      ;;
  esac
fi

echo "Starting Dedicated RDP installation..."
echo "OS: $IMG_VERSION"
echo "Image URL: $IMG_URL"

# Provider/disk compatibility helper.
# Linode sering memakai layout disk berbeda dari DigitalOcean, dan cloud-init/apt lock
# bisa membuat reinstall gagal kalau script dijalankan terlalu cepat.
detect_provider() {
  local p="${INSTALL_PROVIDER:-}"
  if [ -z "$p" ]; then
    p="$(cat /sys/class/dmi/id/product_name 2>/dev/null) $(cat /sys/class/dmi/id/sys_vendor 2>/dev/null)"
  fi
  echo "$p" | tr '[:upper:]' '[:lower:]'
}

PROVIDER_DETECTED="$(detect_provider)"
IS_LINODE=0
case "$PROVIDER_DETECTED" in
  *linode*) IS_LINODE=1 ;;
esac

if [ "$IS_LINODE" = "1" ]; then
  echo "Provider detected: Linode"
else
  echo "Provider detected: ${PROVIDER_DETECTED:-unknown}"
fi

# Tunggu cloud-init selesai jika ada. Ini mencegah apt/dpkg lock pada VPS baru.
if command -v cloud-init >/dev/null 2>&1; then
  echo "Waiting for cloud-init to finish..."
  cloud-init status --wait >/dev/null 2>&1 || true
fi

# Tunggu lock apt/dpkg maksimum 5 menit.
LOCK_WAIT=0
while fuser /var/lib/dpkg/lock-frontend >/dev/null 2>&1 || \
      fuser /var/lib/dpkg/lock >/dev/null 2>&1 || \
      fuser /var/lib/apt/lists/lock >/dev/null 2>&1; do
  if [ "$LOCK_WAIT" -ge 300 ]; then
    echo "APT lock still active, continue anyway..."
    break
  fi
  echo "Waiting apt/dpkg lock..."
  sleep 10
  LOCK_WAIT=$((LOCK_WAIT+10))
done

# Pastikan tool dasar tersedia.
if command -v apt-get >/dev/null 2>&1; then
  DEBIAN_FRONTEND=noninteractive apt-get update -y >/dev/null 2>&1 || true
  DEBIAN_FRONTEND=noninteractive apt-get install -y curl wget ca-certificates gzip xz-utils zstd util-linux parted fdisk python3 >/dev/null 2>&1 || true
fi

# Pakai reinstall.sh lokal yang diupload bot jika tersedia. Kalau tidak ada, download.
if [ -s /root/reinstall.sh ]; then
  echo "Using local reinstall.sh uploaded by bot..."
  if [ "$(readlink -f /root/reinstall.sh 2>/dev/null)" != "$(readlink -f ./reinstall.sh 2>/dev/null)" ]; then
    cp /root/reinstall.sh ./reinstall.sh
  fi
else
  echo "Downloading reinstall.sh..."
  curl -fsSL -o reinstall.sh https://raw.githubusercontent.com/bin456789/reinstall/main/reinstall.sh || \
  curl -fsSL -o reinstall.sh https://raw.githubusercontent.com/kripul/reinstall/main/reinstall.sh || \
  wget -O reinstall.sh https://raw.githubusercontent.com/bin456789/reinstall/main/reinstall.sh || \
  wget -O reinstall.sh https://raw.githubusercontent.com/kripul/reinstall/main/reinstall.sh
fi

if [ ! -s "reinstall.sh" ]; then
  echo "Failed to prepare reinstall.sh"
  exit 1
fi

chmod +x reinstall.sh

# Linode umumnya lebih aman dipaksa legacy BIOS, kecuali VPS boot lewat EFI.
FORCE_ARGS=""
if [ "$IS_LINODE" = "1" ]; then
  if [ -d /sys/firmware/efi ]; then
    FORCE_ARGS="--force efi"
    echo "Linode boot mode: EFI"
  else
    FORCE_ARGS="--force bios"
    echo "Linode boot mode: BIOS/Legacy"
  fi
fi

# Validasi URL image tanpa membocorkan detail ke Telegram; output hanya di terminal remote.
# Beberapa provider baru (terutama AWS) DNS/network-nya baru stabil beberapa menit
# setelah cloud-init selesai. Retry supaya install pertama tidak gagal lalu baru berhasil saat rebuild.
# Cek ketersediaan URL. Sebagian server memblokir HEAD (curl -I) sehingga preflight
# lama sering false-negative padahal GET sebenarnya jalan. Karena itu: coba HEAD dulu,
# lalu fallback GET 1 byte (range 0-0) yang jauh lebih andal.
url_reachable() {
  local u="$1"
  curl -fsIL --connect-timeout 20 --max-time 60 "$u" >/dev/null 2>&1 && return 0
  curl -fsSL --connect-timeout 20 --max-time 90 -r 0-0 -o /dev/null "$u" >/dev/null 2>&1 && return 0
  return 1
}

echo "Testing image URL..."
# Kandidat: URL asli + varian HTTPS dari host yang sama (lebih tahan blokir/MITM di
# sebagian region/provider). Kalau salah satu bisa diakses, pakai itu.
URL_CANDIDATES=("$IMG_URL")
case "$IMG_URL" in
  http://*) URL_CANDIDATES+=("https://${IMG_URL#http://}") ;;
esac

URL_OK=0
for i in $(seq 1 12); do
  for cand in "${URL_CANDIDATES[@]}"; do
    if url_reachable "$cand"; then
      IMG_URL="$cand"
      URL_OK=1
      break
    fi
  done
  [ "$URL_OK" = "1" ] && break
  echo "Image URL belum bisa diakses, retry $i/12 dalam 20 detik..."
  sleep 20
  # refresh DNS/network stack ringan
  systemctl restart systemd-resolved >/dev/null 2>&1 || true
  dhclient -v >/dev/null 2>&1 || true
done
if [ "$URL_OK" != "1" ]; then
  echo "Image URL not accessible from this VPS/provider after retries. Try another Windows image/version or mirror."
  exit 1
fi
echo "Image URL OK: $IMG_URL"

# Perintah install. Jangan pakai eval untuk password; gunakan array.
echo "Running reinstall.sh with provider-compatible parameters..."
INSTALL_ARGS=(dd --rdp-port 4443 --password "$PASSWORD" --img "$IMG_URL")
if [ -n "$FORCE_ARGS" ]; then
  # shellcheck disable=SC2206
  FORCE_ARRAY=($FORCE_ARGS)
  INSTALL_ARGS+=("${FORCE_ARRAY[@]}")
fi

if [ "$IS_LINODE" = "1" ]; then
  LINODE_FORCE_MAIN_DISK_DEVICE=1 LINODE_FORCE_GRUB=1 bash reinstall.sh "${INSTALL_ARGS[@]}"
else
  printf "y\n" | bash reinstall.sh "${INSTALL_ARGS[@]}"
fi
RESULT=$?

if [ "$RESULT" -eq 0 ]; then
  echo "Installation completed successfully!"
  echo "RDP will be available on port 4443"
  echo "Username: administrator"
  echo "Password: $PASSWORD"
  echo "Rebooting system in 5 seconds..."
  sleep 5
  reboot
else
  echo "Installation failed!"
  exit 1
fi
