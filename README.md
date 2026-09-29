# GAME STUDIO — lo studio virtuale di TQ:EVS

Un piccolo studio di sviluppo con agenti AI che lavorano sul gioco. Tu parli con **una sola chat** (la **Regia**);
la Regia smista il lavoro alla squadra, segue le dipendenze, fa testare e ti scrive il rapporto finale.

| Agente (nome provvisorio) | id | Fa |
|---|---|---|
| **Tizo** — Lead Developer | `dev` | codice del gioco, gameplay, bug |
| **Tizia** — QA / Game Tester | `qa` | test automatici + gioco vero nel browser, bug report (non corregge) |
| **Coso** — Narrative & Copy | `narrative` | dialoghi, testi, voce dei personaggi |
| **Cosetta** — Art / Visual Assets | `art` | brief degli asset, coerenza visiva, immagini generate |
| **Mappo** — Level Designer | `level` | mappe, rioni, posizione di NPC, bersagli e luci |
| **Rumore** — Suono & Musica | `audio` | effetti, integrazione delle tracce, volumi |
| **Custode** — Custode della Bibbia | `lore` | canone, coerenza, cosa riportare nella Bibbia del mondo |
| **Enigma** — Enigmista | `puzzle` | indagini ed enigmi: indizi, prerequisiti, soluzioni |
| **Arredo** — Responsabile dell'ufficio | `office` | arreda l'ufficio e cambia l'aspetto dei personaggi su tuo ordine; su richiesta modifica l'interfaccia dello Studio |
| Regia — Director (solo in chat) | `director` | capisce, pianifica, delega, riferisce |

Lo Studio è un **repository separato** dal gioco. Sul Mac le due cartelle stanno una accanto all'altra:

```
Downloads/
├── tq-evs/          ← il GIOCO (repository privato a parte): codice, livelli, asset + docs/memoria/
└── tq-evs-studio/   ← lo STUDIO (questo repository): server, interfaccia, agenti, ufficio
```

Il gioco non contiene codice dello Studio. Nel gioco c'è solo la memoria di progetto (`docs/memoria/`), che
descrive il gioco e viaggia con lui. Se il gioco sta altrove: `STUDIO_PROJECT_ROOT=/percorso` nel file `.env`.

---

## Accendere lo Studio

Apri il Terminale e scrivi:

```bash
cd ~/Downloads/tq-evs-studio && ./start-studio.sh
```

Si apre il browser su **http://localhost:4173**. La prima volta installa da solo quello che serve (un paio di minuti).

- Serve **Node.js 18+** (`brew install node` se manca) e **git**.
- Gli agenti usano **Claude Code** (il comando `claude` che hai già): nessuna chiave da configurare.

## Spegnerlo

```bash
cd ~/Downloads/tq-evs-studio && ./stop-studio.sh
```

I lavori in corso non si perdono: alla riaccensione ripartono da dove erano.

## Giocare

