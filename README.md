# Coleta de Vídeos para Dataset Roboflow — Peso de Alimento no Cocho

Monorepo de produção para coletar vídeos em campo (app móvel), extrair frames
de qualidade no backend e enviá-los ao dataset do Roboflow, com todos os
metadados necessários para treinar um modelo de estimativa de peso de
alimento no cocho.

- **Workspace Roboflow:** `lucas-da-guia-costa`
- **Projeto Roboflow:** `peso-de-alimento-no-cocho`
- **ID interno do projeto:** `Nl9vkgG54JP6KWBK4ala`

```
roboflow-cocho-dataset/
├── mobile/     # App React Native + Expo + TypeScript
├── backend/    # API Python 3.12 + FastAPI + OpenCV + FFmpeg
└── README.md   # Este arquivo
```

---

## 1. Visão geral da arquitetura

```
┌──────────────┐   multipart/form-data    ┌──────────────────┐   multipart/form-data   ┌────────────┐
│  App móvel   │ ───────────────────────► │  Backend FastAPI  │ ──────────────────────► │  Roboflow  │
│ (Expo/RN/TS) │  X-Backend-Api-Key        │ (Python/OpenCV/   │  ROBOFLOW_API_KEY        │  (dataset) │
│              │ ◄─────────────────────── │  FFmpeg)          │ ◄────────────────────── │            │
└──────────────┘   contagens de frames     └──────────────────┘   resposta de upload     └────────────┘
```

Princípio de segurança central: **o app móvel nunca fala diretamente com o
Roboflow**. Ele autentica apenas no nosso backend (via `X-Backend-Api-Key`).
Só o backend possui `ROBOFLOW_API_KEY`, lida exclusivamente de variável de
ambiente, nunca logada e nunca devolvida em nenhuma resposta HTTP.

---

## 2. Fluxo do aplicativo móvel

1. **`CaptureFormScreen`** — pede o peso real em kg (aceita vírgula ou ponto
   decimal), e opcionalmente tipo de alimento, ID do cocho e observações.
2. **`RecordVideoScreen`** — grava um vídeo com a câmera (limitado a 10s) ou
   permite selecionar um vídeo MP4 já existente da galeria.
3. **`PreviewScreen`** — reproduz o vídeo, mostra duração real (lida via
   `expo-av`) e tamanho do arquivo; bloqueia o envio se a duração estiver
   fora de 7–10 segundos.
4. **`UploadStatusScreen`** — gera o `capture_id` (UUID v4) e envia o vídeo
   ao backend, com barra de progresso de upload (via `XMLHttpRequest`, que
   expõe eventos de progresso — o `fetch` padrão do RN não expõe isso de
   forma confiável). Ao concluir, mostra quantos frames foram aprovados e o
   motivo de rejeição de cada um dos demais. Em caso de erro, oferece um
   botão "Tentar novamente" que reenvia o **mesmo** `capture_id`
   (idempotência garantida pelo backend).

### Rodando o app

```bash
cd mobile
cp .env.example .env
# edite .env com a URL do seu backend e a chave de app (BACKEND_API_KEY)
npm install
npm start
```

### Variáveis de ambiente do app (`mobile/.env.example`)

| Variável | Descrição |
|---|---|
| `EXPO_PUBLIC_API_BASE_URL` | URL base do backend (nunca do Roboflow). |
| `EXPO_PUBLIC_BACKEND_API_KEY` | Chave que autentica o app **no nosso backend**. **Não é** a chave do Roboflow. |

> Qualquer variável `EXPO_PUBLIC_*` é embutida no bundle do app e é, por
> definição, pública. Por isso `ROBOFLOW_API_KEY` **jamais** deve virar uma
> variável `EXPO_PUBLIC_*` — ela vive apenas no backend.

---

## 3. Fluxo do backend

`POST /api/captures` (multipart/form-data, autenticado via header
`X-Backend-Api-Key`):

1. Recebe `video`, `peso_kg`, `tipo_alimento`, `cocho_id`, `observacoes` e
   (opcionalmente) `capture_id`.
2. Valida MIME type, duração (7–10s), tamanho (`MAX_VIDEO_SIZE_MB`) e
   `peso_kg` (deve ser numérico, decimal aceito, dentro dos limites
   configurados).
3. Normaliza o vídeo para MP4/H.264 com FFmpeg **somente se necessário**
   (vídeos já em MP4/H.264 não são reencodados).
4. Extrai frames a uma taxa configurável (`FRAMES_PER_SECOND`, padrão 3
   fps) usando OpenCV.
