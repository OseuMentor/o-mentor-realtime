# O Mentor — IA das Apostas

Ferramenta de análise estatística de padrões do módulo de **Cores** do Double, com detecção de 14 estratégias, cálculo de confluência, painel de sinal ao vivo, ranking de assertividade adaptativo e controle de acesso por assinatura.

> Ferramenta de apoio à decisão baseada em análise estatística. Não é um sistema garantido nem prevê o resultado aleatório do jogo — resultados passados não garantem resultados futuros.

---

## Arquitetura

```
Frontend (estático)  →  GitHub Pages
Backend (Node.js)    →  Railway (serviço "o-mentor-realtime")
Banco de dados        →  Railway Postgres
Captura de dados       →  serviço auxiliar isolado, com fallback manual se cair
```

O frontend é 100% estático (HTML + CSS + JS puro, sem build step) — cada página é um arquivo independente, editado direto pela interface web do GitHub. O backend expõe WebSocket (tempo real) e HTTP (REST) no mesmo processo.

---

## Estrutura de arquivos

### Frontend (raiz do repo)
| Arquivo | Função |
|---|---|
| `index.html` | Redirecionamento pra `tela_principal.html` |
| `tela_principal.html` | Tela Início — sinal ao vivo, tendências, histórico recente |
| `historico.html` | Contagem de sinais resolvidos por dia (60 dias) |
| `ferramentas.html` | As 14 estratégias detalhadas + checklist de rotina |
| `estatisticas.html` | Ranking de estratégias por % de acerto real |
| `teste-gratis.html` | Auto-cadastro do teste grátis (2 dias, 1x por e-mail) |

### Backend (raiz do repo)
| Arquivo | Função |
|---|---|
| `realtime-gateway.js` | Ponto de entrada — WebSocket + rotas HTTP |
| `pattern-engine.js` | Detecta as 14 estratégias e calcula confluência |
| `persistence.js` | Toda a camada de banco (Postgres) |
| `strategyTracker.js` | Rastreia o resultado real de cada estratégia disparada |
| `statsBatchJob.js` | Recalcula % de acerto + peso adaptativo a cada 5 min |
| `strategyMeta.js` | Nomes/categorias das estratégias (espelha o pattern-engine) |
| `lastlinkWebhook.js` | Recebe os avisos de assinatura da LastLink |
| `double-worker.js` | Worker de captura de dados (fallback documentado, não iniciado por padrão) |
| `tipminer-bridge/` | Serviço auxiliar em Python, roda como serviço Railway separado |

---

## Banco de dados (Postgres — tabelas)

- `double_results` — cada resultado fechado do jogo
- `strategy_signals` — cada disparo de estratégia + resultado real (Win/Gale/Branco/Loss)
- `strategy_stats` — % de acerto e peso adaptativo, recalculado em lote
- `access_grants` — controle de acesso (`source`: `lastlink` / `tester` / `trial`)

Todas criadas automaticamente pelo `initDb()` no start do serviço — não precisa rodar migração manual.

---

## Variáveis de ambiente (Railway)

| Nome | Uso |
|---|---|
| `DATABASE_URL` | Injetada automaticamente pelo addon Postgres |
| `PORT` | Injetada automaticamente pelo Railway |
| `INGEST_SECRET` | Protege `/internal/ingest` (usado pelo serviço de captura) |
| `LASTLINK_WEBHOOK_SECRET` | Protege `/webhooks/lastlink` |

---

## Endpoints HTTP principais

| Rota | Método | Uso |
|---|---|---|
| `/check-access` | GET | Frontend consulta se um e-mail tem acesso ativo |
| `/trial-signup` | POST | Auto-cadastro do teste grátis |
| `/webhooks/lastlink` | POST | Recebe eventos de assinatura (protegido) |
| `/internal/ingest` | POST | Recebe resultados do serviço de captura (protegido) |
| `/stats` | GET | Ranking de estratégias (público) |
| `/history` | GET | Histórico diário de sinais (público) |
| `/health` | GET | Healthcheck |

---

## Modelo de acesso

Plano único, mensal, via LastLink. Sem camada free permanente — só teste grátis de 2 dias (1x por e-mail), que libera o app completo exceto a grade de estratégias detalhadas em `ferramentas.html`.

---

## Status / pendências

- [ ] Assinar Railway Hobby (trial em contagem regressiva)
- [ ] Assinar Decodo (plano residencial de entrada)
- [ ] Reativar `tipminer-bridge` depois do Decodo
- [ ] Criar o produto na LastLink e calibrar `lastlinkWebhook.js` contra um payload real
- [ ] Trocar os links `href="#"` de checkout pelo link real
