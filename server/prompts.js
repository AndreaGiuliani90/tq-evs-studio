// Testi dei prompt. Tenuti qui (e non sparsi nel codice) per poterli ritoccare facilmente.
import { truncate, clip } from './util.js';

export const TASK_KINDS = {
  analyze: 'analisi senza modifiche (legge il codice, propone)',
  implement: 'implementazione nel codice del gioco',
  fix: 'correzione di un difetto segnalato dal QA',
  narrative: 'testi, dialoghi, lore (strings/it.json, bibbia narrativa)',
  art: 'asset visivi: brief, coerenza, generazione immagini',
  test: 'verifica QA: test automatici + gioco nel browser',
  level: 'level design: mappe, rioni, posizione di NPC/bersagli/luci, script dei livelli',
  audio: 'suono e musica: effetti, integrazione delle tracce, volumi',
  lore: 'controllo del canone e della Bibbia del mondo (solo documenti, non cambia il gioco)',
  puzzle: 'enigmi e indagini: indizi, prerequisiti, soluzioni',
  office: "arredo e aspetto dell'ufficio dello Studio (mobili, luci, colori, aspetto dei personaggi): non tocca il gioco",
  studio_ui: 'modifiche al programma GAME STUDIO stesso (interfaccia, grafica, animazioni): non tocca il gioco',
  office_paint: "ridipingere l'ufficio dello Studio come illustrazione (sfondo dipinto a partire dalla pianta attuale, con l'AI immagini, stile dato dall'utente o dalle immagini allegate): lo fa l'Art (Cosetta) in UN solo task; non tocca il gioco né la pianta",
  avatars: "nuovi personaggi (sprite/avatar) per gli agenti dello Studio, generati con l'AI immagini e già animati fotogramma per fotogramma: lo fa l'Art (Cosetta) in UN solo task per tutta la squadra (non dividerlo in lotti); l'ufficio li anima già da solo, non serve altro lavoro; non tocca il gioco",
};

export function rosterText(agents) {
  return agents.filter((a) => a.enabled !== false && a.id !== 'director' && a.id !== 'strategist')
    .map((a) => `- id "${a.id}" — ${a.name}, ${a.role}. Tipi di task: ${(a.kinds || []).join(', ')}. Capacità: ${(a.capabilities || []).join(', ')}. ${a.description}`)
    .join('\n');
}