5. Calcula `focus_score` (variância do Laplaciano) por frame.
6. Rejeita frames com `focus_score` abaixo de `FOCUS_SCORE_THRESHOLD`.
7. Valida se o cocho está inteiro no frame via `TroughValidator`
   (`MockTroughValidator` por padrão; `RoboflowTroughValidator` pronto para
   uso quando houver um modelo/workflow treinado para essa tarefa).
8. **Não** rejeita frames por similaridade entre eles ou por ângulo — apenas
   por desfoque ou cocho incompleto.
9. Todos os frames aprovados do mesmo vídeo recebem o mesmo `video_id`
   (UUID gerado no backend), `peso_kg` e `split`.
10. O `split` é escolhido deterministicamente por `SHA-256(video_id) % 100`:
    `[0,70)` → `train`, `[70,90)` → `valid`, `[90,100)` → `test`.
11. Cada frame aprovado é enviado ao endpoint de upload de imagens do
    Roboflow via multipart/form-data, usando o `capture_id` como
    `batch_name`.
12. Tags aplicadas: `mobile-capture`, `frame-valid` e, se informado, o
    `tipo_alimento`.
13. Metadata JSON enviada junto de cada frame: `peso_kg`, `video_id`,
    `frame_time_ms`, `focus_score`, `cocho_completo`, `tipo_alimento`,
    `cocho_id`, `observacoes`.
14. Uploads ao Roboflow têm timeout configurável e retries com backoff
    exponencial (`tenacity`), apenas para erros transitórios (timeout, 5xx,
    429) — erros 4xx falham imediatamente, sem retry.
15. Reenviar o mesmo `capture_id` (ex.: o app tentou de novo após um
    timeout de rede, mas o backend já havia concluído) **não duplica**
    uploads no Roboflow: a resposta anterior é reaproveitada
    (`idempotente_reprocessado: true`).
16. `ROBOFLOW_API_KEY` nunca é escrita em log, em nenhuma circunstância
    (filtro de logging redige a chave caso ela apareça em qualquer mensagem).
17. Arquivos temporários (vídeo bruto e normalizado) são sempre apagados ao
    final do processamento — sucesso ou falha.
18. A resposta traz as contagens: candidatos, aprovados, rejeitados por
    desfoque, rejeitados por cocho incompleto e falhas de upload, além do
    detalhamento por frame.

### Rodando o backend localmente

```bash
cd backend
cp .env.example .env
# preencha ROBOFLOW_API_KEY e BACKEND_API_KEY no .env (nunca faça commit dele)
python3.12 -m venv .venv && source .venv/bin/activate
pip install -r requirements-dev.txt
uvicorn app.main:app --reload
```

### Rodando com Docker

```bash
cd backend
cp .env.example .env
docker compose up --build
```

O backend expõe `GET /health` para checagem de disponibilidade e
`POST /api/captures` como endpoint principal.

### Rodando os testes

```bash
cd backend
pip install -r requirements-dev.txt
pytest -v
```

---

## 4. Configuração (`backend/.env`)

Veja `backend/.env.example` para todas as variáveis, com placeholders. As
principais:

| Variável | Descrição |
|---|---|
| `BACKEND_API_KEY` | Chave que o app usa para autenticar no backend. |
| `ROBOFLOW_API_KEY` | Chave privada do Roboflow. **Somente no backend.** |
| `ROBOFLOW_WORKSPACE` | `lucas-da-guia-costa` |
| `ROBOFLOW_PROJECT` | `peso-de-alimento-no-cocho` |
| `ROBOFLOW_PROJECT_ID` | `Nl9vkgG54JP6KWBK4ala` |
| `STORAGE_BACKEND` | `local` (padrão) ou `s3` |
| `FRAMES_PER_SECOND` | Taxa de extração de frames (padrão: 3) |
| `FOCUS_SCORE_THRESHOLD` | Limiar de nitidez (padrão: 100) |
| `TROUGH_VALIDATOR` | `mock` (padrão) ou `roboflow` |
| `MIN_VIDEO_DURATION_S` / `MAX_VIDEO_DURATION_S` | 7 / 10 segundos |
| `RATE_LIMIT_CAPTURES` | Limite de requisições por IP (padrão: `10/minute`) |

---

## 5. Armazenamento temporário: local hoje, S3 amanhã

Todo o backend depende apenas da interface `StorageBackend`
(`app/storage/base.py`), com dois métodos essenciais: `save_bytes`,
`read_bytes`, `delete`, `exists` e `local_path` (este último garante um
caminho em disco local, necessário para OpenCV/FFmpeg, mesmo quando o
backend real é remoto).

