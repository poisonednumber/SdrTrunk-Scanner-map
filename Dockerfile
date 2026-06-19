# syntax=docker/dockerfile:1

###############################################################################
# Scanner Map - all-in-one image (Node + Python + FFmpeg)
#
# bot.js (Node) spawns transcribe.py / tone_detect.py (Python), so both
# runtimes live in one image. CPU transcription works out of the box.
# For NVIDIA GPU transcription, see docker-compose.yml (gpu profile) and
# build with --build-arg TORCH_VARIANT=cu121.
###############################################################################

FROM node:20-bookworm-slim AS base

ENV NODE_ENV=production \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1

# System deps: python, ffmpeg, and build tooling for any native node modules
RUN apt-get update && apt-get install -y --no-install-recommends \
        python3 \
        python3-pip \
        python3-venv \
        ffmpeg \
        ca-certificates \
        curl \
        tini \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# ---- Node dependencies (cached layer) ----
COPY package.json package-lock.json* ./
RUN npm install --omit=dev --no-audit --no-fund

# ---- Python dependencies (cached layer) ----
ARG TORCH_VARIANT=cpu
COPY requirements.txt ./
RUN python3 -m venv /opt/venv \
    && . /opt/venv/bin/activate \
    && pip install --upgrade pip \
    && if [ "$TORCH_VARIANT" = "cpu" ]; then \
         pip install torch torchvision torchaudio --index-url https://download.pytorch.org/whl/cpu ; \
       else \
         pip install torch torchvision torchaudio --index-url https://download.pytorch.org/whl/$TORCH_VARIANT ; \
       fi \
    && pip install -r requirements.txt
ENV PATH="/opt/venv/bin:$PATH" \
    PYTHON_COMMAND=python3

# ---- Application code ----
COPY . .

# Writable runtime dirs
RUN mkdir -p audio data logs models

EXPOSE 3306 8080

# tini handles PID 1 / zombie reaping for the spawned python/ffmpeg children
ENTRYPOINT ["/usr/bin/tini", "--", "/app/docker-entrypoint.sh"]
CMD ["node", "start.js"]
