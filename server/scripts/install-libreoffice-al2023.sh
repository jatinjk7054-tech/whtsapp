#!/usr/bin/env bash
# Installs LibreOffice (Impress) on Amazon Linux 2023 x86_64 for headless
# PPTX/DOCX->PNG snapshot rendering (certificate templates). Idempotent.
#
# The default AL2023 repos do not ship LibreOffice, so we pull the official
# The Document Foundation RPM package and install it via dnf.
set -euo pipefail

LO_VERSION="${LO_VERSION:-26.2.6}"

# Core + metric-compatible fonts so LibreOffice snapshots mirror Word layouts
# instead of substituting random fallback glyphs (which shifts the design).
sudo dnf install -y \
  fontconfig liberation-fonts dejavu-sans-fonts dejavu-serif-fonts \
  google-noto-sans-fonts google-noto-serif-fonts google-noto-emoji-fonts \
  abattis-cantarell-fonts 2>/dev/null || \
sudo dnf install -y fontconfig liberation-fonts dejavu-sans-fonts dejavu-serif-fonts 2>/dev/null || true
sudo fc-cache -f >/dev/null 2>&1 || true

if command -v soffice >/dev/null 2>&1; then
  echo "libreoffice already available: $(soffice --version | head -1)"
  exit 0
fi

echo "libreoffice not found - installing ${LO_VERSION}..."

# Shared libraries + Cairo for headless rendering.
sudo dnf install -y \
  libXinerama libXext libXrandr libXrender libXi libX11 libXcomposite \
  libXcursor libXfixes libXdamage libXt libXv libXpm libXmu libXScrnSaver libXaw \
  cairo cups-libs fontconfig freetype libjpeg-turbo libpng libtiff gtk3 harfbuzz

TMP_DIR="$(mktemp -d)"
cd "${TMP_DIR}"
curl -fsSL -o lo.tar.gz \
  "https://download.documentfoundation.org/libreoffice/stable/${LO_VERSION}/rpm/x86_64/LibreOffice_${LO_VERSION}_Linux_x86-64_rpm.tar.gz"
tar xzf lo.tar.gz
PKG_DIR="$(find . -maxdepth 1 -type d -name 'LibreOffice_*' | head -1)"
echo "Installing RPMs from ${PKG_DIR}..."
sudo dnf install -y "${PKG_DIR}"/RPMS/*.rpm

# Expose soffice on PATH (execFile('soffice') resolves it).
if [ -d /opt/libreoffice"${LO_VERSION%%.*}" ]; then
  sudo ln -sf /opt/libreoffice"${LO_VERSION%%.*}"/program/soffice /usr/local/bin/soffice
else
  sudo ln -sf "$(find /opt -maxdepth 1 -type d -name 'libreoffice*' | head -1)/program/soffice" /usr/local/bin/soffice
fi

cd /
rm -rf "${TMP_DIR}"

soffice --version | head -1