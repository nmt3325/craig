# Use an official Ubuntu base image
FROM ubuntu:22.04

# Install all required dependencies in advance, for performance
RUN apt-get update && \
    apt-get -y upgrade && \
    DEBIAN_FRONTEND=noninteractive apt-get install -y \
    # cook
    make inkscape ffmpeg flac fdkaac vorbis-tools opus-tools zip unzip \
    wget \
    # redis
    lsb-release curl gpg \
    ca-certificates redis redis-server redis-tools \
    # web
    postgresql \
    # install
    dbus-x11 sed coreutils build-essential python-setuptools \
    # Other dependencies
    sudo git locales && \
    # Cleanup
    apt-get -y autoremove

RUN locale-gen en_US.UTF-8
ENV LANG=en_US.UTF-8

# Used for Docker-specific build logic in install.sh
ENV container=docker

WORKDIR /app

# Copy the repo, particularly environment variables with discord API keys
COPY . .
# Run first-time setup for faster restarts
RUN ./install.sh

# Expose app port
EXPOSE 3000
# Expose API port
EXPOSE 5029
# Start Craig (build already ran install.sh; runtime only deploys DB and starts pm2)
CMD ["bash", "-c", "source /root/.nvm/nvm.sh && nvm use node && source /app/install.config && export DATABASE_URL=\"postgresql://${POSTGRESQL_USER}:${POSTGRESQL_PASSWORD}@db:5432/${DATABASE_NAME}?schema=public\" && export API_HOST=0.0.0.0 && cd /app && yarn prisma:deploy && yarn run sync || true && cd apps/bot && pm2 start ecosystem.config.js && cd /app/apps/dashboard && pm2 start ecosystem.config.js && cd /app/apps/download && pm2 start ecosystem.config.js && cd /app/apps/tasks && pm2 start ecosystem.config.js && pm2 save && sleep infinity"]
