#!/usr/bin/env bash
# GAME STUDIO — avvio con un solo comando (dalla cartella dello Studio):   ./start-studio.sh
#   ./start-studio.sh --foreground   resta in primo piano (Ctrl+C per spegnere)
#   ./start-studio.sh --no-open      non apre il browser
set -euo pipefail
cd "$(dirname "$0")"
ROOT="$(pwd)"
DATA="$ROOT/data"
mkdir -p "$DATA"
PORT="${STUDIO_PORT:-$(grep -E '^[[:space:]]*STUDIO_PORT=' .env 2>/dev/null | tail -1 | cut -d= -f2 || true)}"
PORT="${PORT:-4173}"
URL="http://localhost:$PORT"
FG=0; OPEN=1
for a in "$@"; do case "$a" in --foreground|-f) FG=1;; --no-open) OPEN=0;; esac; done

say()  { printf '  %s\n' "$*"; }
fail() { printf '\n  ✘ %s\n\n' "$*" >&2; exit 1; }

echo; echo "  ▣ GAME STUDIO — TQ:EVS"; echo

# 1. dipendenze di base
command -v node >/dev/null 2>&1 || fail "Manca Node.js (serve la versione 18 o più recente). Installalo da https://nodejs.org oppure con: brew install node"
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
[ "$NODE_MAJOR" -ge 18 ] || fail "Node.js è troppo vecchio ($(node -v)). Serve la 18 o più recente: brew upgrade node"
command -v git >/dev/null 2>&1 || fail "Manca git. Su Mac: xcode-select --install"
GAME="${STUDIO_PROJECT_ROOT:-$(grep -E '^[[:space:]]*STUDIO_PROJECT_ROOT=' .env 2>/dev/null | tail -1 | cut -d= -f2- || true)}"
GAME="${GAME:-$ROOT/../tq-evs}"
[ -d "$GAME" ] || fail "Non trovo la cartella del gioco ($GAME). Mettila accanto allo Studio con il nome tq-evs, oppure scrivi STUDIO_PROJECT_ROOT=/percorso/del/gioco nel file .env"
git -C "$GAME" rev-parse HEAD >/dev/null 2>&1 || fail "La cartella del gioco ($GAME) non è un repository git con almeno un commit."
export STUDIO_PROJECT_ROOT="$(cd "$GAME" && pwd)"
say "✔ node $(node -v) · git $(git --version | awk '{print $3}') · gioco: $STUDIO_PROJECT_ROOT"

# 2. già acceso?
if curl -fsS "$URL/api/health" >/dev/null 2>&1; then
  say "Lo Studio è già acceso → $URL"
  [ "$OPEN" = 1 ] && command -v open >/dev/null 2>&1 && open "$URL"
  exit 0
fi

# 3. pacchetti dello Studio (solo la prima volta) e browser per il QA
if [ ! -d node_modules/playwright ]; then
  say "Installo i pacchetti dello Studio (solo la prima volta)…"
  (npm install --no-audit --no-fund >/dev/null 2>&1) || say "· npm install non riuscito: lo Studio parte lo stesso, ma il QA non potrà aprire il gioco nel browser."
fi
if [ -d node_modules/playwright ] && [ ! -f "$DATA/.browser-ok" ]; then
  if (node -e "import('playwright').then(p=>{process.exit(require('fs').existsSync(p.chromium.executablePath())?0:1)}).catch(()=>process.exit(1))") 2>/dev/null; then
    touch "$DATA/.browser-ok"
  else
    say "Scarico il browser per i test del QA (solo la prima volta, ~150 MB)…"
    (npx --yes playwright install chromium >/dev/null 2>&1) && touch "$DATA/.browser-ok" || say "· download non riuscito: il QA userà Google Chrome se c'è, altrimenti solo i controlli statici."
  fi
fi

# 4. provider AI
CLAUDE_BIN="$(grep -E '^[[:space:]]*CLAUDE_CODE_BIN=' .env 2>/dev/null | tail -1 | cut -d= -f2 || true)"
if command -v "${CLAUDE_BIN:-claude}" >/dev/null 2>&1; then say "✔ Claude Code trovato: gli agenti useranno il tuo account Claude"
elif grep -qE '^[[:space:]]*ANTHROPIC_API_KEY=.+' .env 2>/dev/null; then say "✔ chiave API Anthropic trovata in .env"
else say "⚠ Nessun provider AI: installa Claude Code (https://docs.claude.com/claude-code) o metti ANTHROPIC_API_KEY nel file .env. Lo Studio parte lo stesso."
fi

# 5. avvio
if [ "$FG" = 1 ]; then exec node server/index.js; fi
nohup node server/index.js >"$DATA/studio.log" 2>&1 &
echo $! >"$DATA/studio.pid"
for _ in $(seq 1 40); do
  curl -fsS "$URL/api/health" >/dev/null 2>&1 && break
  if ! kill -0 "$(cat "$DATA/studio.pid")" 2>/dev/null; then echo; tail -20 "$DATA/studio.log"; fail "Lo Studio non è partito (log sopra, completo in data/studio.log)"; fi
  sleep 0.5
done
curl -fsS "$URL/api/health" >/dev/null 2>&1 || fail "Lo Studio non risponde su $URL (vedi data/studio.log)"
echo
say "✔ GAME STUDIO acceso →  $URL"
say "  Il gioco (versione attuale): $URL/play/main/"
say "  Log: data/studio.log · Per spegnere: ./stop-studio.sh"
echo
[ "$OPEN" = 1 ] && command -v open >/dev/null 2>&1 && open "$URL"
exit 0
