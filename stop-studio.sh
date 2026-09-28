#!/usr/bin/env bash
# GAME STUDIO — spegnimento (dalla cartella dello Studio):   ./stop-studio.sh
cd "$(dirname "$0")"
PID_FILE="data/studio.pid"
if [ -f "$PID_FILE" ] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
  kill "$(cat "$PID_FILE")" && rm -f "$PID_FILE"
  echo "  ✔ GAME STUDIO spento. (I lavori in corso ripartono da soli alla prossima accensione.)"
else
  PIDS="$(pgrep -f 'node server/index.js' || true)"
  if [ -n "$PIDS" ]; then kill $PIDS; echo "  ✔ GAME STUDIO spento."; else echo "  Lo Studio non era acceso."; fi
  rm -f "$PID_FILE"
fi
