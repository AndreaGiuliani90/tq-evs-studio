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
| **Stratega** — Stratega e contabile | `strategy` | sceglie i modelli per ogni task, prepara i preventivi, tiene la lavagna delle spese |
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

### Il Notaio: unioni in ordine, niente perso

Quando lanci più richieste in parallelo, delle unioni si occupa **Notaio** (Custode delle unioni). Lavora solo con
git: nessuna AI, nessun costo.

- **Coda in ordine**: le unioni approvate entrano una alla volta, nell'ordine in cui sono nate le richieste. L'ordine
  in cui premi "Unisci" non conta.
- **Prova generale**: ogni unione si prova prima in una copia a parte. Se tocca gli stessi punti di aggiornamenti già
  entrati, torna allo sviluppo per allinearsi e al QA per riprovarla. Poi la unisce da solo, senza che tu debba
  ripremere. Il tuo gioco intanto non viene toccato.
- **Niente perso**: il punto debole sono le soluzioni dei conflitti. Per ogni allineamento il Notaio controlla che
  le novità delle due parti siano rimaste. Una riga tolta lì e mai più rimessa è persa. Una riga cambiata dopo, con
  un commit normale, è una scelta dello sviluppo. Non contano i commenti spostati, le righe fuse in una sola né i
  numeri di versione. Nei documenti (CHANGELOG, note, Bibbia) un testo riscritto è solo un avviso nel messaggio di
  unione. Bloccano anche i segni di conflitto rimasti (<<<<<<<) e la versione all'indietro. Se manca qualcosa,
  lo sviluppo lo rimette da solo; ti chiama solo se manca ancora.
- **File di lavoro**: gli screenshot e gli script di prova degli agenti (`.shots/` ecc.) non entrano nei commit e
  il Notaio li toglie dai branch prima di unire.
- **All'avvio**: le unioni che avevi approvato e che si erano fermate vengono riprovate da sole con i controlli
  attuali.
- **Annullare un'unione**: prima la prova. Se toglierla romperebbe aggiornamenti entrati dopo, si ferma e te lo dice.
- **Registro**: il pulsante **Unioni** mostra ogni unione con numero, data, commit, versione e controlli.

### Da seguire e seguiti agganciati

- In cima alla chat, **Tocca a te** mostra una scheda per ogni cosa che aspetta te: cosa è successo, cosa ti si
  chiede e i pulsanti per decidere lì, senza cercare in chat. L'etichetta dice quanto è urgente: **Ferma: aspetta
  te** (il lavoro non va avanti), **Non entra nel gioco finché non decidi**, **Quando vuoi** (pronta da unire, niente
  è fermo). Sotto, in una riga, quello che non richiede niente (lavori in corso, in attesa).
- **↪ Aggancia**, sul pulsante di ogni richiesta o passando sopra un messaggio: il prossimo messaggio riguarda quella
  richiesta. Sopra la casella vedi cosa succederà:
  - se aspettava una tua risposta, è quella risposta;
  - se è ancora in lavorazione, il seguito aspetta e parte appena finisce;
  - se è finita ma non unita, il seguito continua **sullo stesso branch**: alla fine unisci solo il seguito, che
    contiene tutto, e la vecchia non si può più unire per sbaglio;
  - se era già unita o chiusa, parte una richiesta nuova dal gioco attuale, con il contesto di quella vecchia.