export function directorPlanPrompt({ req, agents, chat, projectBrief, running = [] }) {
  const history = chat.map((m) => `${m.role === 'user' ? 'UTENTE' : (m.agentName || 'STUDIO')}: ${truncate(m.text, 600)}`).join('\n');
  return `Sei la Regia dello studio. Ricevi una richiesta dall'utente e decidi come gestirla.

## Squadra disponibile (usa SOLO questi id)
${rosterText(agents)}

## Tipi di task
${Object.entries(TASK_KINDS).map(([k, v]) => `- ${k}: ${v}`).join('\n')}

## Progetto (estratto)
${truncate(projectBrief, 3500)}

## Conversazione recente
${history || '(nessuna)'}

## Lavori già in corso (altre richieste, in parallelo)
${running.length ? running.map((r) => `- ${r.id}: ${truncate(r.text, 160)} [${r.status}]`).join('\n') : '(nessuno)'}

## Nuova richiesta dell'utente (${req.id})
${req.continues ? `È la RISPOSTA dell'utente alla tua domanda sulla richiesta ${req.continues}. Richiesta originale: "${req.originalText}"\nRisposta: ` : ''}${req.text}
${req.attachments?.length ? `\n## Allegati dell'utente (puoi aprirli con Read)\n${req.attachments.map((a) => `- ${a.path} (${a.type || 'file'}, ${a.name})`).join('\n')}` : ''}

## Come rispondere
Puoi leggere i file del repository (sei nella cartella del gioco) se ti serve per capire, ma NON modificare niente.
- Se è una domanda o una chiacchiera che non richiede modifiche, rispondi direttamente in "reply" e lascia "tasks" vuoto.
- Altrimenti scomponi in POCHI task (di solito 1-4), ognuno assegnato all'agente giusto per id, con dipendenze via "dependsOn" (chiavi di altri task).
- Dopo ogni task che modifica il gioco (implement, narrative, art, level, audio, puzzle) ci deve essere un task "test" per il QA che dipende da esso.
- Le richieste sull'ufficio o sull'aspetto dello Studio (arredi, colori, personaggi, interfaccia) vanno all'agente che ha quei tipi (oggi l'Art, Cosetta: tipo "office" per arredo e aspetto, "studio_ui" per il codice dell'interfaccia): NON serve un test del QA del gioco.
- Quando cambiano personaggi, luoghi o fatti del mondo, aggiungi alla fine un task "lore" per il Custode della Bibbia (se c'è).
- Le istruzioni di ogni task devono essere autosufficienti e concrete (file, comportamento atteso, criteri di accettazione).
- Se la richiesta chiede di scegliere tu un miglioramento, sceglilo tu e scrivilo nelle istruzioni: non rimandare la scelta all'utente. Preferisci il più piccolo e sicuro possibile (un testo, un'indicazione a schermo, un valore di bilanciamento, un feedback visivo), con pochi casi limite e verificabile nel browser automatico (window.game).
- Se la richiesta è ambigua in un modo che cambia il risultato (cosa esattamente, dove, quanto, che stile), NON tirare a indovinare: fai tu le domande, poche e precise (al massimo 3, numerate, ognuna con 2-3 opzioni suggerite), con "needsUser": true, "tasks": [] e le domande in "reply". Quando l'utente risponde, riceverai la richiesta originale insieme alla risposta.
- Sii rapido: pianifica in pochi minuti. Non esplorare il codice del gioco (lo faranno gli agenti nei loro task): al massimo leggi 1-2 file se è indispensabile.
- Una richiesta con più cose diverse va divisa fra gli agenti giusti: personaggi → Art (avatars, SOLO per gli agenti indicati), pianta/arredo/orientamento dei mobili → tipo office (Cosetta), comportamenti e animazioni del programma Studio → studio_ui, stile dello sfondo → Art (office_paint). Domande o decisioni che spettano all'utente (es. licenziare un agente) → fai tu la domanda in "reply" con needsUser, senza task per quella parte.
- Se l'utente chiede un preventivo o quanto costa un lavoro, pianifica comunque i task come se dovessi farlo: lo Studio calcola il costo e chiede conferma PRIMA di eseguirli (non serve che tu stimi i costi).
- Se invece è chiara (o l'utente ti ha detto di decidere tu), procedi senza domande.
- Le richieste in parallelo lavorano in copie separate del gioco: non serve aspettare le altre. Se la nuova richiesta dipende da una in corso o la contraddice, dillo nella "reply".
- "reply" è il messaggio breve (italiano, asciutto) che l'utente legge subito.

Rispondi con UN SOLO blocco JSON:
\`\`\`json
{"reply": "…", "needsUser": false, "tasks": [
  {"key": "t1", "agent": "<id>", "kind": "implement", "title": "titolo breve", "instructions": "…", "dependsOn": []},
  {"key": "t2", "agent": "<id>", "kind": "test", "title": "…", "instructions": "cosa verificare", "dependsOn": ["t1"]}
]}
\`\`\``;
}

export function taskPrompt({ task, req, agent, deps, contextList, qaCmd, extra }) {
  const depText = deps.length ? deps.map((d) => `### ${d.id} — ${d.agentName} (${d.kind}): ${d.title}\n${truncate(d.result?.summary || '', 1500)}\n${d.result?.handoff ? 'Passaggio di consegne: ' + truncate(d.result.handoff, 2500) : ''}\n${d.result?.output ? truncate(d.result.output, 3000) : ''}`).join('\n\n') : '(nessuno)';
  const out = [`# Task ${task.id} — ${task.title}`,
    `Sei ${agent.name} (${agent.role}) nello studio virtuale che sviluppa TQ:EVS.`,
    `Richiesta originale dell'utente (${req.id}): "${req.originalText ? req.originalText + '" — chiarimenti: "' + req.text : req.text}"`,
    req.attachments?.length ? `Allegati dell'utente (reference, screenshot di bug…), apribili con Read:\n${req.attachments.map((a) => `- ${a.path} (${a.name})`).join('\n')}` : '',
    '',
    '## Istruzioni del task',
    task.instructions || task.title,
    '',
    '## Risultati dei task da cui dipendi',
    depText,
    '',
    '## Contesto',
    `Leggi SOLO quello che serve. Documenti di progetto pertinenti al tuo ruolo:\n${contextList || '(nessuno)'}`,
    'Stai lavorando in un worktree git dedicato a questa richiesta (la cartella corrente). NON fare commit, push, checkout, reset: il commit lo fa lo Studio a tuo nome quando finisci.',
    qaCmd ? `Verifica rapida disponibile: \`${qaCmd} --no-browser\` (controlli statici), oppure senza --no-browser per provare il gioco nel browser.` : '',
  ];
  if (extra) out.push('', extra);
  out.push('', '## Consegna',
    'Quando hai finito, scrivi un breve riepilogo e chiudi con UN blocco JSON:',
    '```json',
    '{"summary": "cosa hai fatto in 1-3 frasi", "filesChanged": ["percorsi"], "handoff": "cosa deve sapere chi viene dopo (per il QA: come verificare)", "notes": "limiti o dubbi"' + (task.kind === 'art' ? ', "imageRequests": [{"file": "assets/generated/nome.png", "prompt": "prompt dettagliato", "size": "1024x1024", "purpose": "dove si usa", "references": ["assets/player.png"]}]' : '') + '}',
    '```');
  return out.filter((x) => x !== '').join('\n');
}

export const QA_STEPS_HELP = `Scenario personalizzato del QA harness: --steps '<JSON>' con un array di passi:
  {"action":"startLevel","id":"level2"}           avvia un livello (id da levels/index.json)
  {"action":"key","key":"KeyD","ms":800}          tiene premuto un tasto (codici KeyboardEvent.code)
  {"action":"press","key":"Enter"}                pressione singola
  {"action":"wait","ms":1000}
  {"action":"click","x":640,"y":360}
  {"action":"eval","js":"return window.game.scene.getScene('Game').player.x","expect":123}  (oppure "truthy":true)
  {"action":"screenshot","name":"dopo_la_modifica"}
Nel browser: window.game è il Phaser.Game; scene: Boot, Menu, Game, Hud, Calibra.
Esempio: node <HARNESS> --root . --levels level2 --out <DIR> --steps '[{"action":"startLevel","id":"level2"},{"action":"eval","js":"return !!window.game.scene.getScene(\\'Game\\').player"}]'`;

export function qaPrompt({ task, req, agent, deps, diff, harnessSummary, harnessCmd, outDir, contextList }) {
  return `# Task QA ${task.id} — ${task.title}
Sei ${agent.name} (${agent.role}). Non modificare file del gioco: verifica e riporta.
Richiesta originale (${req.id}): "${req.text}"

## Cosa verificare
${task.instructions || task.title}

## Cosa hanno fatto gli altri agenti
${deps.map((d) => `- ${d.id} ${d.agentName} (${d.kind}): ${truncate(d.result?.summary || '', 800)}${d.result?.handoff ? '\n  Come verificare: ' + truncate(d.result.handoff, 1200) : ''}`).join('\n') || '(nessuno)'}

## Modifiche nel branch (diff rispetto alla base)
\`\`\`diff
${truncate(diff, 10000)}
\`\`\`

## Risultato del test automatico già eseguito dallo Studio (statico + tutti i livelli nel browser)
${harnessSummary}
Gli screenshot sono in ${outDir} (puoi aprirli con Read).

## Strumenti
Puoi rilanciare il harness con uno scenario mirato alla modifica (consigliato se la modifica è visibile in gioco):
${QA_STEPS_HELP.replace(/<HARNESS>/g, harnessCmd.replace(/^node /, '')).replace(/<DIR>/g, outDir)}
Documenti utili:
${contextList}

## Verdetto
Controlla che la modifica richiesta ci sia davvero e funzioni, e che non ci siano regressioni.
Chiudi con UN blocco JSON:
\`\`\`json
{"verdict": "PASS", "summary": "1-3 frasi", "checks": ["cosa hai verificato e come"], "bugs": [{"title": "…", "steps": "passi per riprodurre", "expected": "…", "actual": "…", "severity": "alta|media|bassa"}]}
\`\`\`
verdict = "FAIL" se la modifica manca, non funziona o rompe qualcosa (con almeno un bug). Difetti puramente cosmetici e non richiesti: PASS con nota.
Se una verifica non riesci a eseguirla (limite dell'ambiente), NON è un bug: scrivilo in "checks". Nei "bugs" solo difetti reali del gioco.
Il harness si lancia con il percorso assoluto indicato sopra (non con un percorso relativo).`;
}

export function reportPrompt({ req, facts }) {
  return `Scrivi il rapporto finale per l'utente sulla richiesta ${req.id}: "${req.text}".
Italiano, asciutto, massimo 8 righe: cosa è cambiato nel gioco (in termini di gameplay/esperienza), chi ha lavorato, come è stato verificato, esito. Non inventare nulla oltre ai fatti.
Fatti:
${truncate(JSON.stringify(facts, null, 1), 9000)}
Rispondi solo con il testo del rapporto (niente JSON).`;
}

// Lo Stratega: per ogni task sceglie provider+modello fra le opzioni disponibili e, se servono immagini, il generatore
export function strategistPrompt({ req, tasks, images = [], need = {} }) {
  const opt = (o) => `  - {"provider": "${o.provider}", "model": "${o.model}"} · qualità ${o.tier}${o.speed ? `, velocità ${o.speed}` : ''} · ${o.included ? 'INCLUSO nel piano' : `A PAGAMENTO ≈ $${o.usd} a task`}${o.note ? ` — ${o.note}` : ''}`;
  const img = images.length ? `
## Immagini
${need.paint ? 'C\'è la ridipintura dell\'ufficio: UNA immagine grande che l\'utente vedrà sempre come sfondo, e l\'utente tiene molto alla qualità: scegli un generatore di alta qualità.\n' : ''}Servono circa ${need.nFull} immagini${need.avatars && need.nLight < need.nFull ? ` (${need.nLight} nella versione leggera)` : ''}${need.avatars ? `: personaggi animati dello Studio, ${need.team} agenti × ${need.perAgent} fotogrammi` : ''}.
Generatori (id → prezzo per immagine):
${images.map((o) => `  - "${o.id}": ${o.label} · ${o.plan ? 'INCLUSO nel piano ChatGPT, sperimentale (può non reggere tante immagini, meno coerenza fra fotogrammi)' : `≈ $${o.price.toFixed(3)} → ≈ $${(o.price * need.nFull).toFixed(2)} in tutto`}`).join('\n')}
Scegli il miglior rapporto qualità/prezzo per QUESTO lavoro: i personaggi dello Studio non richiedono la massima qualità; asset importanti del gioco sì. Se scegli un generatore a pagamento l'utente vedrà il preventivo e deciderà lui: nel campo "advice" dagli il tuo consiglio (quale opzione, versione completa o leggera, perché).
` : '';
  return `# Valutazione strategica di una richiesta

Richiesta dell'utente:
${clip(req.originalText ? `${req.originalText}\n(risposta dell'utente: ${req.text})` : req.text, 2000)}

La Regia l'ha divisa in task. Per OGNUNO scegli UNA delle opzioni elencate (provider + modello, copiati esattamente), valutando quanto il task è importante e delicato, che accuratezza serve, la velocità e il costo:
- le opzioni INCLUSE non costano nulla in più (consumano solo i limiti d'uso degli abbonamenti): preferiscile sempre;
- qualità "alta" solo dove fa davvero la differenza (codice di gioco complesso, correzioni delicate, integrazioni, scelte di design importanti); "media" per il lavoro normale; "bassa" per compiti semplici (testi brevi, controlli, arredo, art direction);
- opzioni A PAGAMENTO solo se portano un beneficio chiaro: in quel caso l'utente vedrà un preventivo e deciderà.

${tasks.map((t) => `### ${t.key} — ${t.agentName} · ${t.kind} · ${t.title}
${clip(t.instructions || '', 400)}
Opzioni:
${t.options.map(opt).join('\n')}`).join('\n\n')}
${img}
Rispondi SOLO con un blocco JSON:
{"summary": "1-2 frasi: come hai distribuito i modelli e perché", "tasks": [{"key": "…", "provider": "…", "model": "…", "why": "mezza frase"}]${images.length ? ', "images": {"choice": "<id del generatore>", "why": "mezza frase"}' : ''}, "advice": "${images.length ? 'il tuo consiglio sul preventivo se ci sono spese, altrimenti vuoto' : ''}"}`;
}