- Versione attuale del gioco: pulsante **▶ Gioca** in alto (oppure http://localhost:4173/play/main/).
- Versione modificata da una richiesta, prima di unirla: **▶ Gioca questa versione** sotto il rapporto.
- Il vecchio modo funziona sempre: `python3 tools/serve.py` → http://localhost:8123

---

## Come lavorano gli agenti

1. Scrivi alla Regia, per esempio: *«Il boss è noioso e il dialogo prima è troppo lungo»*.
2. La Regia decide: risponde e basta, oppure crea dei **task** e li assegna (Coso → dialogo, Tizo → meccaniche,
   Tizia → test). Li vedi nella chat e sulle postazioni: ogni agente mostra **nome, ruolo, stato, task corrente**.
3. Stati: `IDLE` libero · `THINKING` pensa · `WORKING` lavora · `WAITING` aspetta un altro · `TESTING` testa ·
   `BLOCKED` serve te · `DONE` fatto · `ERROR` errore.
4. Ogni modifica al gioco viene **testata da Tizia**: controlli statici + il gioco vero aperto in un browser
   automatico (menu e tutti i livelli), più eventuali prove mirate. Se trova un difetto lo rimanda a Tizo con un bug
   report; Tizo corregge, Tizia riprova. Al massimo **3 giri**, poi la Regia chiede a te (niente loop infiniti).
5. Alla fine la Regia scrive il **rapporto**: cosa è cambiato, chi ha lavorato, test fatti, file cambiati, commit.

Clic su un agente → pannello con task corrente, attività recente, task completati, errori, dipendenze e configurazione.

## Come funzionano i task

- Ogni tuo messaggio è una **richiesta** (`R-0001`), divisa in **task** (`T-0001`, …) con **dipendenze**
  (un task parte solo quando quelli da cui dipende sono finiti). Agenti diversi lavorano in parallelo; nella stessa
  richiesta scrive sui file un agente alla volta.
- Un task in errore viene riprovato una volta; poi la richiesta passa a te (`serve una tua decisione`) con i
  pulsanti **Riprova** / **Ferma** / **Scarta**.
- Tab **Task** (sotto le postazioni): tutte le richieste e i task, clic per i dettagli (istruzioni, risultato, bug,
  screenshot del test). Tab **Attività**: il flusso degli eventi in diretta.

## Il tuo lavoro è al sicuro (git)

- Ogni richiesta lavora in una **copia separata** del gioco (git worktree in `tq-evs-studio/data/worktrees/`) su un
  **branch suo** nel repository del gioco (`studio/r-0001-…`). La cartella del gioco non viene toccata.
- Ogni task che cambia file = **un commit a nome dell'agente** (es. autore `Tizo (Studio)`, riga `Studio-Agent: dev`).
- Quando sei soddisfatto: **Unisci in main**. Lo Studio unisce solo se nella tua cartella non ci sono modifiche non
  salvate, e sempre con un merge separato.
- Non ti piace? **Scarta** (cancella branch e copia) — oppure, se l'avevi già unita, **Annulla unione**.

### Tornare indietro a mano (Terminale, nella cartella del gioco)

```bash
cd ~/Downloads/tq-evs
git log --oneline --merges          # trova l'unione dello Studio ("Studio: unisce R-…")
git revert -m 1 <codice-commit>     # la annulla con un nuovo commit (non si perde niente)
git branch --list 'studio/*'        # i branch delle richieste
git worktree list                   # le copie di lavoro
```

Per togliere lo Studio basta spegnerlo e cancellare la cartella `tq-evs-studio`: il gioco non ne ha bisogno.

---

## Cambiare nome a un agente

Clic sull'agente → sezione **Configurazione** → cambia **Nome** e **Ruolo** → **Salva**.
(Oppure pulsante **Agenti** in alto → **Modifica**.) Il lavoro continua uguale: lo Studio instrada per `id` e tipo di
task, non per nome. **Ripristina predefinito** riporta i valori di partenza.

## L'ufficio

La parte alta dello Studio è la **sede della Pro Loco** in pixel art isometrica: ogni agente siede alla sua
postazione e si anima secondo lo stato (Tizo scrive codice e lo schermo scorre, Tizia gioca alla TV col pad, Coso
batte a macchina, Cosetta dipinge al cavalletto; `?` giallo = serve te, `!` rosso = errore, coriandoli = fatto).
Le luci seguono l'ora vera (giorno, tramonto, notte). Clic su un personaggio → dettaglio dell'agente.

L'ufficio è un file di dati: `config/office.default.json` (stanza, postazioni per id agente, arredi).
Per personalizzarlo copialo in `data/office.json` e modificalo: lo Studio usa quello. Tipi di postazione:
`pc`, `tv`, `typewriter`, `easel`, `table`; arredi: `window`, `banner`, `noticeboard`, `map`, `clock`, `lantern`,
`rug`, `plant`, `crates`, `sideboard`, `bench`. Il disegno è tutto in `web/office.js`.

### Il Responsabile dell'ufficio

Chiedi in chat, per esempio *«metti una pianta grande vicino alla finestra e dai a Tizia i capelli corti»*:
la Regia passa il lavoro al Responsabile dell'ufficio, che modifica l'arredo e l'aspetto dei personaggi. Il cambiamento
si vede subito; se non ti piace, **↶ Annulla ultimo arredo** (in alto a destra nell'ufficio) riporta tutto com'era
(le versioni precedenti stanno in `data/office-history/`).

Se chiedi modifiche al **programma** dello Studio (interfaccia, colori, animazioni), il Responsabile lavora su un branch
del repository dello Studio, lo Studio controlla la sintassi e lancia i suoi test; poi premi **Unisci** e riavvii lo
Studio. Il gioco non viene mai toccato.

Laboratorio dei personaggi (tutte le pose): http://localhost:4173/sprite-lab.html?all=1

## Cambiare l'avatar

Nello stesso pannello, riquadro **Avatar**:

- **pixel** (predefinito): personaggio in pixel art disegnato in codice — scegli pelle, capelli, occhi, pettinatura,
  vestito (maglietta, camicia, felpa, maglione, grembiule, camice, gilet), barba, accessorio.
  È lo stesso personaggio che siede nell'ufficio.
- **emoji**: scegli emoji e colore.
- **image**: carica un'immagine (png/jpg/gif/webp/svg).
- **spritesheet**: carica un foglio di sprite in pixel art, indica la misura di un fotogramma (es. 32×32) e le
  animazioni, per esempio `{"idle":{"row":0,"frames":2,"fps":2},"typing":{"row":1,"frames":4,"fps":8}}`.
- **Stato → animazione**: quale animazione usare per ogni stato, es. `{"WORKING":"typing","TESTING":"playing"}`.
  Predefiniti: WORKING→typing, TESTING→playing, THINKING→writing-notes, WAITING→waiting, BLOCKED→question,
  DONE→celebrate, ERROR→error, IDLE→idle.

Gli avatar caricati stanno in `data/avatars/`. Il disegno degli avatar è in `web/avatars.js` e `web/pixel.js`.

## Configurare i provider AI

Il provider di ogni agente è `auto` = il primo disponibile fra:

1. **Claude Code** (consigliato): il comando `claude` già installato e autenticato. Niente da fare.
   Se lo Studio non lo trova: `which claude` e scrivi il percorso nel file `.env` dello Studio come `CLAUDE_CODE_BIN=…`.
2. **API Anthropic**: chiave nel file `.env` → `ANTHROPIC_API_KEY=sk-ant-…`
3. **ChatGPT (Codex)**: col tuo account ChatGPT, senza chiavi.
   ```bash
   npm i -g @openai/codex && codex login
   ```
   Poi nel pannello di un agente scegli **Provider = codex** (per esempio un secondo QA, o Cosetta). Se `codex` non
   è nel PATH: `CODEX_BIN=/percorso/codex` nel file `.env`.
4. **Gemini come agente** (testo/codice): `npm i -g @google/gemini-cli`, poi lancia una volta `gemini` e fai il login con
   Google. Nel pannello dell'agente: **Provider = gemini**.
5. **Immagini** (Cosetta o qualunque agente che genera immagini) — nel pannello dell'agente, *Provider immagini*:
   - **GPT Image 2** (OpenAI): `OPENAI_API_KEY=…` nel file `.env` (chiave da platform.openai.com, a consumo).
   - **Nano Banana 2** (Google): `GEMINI_API_KEY=…` nel file `.env` (chiave da aistudio.google.com/apikey, con quota
     gratuita). Per il modello Pro: `GEMINI_IMAGE_MODEL=gemini-3-pro-image`.
   - **auto**: il primo configurato. In **Impostazioni** il pulsante **Prova** genera un'immagine di prova.
   - **GPT-6 Astra** (tramite Codex): nel pannello di Cosetta *Provider = codex* e *Modello = gpt-6-astra*. Astra
     ragiona, scrive i prompt, genera con lo strumento immagini di Codex (GPT Image 2), guarda il risultato e corregge.
     Serve Codex aggiornato (`npm i -g @openai/codex@latest`) e un account abilitato (`codex models` deve elencarlo).
   Cosetta passa al generatore anche immagini di riferimento (sprite esistenti, i tuoi allegati) per restare nello stile.

```bash
cd ~/Downloads/tq-evs-studio && cp .env.example .env    # poi apri .env e togli il # davanti alle righe che ti servono
./stop-studio.sh && ./start-studio.sh
```

Si può scegliere provider e modello per singolo agente (pannello agente → Provider / Modello). Lo stato dei provider
è in **Impostazioni**. Le chiavi non vanno mai in git (`.env` è ignorato).

---

## Memoria di progetto (condivisa dagli agenti)

Pulsante **Memoria**. Conoscenza strutturata, non la cronologia della chat. Sta nel repository del **gioco**:

| Documento | Cosa contiene |
|---|---|
| `docs/memoria/PROJECT_STATE.md` | stato e **regole permanenti** del progetto (+ stato vivo del repo) |
| `docs/memoria/ARCHITECTURE.md` | architettura tecnica del gioco, dove mettere le mani |
| `docs/memoria/GAME_DESIGN.md` | design come implementato: livelli, sistemi, comandi |
| `docs/memoria/NARRATIVE_BIBLE.md` | riassunto narrativo di lavoro (la Bibbia completa resta il tuo documento) |
| `docs/memoria/PUZZLES.md` | registro degli enigmi e delle indagini |
| `docs/memoria/DECISIONS.md` | decisioni prese e perché |
| `docs/memoria/KNOWN_ISSUES.md` | problemi noti (lo Studio aggiunge quelli irrisolti) |
| `docs/memoria/ASSETS.md` | asset, convenzioni, brief |
| `data/memory/TASKS.md`, `AGENT_ACTIVITY.md` (nello Studio) | generati dallo Studio |

Ogni agente legge solo i documenti del suo ruolo (campo "Documenti di contesto").

## Test

```bash
cd ~/Downloads/tq-evs-studio
npm test             # test dello Studio (orchestrazione, git, eventi, server) — ~10 s
npm run test:game    # test del gioco: controlli statici + menu e tutti i livelli nel browser — ~1 min
node qa/game-test.mjs --levels level2 --steps '[{"action":"startLevel","id":"level2"},{"action":"screenshot","name":"prova"}]'
```

## File e cartelle

```
start-studio.sh / stop-studio.sh    accensione e spegnimento
server/                             backend: orchestrator.js (Regia, task, ciclo QA), agents.js, git.js, providers/
web/                                interfaccia (senza build): app.js, office.js (ufficio), avatars.js, pixel.js
qa/game-test.mjs                    QA harness del gioco
config/agents.default.json          agenti predefiniti (nomi, ruoli, istruzioni, avatar)
config/office.default.json          l'ufficio (stanza, postazioni, arredi)
data/                               dati locali: stato, log, worktree, screenshot, avatar (non versionati)
../tq-evs/docs/memoria/             memoria di progetto (nel repository del gioco)
```

Problemi? Guarda `data/studio.log`. Per ricominciare da zero con lo Studio (senza toccare il gioco):
`./stop-studio.sh && mv data data-vecchio && ./start-studio.sh`.
