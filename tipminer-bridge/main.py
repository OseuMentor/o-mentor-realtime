import os
import json
import time
import requests
from curl_cffi import requests as cffi_requests

ROUND_ID = "6ee2f33f-7dbf-40ae-b01c-b05368c806ba"
LIVE_URL = f"https://api.core.public.tipminer.com/v1/double/rounds/{ROUND_ID}/live"

GATEWAY_URL = os.environ["GATEWAY_INGEST_URL"]
INGEST_SECRET = os.environ["INGEST_SECRET"]

HEADERS = {
    "Accept": "text/event-stream",
    "Origin": "https://www.tipminer.com",
    "Referer": "https://www.tipminer.com/",
}


def forward_result(payload):
    try:
        requests.post(
            GATEWAY_URL,
            json=payload,
            headers={"x-ingest-secret": INGEST_SECRET},
            timeout=5,
        )
        print(f"[bridge] resultado repassado: {payload}")
    except Exception as e:
        print(f"[bridge] falha ao repassar resultado: {e}")


def run():
    while True:
        try:
            print("[bridge] conectando no TipMiner...")
            with cffi_requests.Session() as session:
                resp = session.get(
                    LIVE_URL,
                    headers=HEADERS,
                    impersonate="chrome124",
                    stream=True,
                    timeout=None,
                )
                print(f"[bridge] status HTTP recebido: {resp.status_code}")
                if resp.status_code != 200:
                    print(f"[bridge] corpo da resposta: {resp.text[:500]}")
                    time.sleep(5)
                    continue
                event_name = None
                )
                event_name = None
                for raw_line in resp.iter_lines():
                    if raw_line is None:
                        continue
                    line = raw_line.decode("utf-8", errors="ignore")
                    if line.startswith("event:"):
                        event_name = line[len("event:"):].strip()
                        continue
                    if line.startswith("data:"):
                        data_str = line[len("data:"):].strip()
                        if event_name == "heartbeat":
                            event_name = None
                            continue
                        try:
                            data = json.loads(data_str)
                        except json.JSONDecodeError:
                            event_name = None
                            continue
                        if data.get("result") is not None:
                            roll = data["result"]
                            color = "white" if roll == 0 else ("red" if roll <= 7 else "black")
                            forward_result({
                                "number": roll,
                                "color": color,
                                "timestamp": data.get("instant"),
                                "uuid": data.get("uuid"),
                            })
                        event_name = None
        except Exception as e:
            print(f"[bridge] conexao caiu: {e}. Reconectando em 5s...")
            time.sleep(5)


if __name__ == "__main__":
    run()