- A voce: inizia con «R 12:» (o «su R-12 …») per agganciare il messaggio alla richiesta R-0012. Esc toglie l'aggancio.
- **Chiudi** (nell'elenco Da seguire) toglie una domanda rimasta appesa che non serve più.
- **Se non agganci niente, decide lo Stratega.** Quando ci sono lavori aperti (in corso, in attesa, da unire, con una
  domanda in sospeso), legge il messaggio e decide se è una cosa nuova (parte subito, in parallelo), il seguito di
  un lavoro aperto (lo aggancia e ti dice perché) o la risposta a una domanda. Usa un modello veloce incluso nel
  piano. Se ha sbagliato e il seguito sta ancora aspettando, premi **Sgancia**: parte subito, da sola. Senza Stratega
  (o se non risponde) vale la regola di prima: il messaggio risponde all'ultima domanda in sospeso, altrimenti è nuovo.

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
Le luci seguono l'ora vera (giorno, tramonto, notte).

La sede è una stanza grande (24×20 caselle) con l'isola al centro, il tavolo della Regia, l'**angolo relax** in fondo
a destra (macchinetta del caffè, divano, poltrona, cabinato) e la **lavagna delle spese** sopra il bancone del caffè.
Ci si muove come su una mappa: **rotellina** o **pizzico** per lo zoom, **trascina** per spostarti, doppio clic per
avvicinarti a un punto, pulsanti ＋ － ⤢ in basso a destra (da tastiera: + − 0, frecce, Esc). **Clic su un
personaggio → superzoom** su di lui con la scheda del ritratto grande; clic sul nome → scheda completa dell'agente.
Se avevi un ufficio personalizzato, con la pianta nuova resta nella cronologia: **↶ Annulla ultimo arredo** lo
riporta com'era.

L'ufficio è un file di dati: `config/office.default.json` (stanza, postazioni per id agente, arredi).
Per personalizzarlo copialo in `data/office.json` e modificalo: lo Studio usa quello. Tipi di postazione:
`pc`, `tv`, `typewriter`, `easel`, `table`; arredi: `window`, `banner`, `noticeboard`, `map`, `clock`, `lantern`,
`rug`, `plant`, `crates`, `sideboard`, `bench`, `costboard`, `coffee`, `watercooler`, `sofa`, `armchair`,
`coffeetable`, `arcade`. Il disegno è in `web/office.js`, lo zoom in `web/office-view.js`.

### Ufficio ridipinto (sfondo illustrato)

Per avere l'ufficio con la resa di un'illustrazione vera (non disegnato in codice) chiedi a Cosetta di ridipingerlo,
allegando un'immagine di riferimento con 📎, per esempio *«Cosetta, ridipingi l'ufficio esattamente in questo stile,
risoluzione e luce»*. Lo Studio fotografa la **maquette** della pianta attuale (stanza e mobili, senza personaggi),
il generatore di immagini la ridipinge tenendo la stessa geometria e il dipinto diventa lo **sfondo**: sopra restano
vivi i personaggi (seduti dietro le scrivanie dipinte), le etichette, la lavagna, le luci del giorno e lo zoom.
Costa **una sola immagine** (lo Stratega mostra il preventivo) e **nessun token** di AI di testo.
Il pulsante 🎨 nell'ufficio passa dal dipinto al disegno in codice; **↶ Annulla ultimo arredo** torna allo sfondo di
prima. Se Arredo sposta i mobili, lo Studio lo segnala: il dipinto va rifatto.

### Arredo e interfaccia (Cosetta)

L'arredo dell'ufficio e le modifiche all'interfaccia dello Studio le fa **Cosetta** (tipi `office` e `studio_ui`; il
vecchio "Responsabile dell'ufficio" è stato licenziato). Un agente si licenzia dalla sua scheda (**Licenzia…**):
i compiti passano a un collega e l'aspetto, se vuoi, a un altro.

#### Come funziona

