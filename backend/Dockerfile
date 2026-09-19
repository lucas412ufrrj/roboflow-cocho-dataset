FROM python:3.12-slim AS base

# Dependências de sistema: ffmpeg (normalização) e libs exigidas pelo OpenCV.
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    libgl1 \
    libglib2.0-0 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY app ./app

RUN mkdir -p /app/tmp_storage
ENV LOCAL_STORAGE_PATH=/app/tmp_storage

# ATENÇÃO (Render): este caminho, sem um Persistent Disk anexado e montado
# aqui, é apagado a cada deploy — não use como está em produção. Configure a
# variável de ambiente PERSISTENT_DATA_PATH no serviço do Render apontando
# pro mount path de um Disk de verdade (Render -> serviço -> Disks -> Add
# Disk). Ver comentário em app/config.py (Settings.PERSISTENT_DATA_PATH).
RUN mkdir -p /app/persistent_data
ENV PERSISTENT_DATA_PATH=/app/persistent_data

EXPOSE 8000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD python -c "import urllib.request; urllib.request.urlopen('http://localhost:8000/health')" || exit 1

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
