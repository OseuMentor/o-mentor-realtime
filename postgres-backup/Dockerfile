FROM python:3.11-slim

# pg_dump nao vem no python:slim por padrao -- precisa instalar o
# cliente do Postgres separadamente.
RUN apt-get update \
    && apt-get install -y --no-install-recommends postgresql-client \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY backup.py .

CMD ["python", "-u", "backup.py"]
