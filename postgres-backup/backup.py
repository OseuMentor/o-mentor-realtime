"""
backup.py
---------------------------------------------------------
Cron Job do Railway responsavel por UMA coisa so: rodar pg_dump no
Postgres do O Mentor, subir o arquivo pro Cloudflare R2, e apagar
backups antigos pra nao acumular espaco indefinidamente.

Por que existe (contexto do projeto):
O plano atual do Postgres no Railway (Hobby) nao tem backup automatico
nativo -- isso so existe no plano Pro. Enquanto o app ainda esta em
fase de validacao (sem assinantes pagantes rodando), faz mais sentido
resolver isso com um backup externo gratuito do que assinar o Pro so
por causa disso.

Como funciona:
  1. Roda `pg_dump` usando a DATABASE_URL do Postgres (Railway injeta
     essa variavel automaticamente em qualquer servico do mesmo
     projeto que voce conectar ao banco).
  2. Comprime o dump com gzip.
  3. Sobe pro bucket R2 configurado, com um nome com timestamp
     (ex: o-mentor-backup-2026-08-12T22-00-00.sql.gz).
  4. Lista os backups existentes no bucket e apaga os mais antigos,
     mantendo so os ultimos KEEP_LAST backups (default: 7).

Variaveis de ambiente necessarias:
  DATABASE_URL          -- ja deve existir se voce conectar este
                            servico ao Postgres do projeto no Railway
  R2_ACCOUNT_ENDPOINT   -- endpoint do R2 (https://<account_id>.r2.cloudflarestorage.com)
  R2_ACCESS_KEY_ID      -- access key do token R2
  R2_SECRET_ACCESS_KEY  -- secret key do token R2
  R2_BUCKET_NAME        -- nome do bucket (ex: o-mentor-backups)
  KEEP_LAST             -- opcional, default 7 -- quantos backups manter

Se qualquer variavel obrigatoria estiver faltando, o script para e
avisa exatamente qual -- pra facilitar diagnostico direto no log do
Railway, sem precisar adivinhar.
"""

import os
import sys
import gzip
import shutil
import subprocess
from datetime import datetime, timezone

import boto3
from botocore.client import Config

REQUIRED_VARS = [
    "DATABASE_URL",
    "R2_ACCOUNT_ENDPOINT",
    "R2_ACCESS_KEY_ID",
    "R2_SECRET_ACCESS_KEY",
    "R2_BUCKET_NAME",
]

KEEP_LAST = int(os.environ.get("KEEP_LAST", "7"))
BACKUP_PREFIX = "o-mentor-backup-"


def check_env():
    missing = [v for v in REQUIRED_VARS if not os.environ.get(v)]
    if missing:
        print(f"[backup] ERRO: variavel(is) de ambiente faltando: {', '.join(missing)}")
        sys.exit(1)


def run_pg_dump(database_url, output_path):
    """
    Roda pg_dump direto contra a DATABASE_URL do Postgres. Usa
    --no-owner --no-acl pra gerar um dump mais portavel (evita erros
    de restauracao se um dia precisar restaurar num banco com um
    usuario/role diferente do original).
    """
    print("[backup] rodando pg_dump...")
    with open(output_path, "wb") as f:
        result = subprocess.run(
            ["pg_dump", "--no-owner", "--no-acl", database_url],
            stdout=f,
            stderr=subprocess.PIPE,
        )
    if result.returncode != 0:
        print(f"[backup] ERRO no pg_dump: {result.stderr.decode('utf-8', errors='ignore')}")
        sys.exit(1)
    size_mb = os.path.getsize(output_path) / (1024 * 1024)
    print(f"[backup] pg_dump concluido ({size_mb:.2f} MB antes de comprimir)")


def compress_file(input_path, output_path):
    print("[backup] comprimindo com gzip...")
    with open(input_path, "rb") as f_in:
        with gzip.open(output_path, "wb") as f_out:
            shutil.copyfileobj(f_in, f_out)
    size_mb = os.path.getsize(output_path) / (1024 * 1024)
    print(f"[backup] compressao concluida ({size_mb:.2f} MB depois de comprimir)")


def get_r2_client():
    return boto3.client(
        "s3",
        endpoint_url=os.environ["R2_ACCOUNT_ENDPOINT"],
        aws_access_key_id=os.environ["R2_ACCESS_KEY_ID"],
        aws_secret_access_key=os.environ["R2_SECRET_ACCESS_KEY"],
        config=Config(signature_version="s3v4"),
        region_name="auto",
    )


def upload_to_r2(client, bucket, local_path, remote_key):
    print(f"[backup] enviando pro R2 como '{remote_key}'...")
    client.upload_file(local_path, bucket, remote_key)
    print("[backup] upload concluido.")


def cleanup_old_backups(client, bucket):
    """
    Lista todos os objetos com o prefixo de backup, ordena do mais
    recente pro mais antigo, e apaga tudo que passar de KEEP_LAST.
    """
    print(f"[backup] verificando backups antigos (mantendo os ultimos {KEEP_LAST})...")
    response = client.list_objects_v2(Bucket=bucket, Prefix=BACKUP_PREFIX)
    objects = response.get("Contents", [])
    if not objects:
        print("[backup] nenhum backup anterior encontrado.")
        return

    objects.sort(key=lambda o: o["LastModified"], reverse=True)

    to_delete = objects[KEEP_LAST:]
    if not to_delete:
        print(f"[backup] {len(objects)} backup(s) existente(s), nenhum precisa ser removido ainda.")
        return

    for obj in to_delete:
        print(f"[backup] apagando backup antigo: {obj['Key']}")
        client.delete_object(Bucket=bucket, Key=obj["Key"])

    print(f"[backup] {len(to_delete)} backup(s) antigo(s) removido(s).")


def main():
    check_env()

    timestamp = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H-%M-%S")
    dump_path = f"/tmp/{BACKUP_PREFIX}{timestamp}.sql"
    gz_path = f"{dump_path}.gz"
    remote_key = f"{BACKUP_PREFIX}{timestamp}.sql.gz"

    run_pg_dump(os.environ