Chiedi in chat, per esempio *«metti una pianta grande vicino alla finestra e dai a Tizia i capelli corti»*:
la Regia passa il lavoro al Responsabile dell'ufficio, che modifica l'arredo e l'aspetto dei personaggi. Il cambiamento
si vede subito; se non ti piace, **↶ Annulla ultimo arredo** (in alto a destra nell'ufficio) riporta tutto com'era
(le versioni precedenti stanno in `data/office-history/`).

Se chiedi modifiche al **programma** dello Studio (interfaccia, colori, animazioni), il Responsabile lavora su un branch
del repository dello Studio, lo Studio controlla la sintassi e lancia i suoi test; poi premi **Unisci** e riavvii lo
Studio. Il gioco non viene mai toccato.

### Nuovi personaggi disegnati dall'AI

Chiedi in chat, per esempio *«Cosetta, fai nuovi sprite per te e per tutti i tuoi colleghi, stile Monkey Island»*
(puoi allegare immagini di riferimento). Cosetta scrive un prompt per ogni agente con uno stile comune, il generatore
immagini (GPT Image o Nano Banana; oppure Codex se Cosetta lavora con Codex) disegna i ritratti su fondo magenta,
e lo Studio li ripulisce, li riduce a pixel art e li mette nell'ufficio e nelle schede. Il primo ritratto fa da
riferimento di stile per gli altri. Ogni personaggio è **animato fotogramma per fotogramma**: dopo il ritratto base il
generatore disegna le varianti dello stesso personaggio (scrive al computer, gioca col pad, pensa, festeggia, è
perplesso, si dispera, aspetta, sbatte le palpebre): 13 immagini per agente, oppure 6 in modalità "leggeri"
(Impostazioni). Tutti i fotogrammi hanno lo stesso ritaglio e la stessa scala, così l'animazione non balla. Non ti piacciono? **↶ Annulla ultimo arredo** torna ai personaggi di prima.

Laboratorio dei personaggi (tutte le pose): http://localhost:4173/sprite-lab.html?all=1

### Lo Stratega e la lavagna delle spese

Ogni richiesta, prima di partire, passa dallo **Stratega**: valuta quanto conta ogni task e sceglie il modello
giusto (qualità alta solo dove serve: codice delicato, correzioni, integrazioni; media per il lavoro normale; leggera
per compiti semplici) e il generatore di immagini. Se tutto è **incluso nei tuoi abbonamenti** il lavoro parte da solo;
se c'è una **spesa extra** ti mostra il preventivo con il suo consiglio e aspetta il tuo ok. Nel messaggio della Regia
vedi il modello scelto per ogni task. Il catalogo dei modelli è in `config/models.default.json` (se un nome di
modello non funziona sul tuo account lo correggi lì; nel frattempo lo Studio ripiega sul modello predefinito).
In Impostazioni puoi farlo lavorare "a regole fisse" (più veloce, senza AI).

Sulla parete dell'ufficio c'è la **lavagna delle spese**: totale speso finora e subtotali per servizio (GPT Image,
Nano Banana, API Anthropic). Cliccala per il dettaglio; gli abbonamenti risultano "inclusi" con il numero di lavori.
Gli importi sono stime dai prezzi di listino: il conto vero è nelle pagine di fatturazione di OpenAI e Google.

### Le lavagne DA FARE e SQUADRA

Sulla parete destra ci sono altre due lavagne (passaci sopra col cursore per il riassunto, clic per il dettaglio):
- **DA FARE**: chiedi alla Regia di *programmare le prossime attività* (es. «programmate il lavoro per il secondo
  rione»): la squadra concorda una lista di attività piccole e concrete, con chi le fa e la priorità, e le appende come
  post-it. Non partono da sole: premi **Avvia** sulla lavagna o scrivi «avvia B-3». Quando la richiesta finisce
  l'attività si spunta da sola. Puoi anche aggiungerne o toglierne a mano. Si apre anche dal pulsante **Attività**.
  La lavagna è un diagramma a **rami**: un ramo per riga, le attività in fila da sinistra a destra.
  - **Stesso ramo = in fila.** Si avvia un'attività alla volta. La successiva continua il branch della precedente
    (parte dal suo risultato), così alla fine unisci una volta sola.
  - **Rami diversi = in parallelo.** Ognuno sul suo branch dal gioco attuale. Il Notaio li unisce al gioco uno alla
    volta. **Avvia tutte** le fa partire insieme.
  - **Frecce tratteggiate = serve il risultato di un altro ramo.** Quell'attività parte solo quando l'altra è entrata
    nel gioco (unita).
  - Ogni blocco dice se è fatta (nel gioco o da unire), in corso, avviabile, oppure perché non ancora. Cliccandolo
    puoi cambiare ramo, dipendenze, chi la fa e la priorità.
- **SQUADRA**: chi lavora di più (task completati, tempo) e chi lavora meglio (qualità = completati ÷ completati +
  falliti + rifatti perché il QA ha trovato problemi; per il QA trovare bug conta come lavoro ben fatto).

### Limiti d'uso degli abbonamenti

Se un abbonamento (ChatGPT/Codex, Claude, Gemini) finisce i limiti d'uso, non ti chiede niente. Lo Stratega passa
a un altro modello incluso in un abbonamento che ha ancora margine, e te lo scrive in chat. Se non c'è
un'alternativa gratuita (per esempio immagini disegnate con il piano ChatGPT), il lavoro aspetta il rinnovo e
riparte da solo all'ora indicata dal fornitore. In «Tocca a te» lo vedi nella riga tranquilla: «riparte da sola
alle …».

### Preventivo prima di spendere

Le immagini via API (GPT Image, Nano Banana) si pagano a consumo, **a parte** rispetto agli abbonamenti. Il lavoro
degli agenti con Claude Code, Codex o Gemini CLI collegati al tuo account invece è **incluso nel piano** (consuma
solo i limiti d'uso). Prima di un lavoro che supera la soglia (Impostazioni, predefinita 1 $) la Regia mostra un
**preventivo** (immagini × prezzo del modello scelto) e aspetta: rispondi *sì*, *leggera* o *no*, oppure usa i
pulsanti. Il preventivo elenca anche i **generatori alternativi** (GPT Image alta/media, Nano Banana 2, Nano Banana Pro e, se Cosetta lavora con Codex, il **piano ChatGPT**, sperimentale) con il loro costo: scegli dal menu sotto il preventivo o scrivi, per esempio, «leggera con Nano Banana». Scrivi «preventivo» nel messaggio per averlo sempre, anche per lavori piccoli. I prezzi sono indicativi
e si aggiornano in `config/studio.default.json` → `imagePrices`.

## File da scaricare (export)

Quando chiedi un export o un file, nel rapporto della richiesta e nella sua scheda compare **📦 Da scaricare**:

- **⬇ Scarica (zip)**: la cartella intera in uno zip. Un file singolo si scarica così com'è.
- **👁 Apri**: una pagina con tutti i file e le anteprime delle immagini, ognuno scaricabile.
- **📂 Mostra nel Finder**: apre la cartella sul tuo Mac.

Gli agenti mettono queste cose in `export/<nome>/` e le dichiarano. Funziona anche con i rapporti vecchi che
hanno toccato una cartella `export/`.

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

## L'ufficio di Mappo (editor della mappa)

Pulsante **🗺 Mappo** in alto (o dalla scheda di Mappo): si apre il suo ufficio, un editor della mappa a rioni del Livello 3,
disegnata come nel gioco (terreno, case, porte e finestre, arredi con la grafica nuova, bersagli, persone, luci, nascondigli).

- **Spostare**: trascina un oggetto (Maiusc = solo in orizzontale/verticale; «Passo» per gli scatti). Frecce = 1 px, con Maiusc 8.
- **Girare**: maniglia tonda sopra l'oggetto (scatti di 15°, con Maiusc libero), oppure `R` / `Maiusc R` (90°) e `[` `]` (15°).
- **Grandezza, grafica, togliere, duplicare**: dalla scheda a destra. «Cambia sprite…» (`S`) apre il catalogo: arredi del borgo,
  sprite dei rioni, quelle del gioco e le nuove. «＋ Metti un arredo nuovo…» (`A`) e poi clic sulla mappa.
- **Cosetta** disegna una sprite nuova dalla scheda dell'oggetto: scrivi cosa vuoi, lei usa la sprite di adesso come riferimento di
  stile (GPT Image o Nano Banana: costa, e lo chiede prima); tu vedi l'anteprima già pulita e scegli «Usa questa».
  Si può anche caricare un proprio PNG.
- `⌘Z` / `⌘⇧Z` annulla e rifai; gli strati si nascondono o si bloccano (lucchetto) a sinistra.
- **Salva come versione da provare**: diventa una richiesta come le altre (branch suo, «▶ Prova questa versione», poi «Unisci al
  gioco» col Notaio). Finché non la unisci, gli altri salvataggi finiscono nella stessa bozza.

Nel gioco i ritocchi stanno in `tools/mappo.json` e si riportano nei file del livello con `python3 tools/mappo_applica.py`
(gli oggetti dei rioni nelle `correzioni` di `levels/rioni/index.json`, il resto in `levels/level3.json`). Al primo salvataggio lo
Studio aggiunge quello script, 6 righe a `src/systems/Rioni.js` (grafica e grandezza nelle correzioni) e il rilancio in fondo a
`tools/make_level3.py`, così una rigenerazione non cancella i ritocchi. Gli arredi «in serie» (panchine, lampioni, vasi, siepi,
alberi) nel gioco hanno un modello per rione: l'editor lo mostra e permette di usare comunque un modello preciso.

## L'Ufficio della Storia (Enigma e Custode)

Pulsante **📜 Storia** in alto (o dalla scheda di Enigma o del Custode): una lavagna con tutte le missioni del gioco come
diagramma di flusso, in verticale o in orizzontale. Ogni scheda è una missione (colore = tipo: principale, secondaria,
lavoro, indagine, evento, finale; etichetta = nel gioco / in parte / progettata / idea). Le frecce dicono cosa serve prima
(bianche) e cosa sblocca ogni soluzione (verde, giallo, rosso = etica alta, media, bassa; tratteggiate = chiude).

- **Quale storia, quale flusso**: «Lavagna» sceglie la storia (★ = la principale, `STORIA.json`; le altre sono i file
  `docs/memoria/STORIA_<nome>.json`, es. gli altri livelli). «Flusso» sceglie cosa guardare: tutta la lavagna, solo la
  trama principale, solo il contorno, un atto, le strade verso un finale, o la catena di una missione («Solo la sua
  catena» nella scheda). In alto a sinistra c'è sempre scritto dove sei; chi resta nascosto in mezzo diventa una
  freccia a puntini «passando da…».
- **Esplodere**: ▸ o doppio clic apre la scheda con sottomissioni e soluzioni; da ogni soluzione parte la sua freccia.
  «Esplodi tutto» / «Chiudi tutto», filtri per tipo, ricerca (missione, personaggio, flag).
- **Leggere**: passando sopra una scheda resta accesa la sua catena (da dove viene, dove porta); clic = scheda a destra con
  obiettivo, cosa serve, come si risolve e cosa comporta ogni scelta, flag (✓ se esiste davvero nel gioco).
- **Cambiare**: scrivi nel riquadro «Chiedi a Enigma e Custode» (riferito alla scheda scelta): diventa una richiesta dello
  Studio; la lavagna nuova la vedi scegliendo la versione da provare in alto, e diventa quella del gioco quando la unisci.

La lavagna è un file del gioco, `docs/memoria/STORIA.json`, che gli agenti tengono aggiornato quando cambiano missioni o
soluzioni. Se manca, «Fate la lavagna» chiede a Enigma e Custode di ricostruirla dai livelli e dai documenti; se livelli,
testi o documenti sono cambiati dopo il suo ultimo aggiornamento, un avviso propone «Aggiornatela».

## Pubblicare online (🚀 Online)

Le versioni che unisci restano nel main del gioco sul tuo computer: online (la beta su Railway) arrivano solo quando
vanno su GitHub, perché Railway pubblica da solo ogni volta che il ramo main di GitHub cambia.
Il pulsante **🚀 Online** (col numero delle versioni non ancora pubblicate) mostra la versione sul tuo computer, quella su
GitHub e — se nel `.env` dello Studio metti `STUDIO_BETA_URL=https://…` e `BETA_PASSWORD=…` — quella che gira davvero
online. «Pubblica tutto» o «Pubblica fino a qui» su una versione più vecchia: lo Studio fa `git push` (mai forzato: se su
GitHub c'è qualcosa che il tuo main non ha, si ferma e te lo dice). L'elenco delle pubblicazioni resta nello stesso riquadro.

## Effetti sonori (Rumore)

Chiedi in chat, per esempio *«Rumore, fai i passi sui sampietrini (3 da alternare), il vetro rotto e il click del menu»*.
Rumore trasforma la richiesta in un elenco di suoni con un prompt tecnico in inglese e sceglie il motore:
**ElevenLabs Sound Effects** per i suoni realistici del borgo (gli ambienti ciclici in loop) oppure **jsfxr**,
locale e gratuito, per interfaccia e gameplay retro (i parametri restano salvati, così si rigenera o si modifica).
Ogni suono ha **3 varianti**. Prima di chiamare ElevenLabs lo Studio scrive quante generazioni farà e quanti crediti
stima; oltre i 10 suoni chiede il tuo ok (rispondi «riprova» o «ferma»). Richieste identiche escono dalla **cache**.
Con **ffmpeg** (`brew install ffmpeg`) i suoni vengono rifiniti: silenzi tagliati, stesso volume percepito per
categoria (ambient, foley, ui, gameplay, vandalismo), dissolvenze brevi (non sui loop), esportati in .ogg e .mp3.
Le bozze restano nello Studio in `data/audio/` (fuori da git) con il manifest `data/audio/sfx_manifest.json`:
motore, prompt o parametri, varianti, scelta, stato e **licenza** (con il piano ElevenLabs Free i suoni non si
possono usare in una release commerciale: lo Studio lo segnala). Serve `ELEVENLABS_API_KEY` nel file `.env`.

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
