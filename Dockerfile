# ── Oracle A1 / Ampere Altra (aarch64 ARM64) ──────────────────────────────────
# faster-whisper large-v3 with compute_type="int8" runs via CTranslate2
# NEON dot-product instructions — no GPU required.
FROM --platform=linux/arm64 ubuntu:22.04

ENV DEBIAN_FRONTEND=noninteractive \
    LANG=en_US.UTF-8 \
    # Tells install.sh to skip local Redis / PostgreSQL service start
    container=docker

# ── Layer 1: system packages ──────────────────────────────────────────────────
# Pre-installing here keeps this heavy layer cached across source-code changes.
RUN apt-get update && \
    apt-get -y upgrade && \
    apt-get install -y --no-install-recommends \
      # Audio processing (cook.sh)
      make inkscape ffmpeg flac fdkaac vorbis-tools opus-tools zip unzip at lame wget \
      # Redis (daemon skipped at runtime in Docker mode; tools still needed)
      lsb-release curl gpg ca-certificates redis redis-server redis-tools \
      # PostgreSQL (server skipped at runtime; client used for prisma)
      postgresql \
      # Python 3 + pip for faster-whisper
      python3 python3-pip python3-setuptools \
      # Build essentials
      dbus-x11 sed coreutils build-essential sudo git locales && \
    locale-gen en_US.UTF-8 && \
    rm -rf /var/lib/apt/lists/*

# ── Layer 2: Python packages ──────────────────────────────────────────────────
# Install before COPY so this layer is cached across source-code changes.
# CTranslate2 uses ARM NEON dot-product instructions for int8 quantization.
RUN pip3 install --no-cache-dir --upgrade pip && \
    pip3 install --no-cache-dir faster-whisper

# ── Layer 3: application source ───────────────────────────────────────────────
WORKDIR /app
COPY . .

# ── Layer 4: Node.js + yarn build ─────────────────────────────────────────────
# install.config.build is a non-secret stub committed to the repo.
# It provides NODE_VERSION and dummy defaults so install.sh can run without
# any real secrets.  All actual secrets (Discord token, OAuth credentials, etc.)
# are injected at runtime via docker-compose environment variables; the
# entrypoint regenerates the per-app .env files before starting pm2.
RUN cp install.config.build install.config && ./install.sh

# Whisper model cache — persisted via a Docker volume so the ~1.5 GB
# large-v3 int8 model is downloaded only once.
RUN mkdir -p /app/whisper-models

# ── Runtime ───────────────────────────────────────────────────────────────────
EXPOSE 3000 5029

ENTRYPOINT ["/app/docker-entrypoint.sh"]
