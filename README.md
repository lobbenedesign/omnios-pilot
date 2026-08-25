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

### 🖱️ NEW: Real pixel-coordinate click dispatch

Closing part of the gap noted above (and matching a capability Anthropic's Claude Computer Use, OpenAI's Computer Use/Operator, and bytedance/UI-TARS all advertise: dispatching a real mouse event at an arbitrary screen coordinate):

- `MouseKeyboardDriver.clickAt(x, y, processName?)` (`src/mouse_keyboard_driver.ts`) dispatches a **real** macOS mouse click at absolute screen pixel coordinates via `osascript -e 'tell application "System Events" to tell process "<name>" to click at {x, y}'`. Verified directly on this machine:
  ```
  $ osascript -e 'tell application "System Events" to tell process "Finder" to click at {300, 300}'
  (exit 0)
  ```
  Note the click must be sent to a named *process* object — sending `click at {x,y}` straight to the `System Events` application object fails with AppleScript error `-609` ("invalid connection"); the System Events dictionary (`sdef`) documents the `at` parameter as belonging to the `process` class, not the `application` class.
- `doubleClickAt(x, y, processName?)` sends two real clicks 120ms apart.
- `pressKeyCode(keyCode, modifiers?)` sends a real macOS virtual-key-code keyboard shortcut (e.g. Cmd+C) via `System Events key code ... using {command down}`, distinct from the plain-text `keystroke` already used by `typeText`.
- New endpoints, all real and curl-verified: `POST /api/pilot/click {x,y,process,double}`, `POST /api/pilot/keycode {keyCode,modifiers}`, and `actionType: "click" | "double_click"` on the existing `POST /api/pilot/execute`.
- **Closed observe → click → re-observe loop in the UI**: clicking directly on the rendered screenshot in the dashboard (`public/app.js`, `setupCanvasClickToRealClick`) maps the click's canvas position back to real absolute screen coordinates (using the actual scale/offset the screenshot was drawn at) and dispatches a genuine `POST /api/pilot/click` — then you can re-run "Analyze & Plan" to capture a fresh screenshot and see the result. This is a manual click-through-image loop, not an autonomous agent deciding where to click on its own — see the honesty note below.

An invalid target still fails honestly rather than faking success — tested with a nonexistent process name:
```json
{"action":"clickAt(100, 100)","target":"ThisAppDoesNotExist123","output":"","success":false,"durationMs":6564.25,"driverType":"AppleScript_SystemEvents_Native"}
```

### 👁️→🖱️→👁️ NEW: Real observe-act-verify loop + action history + multi-step planning

