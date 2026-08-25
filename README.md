# 🖥️ OmniOS-Pilot

[![Bun](https://img.shields.io/badge/Bun-v1.4+-black.svg?logo=bun)](https://bun.sh/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.0+-blue.svg?logo=typescript)](https://www.typescriptlang.org/)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)

[English 🇬🇧](#english) • [Italiano 🇮🇹](#italiano)

> **A small local server that automates macOS via real AppleScript/System Events commands, with a human-in-the-loop safety guard and an optional local vision-language description of the screen through Ollama.**
>
> *Un piccolo server locale che automatizza macOS tramite veri comandi AppleScript/System Events, con un controllo di sicurezza human-in-the-loop e una descrizione opzionale della schermata tramite un modello di visione locale via Ollama.*

![OmniOS-Pilot Dashboard](./public/screenshot.jpg)

---

<a name="english"></a>
## 🇬🇧 English Documentation

### ⚠️ Honesty note (read this first)

An earlier version of this README claimed "97.4% pixel-coordinate visual grounding", "sub-10ms CoreGraphics driver execution", and a benchmark table with invented accuracy numbers for OmniOS-Pilot and four other research projects. **None of that was ever measured** — those were hardcoded numbers in `src/competitor_benchmark.ts` with no model or benchmark behind them, and the frontend rendered fake bounding boxes/crosshairs that were never produced by any vision model. That copy has been removed. This README now describes only what the code actually does.

### ✅ What actually works today

1. **Real macOS automation** (`src/mouse_keyboard_driver.ts`): launches/activates apps, types keystrokes into the frontmost app, and shows native notifications — all via genuine `osascript` (AppleScript / System Events) calls, not simulated.
2. **Real process & screen state** (`src/vision_agent.ts`): enumerates actually-running, visible macOS applications and the real frontmost app via System Events, and captures a real screenshot to disk with `/usr/sbin/screencapture`.
3. **Optional real vision-language description**: if a local [Ollama](https://ollama.com) server is reachable at `localhost:11434` with a vision-capable model pulled (default: `moondream`), the captured screenshot is sent to it and its genuine text description is shown in the UI. If Ollama isn't running or the call fails, the UI says so explicitly — it never fabricates a description.
4. **Human-in-the-loop safety guard** (`src/safety_guard.ts`): blocks any action whose text payload contains `rm -rf`, `sudo`, or `delete`, and a "Panic Switch" that freezes all `/api/pilot/execute` calls until reset — both enforced server-side, verified with `curl` (dangerous payloads get a real `403`).
5. **Goal → action heuristic**: a simple keyword match (`apri`/`open`/`launch`, `scrivi`/`type`) picks an `actionType` and target app from the running-process list. This is plain string matching, not an ML planner, and the UI labels it as such.

### ❌ What this project does NOT do (be aware before relying on it)

- **No pixel-coordinate visual grounding.** There is no model that outputs `(x, y)` click coordinates or bounding boxes. Real mouse click-at-coordinates is not implemented (no `cliclick` or CoreGraphics event tap integration exists in this codebase).
- **No independent benchmark** against UI-TARS, Claude Computer Use, ShowUI, or OSWorld. `src/competitor_benchmark.ts` is now a plain, unscored feature comparison based on each project's public documentation — it does not run any of those systems.
- **Not a full autonomous agent loop.** Planning and execution are separate manual steps triggered by UI buttons; there's no closed-loop "observe → click → re-observe" agent yet.

### 🛠️ Quick Start

```bash
# 1. Clone the repository
git clone https://github.com/lobbenedesign/omnios-pilot.git
cd omnios-pilot

# 2. (Optional) Install Ollama and pull a vision model for real scene descriptions
#    brew install ollama && ollama pull moondream

# 3. Run with Bun
bun server.ts
```

Open your browser at **`http://localhost:3007`**. macOS will prompt for Accessibility/Automation permissions the first time a real AppleScript command runs (Finder activation, keystrokes, notifications, screen recording for `screencapture`) — grant them, or the corresponding action will fail with a real, visible error rather than a silent fake success.

### API surface (all real, verified with curl)

| Endpoint | Method | What it actually does |
| --- | --- | --- |
| `/api/status` | GET | Reports whether Ollama is actually reachable and the real screen resolution (via AppleScript), not fixed strings. |
| `/api/pilot/processes` | GET | Real visible process list + real frontmost app via System Events. |
| `/api/pilot/screenshot` | GET | Triggers a real `screencapture` and returns the file path. |
| `/api/pilot/screenshot-file` | GET | Serves the actual captured PNG bytes. |
| `/api/pilot/plan` | POST `{goal}` | Real process list + real screenshot + optional real Ollama vision description + keyword-based action heuristic + safety check. |
| `/api/pilot/execute` | POST `{actionType, target, textPayload}` | Runs the safety check, then actually dispatches the AppleScript action (launch app / type text / show notification). Blocked actions return real `403`s. |
| `/api/pilot/launch`, `/api/pilot/type`, `/api/pilot/notify` | POST | Direct real driver calls, bypassing planning. |
| `/api/safety/panic`, `/api/safety/reset` | POST | Real server-side state toggle enforced on every `/api/pilot/execute` call. |
| `/api/competitors` | GET | Honest qualitative feature comparison, no invented scores. |

---

<a name="italiano"></a>
## 🇮🇹 Documentazione in Italiano

### ⚠️ Nota di onestà (leggere prima di tutto)

Una versione precedente di questo README dichiarava "97.4% di precisione di puntamento a coordinate pixel", "esecuzione driver CoreGraphics sub-10ms" e una tabella di benchmark con numeri di accuratezza inventati per OmniOS-Pilot e altri quattro progetti di ricerca. **Nulla di tutto ciò è mai stato misurato** — erano numeri fissi in `src/competitor_benchmark.ts` senza alcun modello o benchmark dietro, e il frontend disegnava bounding box/crosshair finti mai prodotti da nessun modello di visione. Quel testo è stato rimosso. Questo README descrive ora solo ciò che il codice fa realmente.

### ✅ Cosa funziona davvero oggi

1. **Automazione macOS reale** (`src/mouse_keyboard_driver.ts`): avvia/attiva app, digita testo nell'app in primo piano, mostra notifiche native — tutto tramite vere chiamate `osascript` (AppleScript / System Events).
2. **Stato reale di processi e schermo** (`src/vision_agent.ts`): elenca le app macOS effettivamente in esecuzione e visibili e l'app realmente in primo piano via System Events, e cattura uno screenshot reale su disco con `/usr/sbin/screencapture`.
3. **Descrizione visiva opzionale e reale**: se un server [Ollama](https://ollama.com) locale è raggiungibile su `localhost:11434` con un modello di visione scaricato (default: `moondream`), lo screenshot catturato viene inviato al modello e la sua descrizione testuale genuina viene mostrata nella UI. Se Ollama non è attivo o la chiamata fallisce, la UI lo dichiara esplicitamente — non inventa mai una descrizione.
4. **Guardia di sicurezza human-in-the-loop** (`src/safety_guard.ts`): blocca ogni azione il cui testo contiene `rm -rf`, `sudo` o `delete`, e un "Panic Switch" che congela ogni chiamata a `/api/pilot/execute` finché non viene resettato — entrambi applicati lato server, verificati con `curl` (i payload pericolosi ricevono un vero `403`).
5. **Euristica obiettivo → azione**: un semplice confronto di parole chiave (`apri`/`open`/`launch`, `scrivi`/`type`) seleziona un `actionType` e un'app target dalla lista dei processi in esecuzione. È puro pattern matching su stringhe, non un pianificatore ML, e la UI lo etichetta come tale.

### ❌ Cosa questo progetto NON fa (da sapere prima di farci affidamento)

- **Nessun puntamento visivo a coordinate pixel.** Non esiste alcun modello che produca coordinate `(x, y)` di click o bounding box. Il click reale a coordinate non è implementato (nessuna integrazione con `cliclick` o CoreGraphics event tap in questo codebase).
- **Nessun benchmark indipendente** contro UI-TARS, Claude Computer Use, ShowUI o OSWorld. `src/competitor_benchmark.ts` è ora un semplice confronto qualitativo di funzionalità basato sulla documentazione pubblica di ciascun progetto — non esegue nessuno di quei sistemi.
- **Non è un agente autonomo completo.** Pianificazione ed esecuzione sono passi manuali separati attivati da pulsanti nella UI; non esiste ancora un ciclo chiuso "osserva → clicca → ri-osserva".

### 🛠️ Avvio Rapido

```bash
git clone https://github.com/lobbenedesign/omnios-pilot.git
cd omnios-pilot

# (Opzionale) installa Ollama e scarica un modello di visione per descrizioni reali
# brew install ollama && ollama pull moondream

bun server.ts
```

Apri il browser all'indirizzo **`http://localhost:3007`**. macOS chiederà i permessi di Accessibilità/Automazione al primo comando AppleScript reale (attivazione Finder, digitazione, notifiche, registrazione schermo per `screencapture`) — concedili, altrimenti l'azione corrispondente fallirà con un errore reale e visibile invece di un falso successo silenzioso.

---

## 📄 License
Released under the [MIT License](LICENSE).
