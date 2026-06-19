<div align="center">

# 📡 Scanner Map 2.0

### Real-time emergency-scanner mapping, transcription & dispatch intelligence

Ingest radio calls from **SDRTrunk**, **TrunkRecorder**, or any **rdio-scanner-compatible** source — then transcribe them with AI, extract & geocode the address, and watch them appear **live on an interactive map** with optional **Discord** integration.

![Node](https://img.shields.io/badge/Node-%E2%89%A518-339933?logo=node.js&logoColor=white)
![Python](https://img.shields.io/badge/Python-3.9–3.12-3776AB?logo=python&logoColor=white)
![Platforms](https://img.shields.io/badge/Windows%20%7C%20Linux%20%7C%20Docker-informational)
![License](https://img.shields.io/badge/License-MIT-green)

</div>

---

## ✨ What's new in 2.0

Version 2.0 is a ground-up modernization of the original [Scanner-map](https://github.com/poisonednumber/Scanner-map). The biggest change: **you no longer hand-edit `.env`**. Everything is driven by a guided web setup wizard and a live settings page.

| Area | 2.0 highlight |
|------|---------------|
| 🧙 **Install** | One file to launch (`start.bat` / `start.sh`), a **web Setup Wizard** for first-time config, and **auto-restart** straight into the app when setup finishes. |
| ⚙️ **Settings** | A retro-themed **live Settings page** on the map — change config, manage users/sessions, view DB stats & logs, back up the database, and run updates without touching files. |
| 🛰️ **Multi-system talkgroups** | Talkgroups are now scoped per **radio system** `(system, id)`, so overlapping IDs across multiple systems/counties no longer collide. |
| 🤖 **Smarter geocoding** | Target-county/city enforcement, DB-driven talkgroup metadata, and enriched LLM prompts for more accurate address extraction. |
| 🎤 **Transcription filtering** | Whitelist/blacklist which talkgroups get transcribed — perfect for TrunkRecorder, which sends *everything*. |
| 💬 **Discord tools** | De-duplicated channel creation (no more duplicate channels), plus a filterable, checkbox-based tool to bulk-delete channels & categories. |
| 📍 **Manual plotting** | Pin any transcribed call that didn't auto-geocode, by address or `lat, lon`. |
| ☁️ **Storage** | Local disk, **S3 / Cloudflare R2 / Backblaze B2 / MinIO**, or in-DB blobs. |
| 🔄 **Updates** | Built-in update checker + one-click self-update (`git pull` + deps + migrations). |

---

## 🧠 How it works

```
┌──────────────┐   call+audio    ┌───────────────┐   transcribe    ┌──────────────┐
│  SDRTrunk /  │ ──────────────► │   Bot server  │ ──────────────► │  Whisper /   │
│ TrunkRecorder│  (HTTP upload)  │   (bot.js)    │                 │  OpenAI/ICAD │
│ rdio-scanner │                 └──────┬────────┘                 └──────┬───────┘
└──────────────┘                        │ transcript                      │ text
                                        ▼                                 ▼
                                 ┌───────────────┐  geocode (LLM +  ┌──────────────┐
                                 │  geocoding.js │  Google/Location │   SQLite DB  │
                                 │ address→coords│ ◄──────────────► │ (botdata.db) │
                                 └──────┬────────┘                  └──────┬───────┘
                                        │ coords                          │
                                        ▼                                 ▼
                          ┌───────────────────────┐  live (Socket.IO) ┌──────────┐
                          │  Web server (webserver)│ ────────────────► │  Browser │
                          │  map • API • settings  │                   │   map    │
                          └───────────┬────────────┘                   └──────────┘
                                      │ post transcripts / summaries
                                      ▼
                                 ┌──────────┐
                                 │ Discord  │
                                 └──────────┘
```

Two Node processes run together from a single launcher: the **bot** (call ingestion, transcription, Discord, geocoding) and the **web server** (map UI, REST API, setup wizard, settings). They share one SQLite database.

---

## 🚀 Quick start

### Prerequisites

- **Node.js ≥ 18** — <https://nodejs.org>
- **FFmpeg** on your `PATH` (audio handling)
- **Python 3.9–3.12** *(only for local transcription / tone detection)*
- A radio source: **SDRTrunk**, **TrunkRecorder**, or **rdio-scanner**
- At least one geocoding key: **Google Maps** or **LocationIQ** (a keyless OpenStreetMap fallback exists, but a key is strongly recommended)
- *(Optional)* an **NVIDIA GPU** for fast local transcription
- *(Optional)* a **Discord bot** application

### 1. Get the code

```bash
git clone -b 2.0 https://github.com/poisonednumber/Scanner-map.git
cd Scanner-map
```

### 2. Launch

| OS | Command |
|----|---------|
| **Windows** | double-click **`start.bat`** (or run it in a terminal) |
| **Linux / macOS** | `bash start.sh` |

The launcher installs Node dependencies if needed, then starts the **Setup Wizard**.

### 3. Complete the Setup Wizard

Open **<http://localhost:8080/setup>** and follow the steps (details below). When you click **🚀 Start Scanner Map** at the end, the app **automatically restarts into full mode** — no manual commands.

Your map is then live at **<http://localhost>** (or whatever web port you chose).

> 💡 Already configured by hand? Set `SETUP_COMPLETE=true` in `.env` to skip the wizard.

---

## 🐳 Docker

```bash
cp .env.example .env      # optional: pre-seed values
docker compose up -d
```

Then browse to `http://<host>:8080/setup` for first-time setup, or mount an existing `.env` to skip it. Audio, database, models, and logs are persisted via volumes defined in `docker-compose.yml`.

---

## 🧙 The Setup Wizard, step by step

The wizard writes a fully-commented `.env` for you and validates each section with live health checks.

1. **Welcome & API key** — generates the API key your radio sources will use to upload calls. **Copy it** — you'll need it in SDRTrunk/TrunkRecorder.
2. **Map & location** — auto-detects your location (with a manual address-search fallback if location is off or returns `0,0`) and sets the map's default center/zoom.
3. **Geocoding** — choose Google Maps or LocationIQ, set your **target counties** and **cities** (auto-populate every city in a county with one click). *Only listed cities/counties get plotted* — this keeps the map focused and the AI efficient.
4. **Transcription** — pick a provider:
   - **Local (faster-whisper)** — GPU auto-detection and **one-click install** of the right PyTorch + dependencies into a project virtual environment.
   - **Remote faster-whisper**, **OpenAI Whisper**, or **ICAD** — with connection tests.
   - Optional **whitelist/blacklist** of talkgroups to transcribe.
5. **AI features** — OpenAI or **Ollama** (which can run on another machine; the wizard lists its installed models). Configure address extraction and summaries, and optionally scope summaries to specific talkgroups.
6. **Discord** *(optional)* — step-by-step bot creation, with the exact **intents/permissions** to enable in the Developer Portal.
7. **Network & auth** — web port (default **80**), upload port (default **3306**), and optional login protection.
8. **Talkgroups** — import one or more RadioReference CSVs **per system**, search/sort, and tick which talkgroups should be mapped. A **“Check dispatch only”** helper selects just the dispatch channels (where addresses are actually announced).

---

## ⚙️ The live Settings page

After setup, open **Settings** from the map's menu (or go to `/settings`). It's themed like the map — retro black & green — and merges every admin tool into one place:

- **API keys & health** — view/rotate keys, run live checks on geocoding, AI, transcription, and Discord.
- **Transcription / AI** — change providers and the talkgroup whitelist/blacklist on the fly.
- **Talkgroups** — re-import, filter by system, and toggle mapping.
- **Discord tools** — filter & sort channels, then **bulk-delete** selected channels and/or categories (rate-limit aware), or sweep empty channels.
- **Manual plot** — find transcribed calls with no location and pin them by address or `lat, lon`.
- **Users & sessions** — create admins, revoke sessions.
- **Call purge** — bulk-remove calls by talkgroup/time with undo.
- **Maintenance** — database stats, **one-click DB backup**, and a log viewer.
- **Updates** — check for new releases and self-update.

---

## 📡 Connecting your radio source

Use the **API key** generated during setup and your **upload port** (default `3306`).

### SDRTrunk
`Playlist → Streaming → +rdio-scanner` → set the server to `http://<server>:3306`, enter your **System ID** and **API key**, and enable per-alias streaming.

### TrunkRecorder
Add an upload server to `config.json` (TrunkRecorder sends *all* audio — use the transcription whitelist to filter):

```json
"uploadServer": "http://<server>:3306",
"uploadServerKey": "<your-api-key>",
"shortName": "<your-system-name>"
```

> The `shortName` becomes the **system** name — match it when importing that system's talkgroup CSV so overlapping IDs map correctly.

### rdio-scanner (downstream)
Add Scanner Map as a downstream server with the URL `http://<server>:3306` and your API key.

---

## 🔧 Configuration reference

Everything lives in `.env` (generated by the wizard). Highlights:

| Key | Purpose |
|-----|---------|
| `WEBSERVER_PORT` / `BOT_PORT` | Web UI port (default 80) / call-upload port (default 3306) |
| `PUBLIC_DOMAIN` | Public URL for share/playback links. Leave blank for local (`http://localhost:<port>`) |
| `TRANSCRIPTION_MODE` | `local` \| `remote` \| `openai` \| `icad` |
| `PYTHON_COMMAND` | Python interpreter for local transcription (auto-set to the project `.venv`) |
| `TRANSCRIBE_MODE` / `TRANSCRIBE_TALK_GROUPS` | `all` \| `whitelist` \| `blacklist` + the talkgroup list |
| `AI_PROVIDER` | `ollama` \| `openai` for address extraction & summaries |
| `STORAGE_MODE` | `local` \| `s3` \| `r2` \| `b2` \| `minio` \| `db` |
| `GEOCODING_TARGET_COUNTIES` / `TARGET_CITIES_LIST` | Where calls are allowed to plot |
| `ENABLE_AUTH` | Require login to view the map |

Map look-and-feel (icons, default layers) lives in `public/config.js`.

---

## 🔄 Updating

From the **Settings → Updates** tab, or manually:

```bash
# Windows
scripts\update.ps1
# Linux / macOS
bash scripts/update.sh
```

This pulls the latest code, installs dependencies, and runs database migrations.

---

## 🗂️ Project structure

```
Scanner-map/
├─ start.js / start.bat / start.sh   # launcher + auto-restart
├─ bot.js                            # call ingestion, transcription, Discord, geocoding
├─ webserver.js                      # map UI, REST API, settings, setup mount
├─ geocoding.js                      # address extraction + geocoding
├─ transcribe.py / tone_detect.py    # local Whisper + two-tone detection
├─ import_csv.js                     # talkgroup CSV importer (system-aware)
├─ src/
│  ├─ setup/      # setup wizard server, routes, env writer, python env, maintenance
│  ├─ db/         # migrations
│  ├─ storage/    # local / S3-compatible / db backends
│  ├─ security/   # auth, sessions, API keys
│  └─ utils/      # helpers (public URL, etc.)
├─ public/        # map UI, setup wizard, settings page
├─ scripts/       # migrate, reset-setup, update, syntax-check
└─ installers/    # install.ps1 / install.sh
```

---

## 🛠️ Troubleshooting

| Symptom | Fix |
|---------|-----|
| `ModuleNotFoundError: No module named 'torch'` | Local transcription needs its Python deps. Re-run the Transcription step's installer, or point `PYTHON_COMMAND` at a Python 3.9–3.12 with `faster-whisper` installed. |
| `CUDA capability sm_120 is not compatible` warning | Harmless — torch is only used to *detect* the GPU; inference runs on CTranslate2. |
| Audio links use the wrong port | Set `PUBLIC_DOMAIN`, or leave it blank to derive `http://localhost:<WEBSERVER_PORT>`. |
| Port 80 won't bind | Use a different `WEBSERVER_PORT`, or run elevated (Linux) / free the port (Windows IIS/Skype). |
| Need to redo first-time setup | `node scripts/reset-setup.js` (add `--hard` to also wipe the database). |
| Logs | `combined.log` and `error.log`, or the Settings → Maintenance log viewer. |

---

## 🤝 Contributing & support

Issues and pull requests are welcome on the [GitHub repo](https://github.com/poisonednumber/Scanner-map). For help, open an issue or reach **poisonednumber** on Discord.

## 📜 License

[MIT](LICENSE) © the Scanner Map contributors.
