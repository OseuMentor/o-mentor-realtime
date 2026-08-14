FROM python:3.11-slim

# python:3.11-slim vem com pg_dump v17 (via apt padrao do Debian), mas
# o Postgres do Railway roda v18 -- pg_dump se recusa a rodar contra
# um servidor MAIS NOVO que a propria versao dele (protecao do
# proprio Postgres). Por isso instalamos a v18 direto do repositorio
# oficial do PostgreSQL (apt.postgresql.org, "PGDG"), que ja tem
# pacotes pra Postgres 18 -- o apt padrao do Debian bookworm ainda nao
# tem.
RUN apt-get update \
    && apt-get install -y --no-install-recommends curl ca-certificates gnupg \
    && install -d /usr/share/postgresql-common/pgdg \
    && curl -o /usr/share/postgresql-common/pgdg/apt.postgresql.org.asc --fail \
       https://www.postgresql.org/media/keys/ACCC4CF8.asc \
    && echo "deb [signed-by=/usr/share/postgresql-common/pgdg/apt.postgresql.org.asc] https://apt.postgresql.org/pub/repos/apt bookworm-pgdg main" \
       > /etc/apt/sources.list.d/pgdg.list \
    && apt-get update \
    && apt-get install -y --no-install-recommends postgresql-client-18 \
    && apt-get purge -y curl gnupg \
    && apt-get autoremove -y \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY backup.py .

CMD ["python", "-u", "backup.py"]
