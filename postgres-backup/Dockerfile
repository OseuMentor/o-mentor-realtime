FROM python:3.11-slim-bookworm

# IMPORTANTE: usamos "slim-bookworm" (fixo em Debian 12), NAO "slim"
# sozinho -- a tag "python:3.11-slim" flutua para a versao mais
# recente do Debian (hoje em dia ja aponta pra "trixie"/Debian 13).
# Isso quebrou o build: o repositorio oficial do PostgreSQL (PGDG)
# abaixo esta configurado para "bookworm", e misturar pacotes de
# bookworm num sistema trixie gerou conflito de dependencias
# (libldap-2.5-0 incompativel). Fixando a versao do Debian aqui,
# eliminamos essa mistura.
#
# pg_dump v17 (que viria por padrao do apt do Debian) nao roda contra
# o Postgres v18 do Railway -- pg_dump se recusa a rodar contra um
# servidor MAIS NOVO que a propria versao dele (protecao do proprio
# Postgres). Por isso instalamos a v18 direto do repositorio oficial
# do PostgreSQL (apt.postgresql.org, "PGDG").
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
