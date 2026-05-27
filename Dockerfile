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
# install.sh installs Node via nvm, builds TypeScript, and writes .env files
# for each app from install.config values.
#
# install.config is passed as a BuildKit secret so it is:
#   - never stored in any image layer, and
#   - not required in the Docker build context (.dockerignore excludes it).
#
# Local build:  docker build --secret id=install_config,src=install.config .
# CI build:     secrets: | install_config=${{ secrets.INSTALL_CONFIG }}
RUN --mount=type=secret,id=install_config,target=/app/install.config \
    ./install.sh

# Whisper model cache — persisted via a Docker volume so the ~1.5 GB
# large-v3 int8 model is downloaded only once.
RUN mkdir -p /app/whisper-models

# ── Runtime ───────────────────────────────────────────────────────────────────
EXPOSE 3000 5029

ENTRYPOINT ["/app/docker-entrypoint.sh"]