- **Real before/after verification** (`src/verification.ts`, wired into `server.ts`'s `runWithVerification`): pass `"verify": true` to `POST /api/pilot/execute` (or run a plan, see below) and the server captures a genuine "before" screenshot to `/tmp/omnios_verify_before.png`, dispatches the real action, waits 500ms for the UI to settle, captures a genuine "after" screenshot, and computes a real pixel-difference percentage between the two PNG files by shelling out to `python3` + Pillow (`ImageChops.difference`). If Ollama is reachable, the "after" screenshot is also captioned. Verified end-to-end on this machine with real actions (`notify`, `activate_app`) — e.g. activating TextEdit produced a real `changedPixelPercent` of 86.24 and a genuine moondream caption of the resulting screen.
  - **Honesty about what this proves**: `changedPixelPercent` is a coarse "did the screen change at all" signal, not a semantic judgement that the intended UI element was clicked or that the goal was achieved — the menu-bar clock ticking over alone produces a small nonzero diff, and a failed click that still shakes the window shadow can produce a nonzero diff too. It does not verify success; it verifies that *something* visibly happened.
  - The diff needs a `python3` with Pillow (PIL) on `PATH`; `computePixelDiff` tries a short list of common interpreter paths (plain `python3`, then a few Homebrew locations) and returns an explicit `"unavailable"` result with an `error` field if none has Pillow, rather than fabricating a percentage.
- **Real disk-persisted action history** (`src/action_history.ts`): every action dispatched through `/api/pilot/execute` or `/api/pilot/execute-plan` is appended as one JSON line to `data/action_history.jsonl` (including its verification data, if requested, and failures). `GET /api/pilot/history?limit=N` reads it back most-recent-first; `DELETE /api/pilot/history` clears it. Verified with real entries on disk from real notify/activate_app calls during testing.
- **Real multi-step planning via a local Ollama text model** (`VisionGroundingAgent.planMultiStep` in `src/vision_agent.ts`, default model `llama3.2:3b`): `POST /api/pilot/plan-multistep {goal}` sends the goal plus the genuine live process list to Ollama and asks it to decompose the goal into an ordered JSON array of steps (`activate_app` / `keystroke` / `notify` / `inspect_windows`). This is a real LLM call whose raw response is parsed and schema/safety-filtered — not a scripted template. If Ollama is unreachable, the model isn't pulled, or the output can't be parsed as valid steps, the endpoint returns an explicit `error` and an **empty** step list rather than a fabricated plan.
- **Real multi-step execution**: `POST /api/pilot/execute-plan {goal, steps, verify?}` runs each step through the *same* `SafetyGuard.evaluateAction` check used by `/api/pilot/execute`, stopping immediately at the first unsafe or failed step, and logs every step to the real action history with its plan goal/index. Verified end-to-end on this machine: a planned+executed 2-step sequence (`activate_app "TextEdit"` → `notify`) really opened TextEdit and really showed a notification, both with real before/after verification and both persisted to `data/action_history.jsonl` with `planStepIndex`/`planGoal`.

### ❌ What this project still does NOT do (be aware before relying on it)

- **No model-driven visual grounding.** Nothing in this codebase looks at the screenshot and *decides* which `(x, y)` to click — the coordinate has to be supplied by the caller (a human clicking the screenshot in the UI, or an API caller). The Ollama vision call only produces a text description, never coordinates or bounding boxes. If you want an LLM to choose where to click, you still have to build that planning layer on top of `/api/pilot/click`.
- **No independent benchmark** against UI-TARS, Claude Computer Use, ShowUI, or OSWorld. `src/competitor_benchmark.ts` is now a plain, unscored feature comparison based on each project's public documentation — it does not run any of those systems.
- **Not a full autonomous agent loop.** Even with `/api/pilot/plan-multistep` + `/api/pilot/execute-plan`, the planner produces a fixed step list up front from a single Ollama call — it does not re-plan after seeing each step's real result, and nothing loops on its own deciding "click here, observe, click again, replan" without a human or external caller triggering each top-level call.
- **Verification is not a success oracle.** `changedPixelPercent` only tells you the screen looks different, not that the intended outcome happened — see the honesty note above. Treat it, and the optional vision caption, as debugging signals, not pass/fail proof.

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
| `/api/pilot/click` | POST `{x, y, process?, double?}` | Real pixel-coordinate mouse click via System Events, curl-verified. |
| `/api/pilot/keycode` | POST `{keyCode, modifiers?}` | Real keyboard shortcut (e.g. Cmd+C) via System Events `key code ... using {...}`. |
| `/api/safety/panic`, `/api/safety/reset` | POST | Real server-side state toggle enforced on every `/api/pilot/execute` call. |
| `/api/competitors` | GET | Honest qualitative feature comparison, no invented scores. |
| `/api/pilot/execute` (add `"verify": true`) | POST | Same as above, plus a real before/after screenshot pair, a real pixel-diff percentage, and an optional real Ollama caption of the resulting screen. |
| `/api/pilot/plan-multistep` | POST `{goal}` | Real Ollama text-model call (default `llama3.2:3b`) that decomposes the goal into a JSON step list. Returns an explicit `error` + empty steps on failure, never a fabricated plan. |
| `/api/pilot/execute-plan` | POST `{goal, steps, verify?}` | Executes each planned step through the real safety guard + driver, stopping at the first unsafe/failed step; logs every step to the action history. |
| `/api/pilot/history` | GET `?limit=N`, DELETE | Reads back / clears the real disk-persisted action history log (`data/action_history.jsonl`). |

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

### 👁️→🖱️→👁️ NOVITÀ: ciclo reale osserva-agisci-verifica + cronologia azioni + pianificazione multi-step

- **Verifica reale prima/dopo** (`src/verification.ts`, integrata in `runWithVerification` in `server.ts`): passando `"verify": true` a `POST /api/pilot/execute` (o eseguendo un piano, vedi sotto) il server cattura uno screenshot "prima" reale, esegue l'azione reale, attende 500ms, cattura uno screenshot "dopo" reale e calcola una percentuale reale di differenza pixel tra i due PNG con `python3` + Pillow (`ImageChops.difference`). Se Ollama è raggiungibile, lo screenshot "dopo" viene anche descritto. Verificato end-to-end su questa macchina con azioni reali (`notify`, `activate_app`): attivare TextEdit ha prodotto un `changedPixelPercent` reale dell'86.24% e una didascalia genuina di moondream.
  - **Onestà su cosa questo dimostra**: `changedPixelPercent` è un segnale grezzo di "lo schermo è cambiato", non un giudizio semantico che l'elemento UI previsto sia stato effettivamente cliccato o che l'obiettivo sia stato raggiunto — anche il solo orologio nella barra dei menu produce una differenza non nulla. Non verifica il successo, verifica che *qualcosa* sia visibilmente accaduto.
  - Il diff richiede un `python3` con Pillow su `PATH`; `computePixelDiff` prova alcuni percorsi comuni (incluso Homebrew) e restituisce onestamente `"unavailable"` con un `error` se nessuno ha Pillow, invece di inventare una percentuale.
- **Cronologia azioni reale, persistita su disco** (`src/action_history.ts`): ogni azione dispatchata tramite `/api/pilot/execute` o `/api/pilot/execute-plan` viene aggiunta come riga JSON a `data/action_history.jsonl` (inclusi i dati di verifica, se richiesti, e i fallimenti). `GET /api/pilot/history?limit=N` la rilegge dalla più recente; `DELETE /api/pilot/history` la svuota. Verificato con voci reali su disco durante i test.
- **Pianificazione multi-step reale via modello di testo Ollama locale** (`VisionGroundingAgent.planMultiStep`, modello default `llama3.2:3b`): `POST /api/pilot/plan-multistep {goal}` invia l'obiettivo e la lista reale dei processi in esecuzione a Ollama e chiede di scomporre l'obiettivo in una sequenza JSON di step (`activate_app` / `keystroke` / `notify` / `inspect_windows`). È una vera chiamata LLM la cui risposta grezza viene analizzata e filtrata per schema/sicurezza — non un template scriptato. Se Ollama non è raggiungibile o l'output non è analizzabile, l'endpoint restituisce un `error` esplicito e una lista di step **vuota**, mai un piano inventato.
- **Esecuzione multi-step reale**: `POST /api/pilot/execute-plan {goal, steps, verify?}` esegue ogni step tramite lo stesso controllo `SafetyGuard.evaluateAction` usato da `/api/pilot/execute`, fermandosi al primo step non sicuro o fallito, e registra ogni step nella cronologia reale. Verificato end-to-end: una sequenza pianificata+eseguita di 2 step (`activate_app "TextEdit"` → `notify`) ha realmente aperto TextEdit e mostrato una notifica, entrambe con verifica prima/dopo reale e persistite in `data/action_history.jsonl` con `planStepIndex`/`planGoal`.

### ❌ Cosa questo progetto NON fa (da sapere prima di farci affidamento)

- **Nessun puntamento visivo guidato da modello.** Nessun componente del codice guarda lo screenshot e *decide* autonomamente quali coordinate `(x, y)` cliccare — la coordinata deve essere fornita dal chiamante (un umano che clicca sullo screenshot nella UI, o un chiamante API). Il click reale a coordinate **ora esiste** (`POST /api/pilot/click`, vedi sezione 🇬🇧 sopra per i dettagli e la verifica reale), ma è un primitivo di esecuzione, non un pianificatore visivo.
- **Nessun benchmark indipendente** contro UI-TARS, Claude Computer Use, ShowUI o OSWorld. `src/competitor_benchmark.ts` è ora un semplice confronto qualitativo di funzionalità basato sulla documentazione pubblica di ciascun progetto — non esegue nessuno di quei sistemi.
- **Non è un agente autonomo completo.** Anche con `/api/pilot/plan-multistep` + `/api/pilot/execute-plan`, il planner produce una lista di step fissa a priori da un'unica chiamata Ollama — non ripianifica dopo aver visto il risultato reale di ogni step, e nessun componente ripete da solo "clicca, osserva, clicca di nuovo, ripianifica" senza un umano o un chiamante esterno che avvii ogni chiamata di alto livello. Cliccare direttamente sullo screenshot renderizzato nella dashboard dispatcha comunque un click reale mappato alle coordinate assolute dello schermo — è un ciclo manuale click-attraverso-immagine, non un agente autonomo.
- **La verifica non è un oracolo di successo.** `changedPixelPercent` dice solo che lo schermo appare diverso, non che l'esito previsto si sia verificato — vedi la nota di onestà sopra. Trattalo, insieme alla didascalia visiva opzionale, come un segnale di debug, non come una prova pass/fail.

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