- `LocalStorageBackend` (padrão): grava em `LOCAL_STORAGE_PATH`.
- `S3StorageBackend` (pronto, em `app/storage/s3_storage.py`): basta definir
  `STORAGE_BACKEND=s3`, `S3_BUCKET`, `S3_REGION` e credenciais AWS no
  `.env` — nenhum outro código muda.

---

## 6. Segurança

- O app autentica **no nosso backend** via header `X-Backend-Api-Key`
  (`app/core/security.py`), nunca diretamente no Roboflow.
- `ROBOFLOW_API_KEY` só existe como variável de ambiente do backend/
  container, nunca em código, nunca em resposta HTTP, nunca em log.
- Rate limiting por IP em `POST /api/captures` (`slowapi`), configurável via
  `RATE_LIMIT_CAPTURES`.
- Limite de tamanho de upload (`MAX_VIDEO_SIZE_MB`) e validação de
  MIME type antes de qualquer processamento pesado.
- CORS restritivo recomendado em produção (`app/main.py`, ajuste
  `allow_origins`).
- `.env.example` no mobile e no backend contêm apenas placeholders — nunca
  chaves reais. `.gitignore` já exclui `.env` de qualquer commit.

---

## 7. Qualidade e testes

Testes unitários (`backend/tests/`):

- `test_split.py` — determinismo do split e distribuição aproximada
  70/20/10.
- `test_focus.py` — `focus_score` de frames sintéticos nítidos vs.
  desfocados (inclusive com `GaussianBlur` real do OpenCV).
- `test_weight_validation.py` — aceitação de decimais, rejeição de valores
  inválidos/fora de faixa.
- `test_metadata.py` — presença e consistência dos campos de metadata,
  incluindo `video_id`/`peso_kg` compartilhados entre frames do mesmo
  vídeo.
- `test_idempotency.py` — reprocessar o mesmo `capture_id` não duplica
  uploads ao Roboflow.
- `test_roboflow_upload_integration.py` — teste de integração do upload
  usando **mock HTTP** (`respx`): valida tags, `batch_name`, metadata,
  comportamento de retry em 5xx/429 e falha imediata em 4xx, e garante que
  a API key nunca aparece nos logs capturados pelo teste.

> **Nota sobre execução neste ambiente de geração:** o sandbox usado para
> montar este repositório não tem acesso à internet, então não foi possível
> rodar `pip install` / `npm install` para executar a suíte de testes ou o
> typecheck do TypeScript aqui. A lógica dos dois algoritmos mais sensíveis
> (`choose_split` e `compute_focus_score`) foi validada manualmente com
> scripts isolados usando as bibliotecas já presentes no ambiente
> (`numpy`/`opencv-python`), com resultados condizentes com o esperado.
> Antes de usar em produção, rode `pytest -v` no backend e
> `npm install && npx tsc --noEmit` no mobile no seu ambiente com acesso à
> rede.

---

## 8. Decisões de design relevantes

- **Split determinístico por hash**, não por sorteio: garante que o mesmo
  vídeo sempre cai no mesmo split, mesmo em reprocessamentos.
- **Rejeição apenas por desfoque ou cocho incompleto**: propositalmente não
  há remoção por similaridade entre frames consecutivos nem por ângulo,
  conforme especificado — isso é responsabilidade de uma etapa futura de
  curadoria, não da ingestão.
- **`TroughValidator` como interface**: permite trocar `MockTroughValidator`
  por `RoboflowTroughValidator` (ou qualquer outra implementação) sem tocar
  no `CaptureService`.
- **Idempotência simples via arquivo JSON local**: suficiente para um único
  processo/worker; para múltiplas réplicas, troque `FileIdempotencyStore`
  por uma implementação em Redis/Postgres mantendo a interface
  `IdempotencyStore`.

---

## 9. Limitações conhecidas / próximos passos sugeridos

- O `IdempotencyStore` baseado em arquivo local não é seguro para múltiplas
  réplicas do backend rodando simultaneamente (sem lock distribuído).
- `RoboflowTroughValidator` assume um formato de resposta de inferência
  (`predictions[].class`/`confidence`) que deve ser ajustado ao modelo real
  treinado no workspace, quando ele existir.
- O endpoint de upload do Roboflow usado (`/dataset/{project}/upload`)
  segue a API pública documentada no momento da escrita; caso o Roboflow
  altere o contrato, ajuste apenas `app/services/roboflow_client.py`.
- Recomenda-se adicionar autenticação mútua (mTLS) ou rotação de
  `BACKEND_API_KEY` para produção em larga escala.
