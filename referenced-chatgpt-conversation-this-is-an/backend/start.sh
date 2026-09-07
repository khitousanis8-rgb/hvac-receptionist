#!/bin/sh
set -e

# Memory optimizations for constrained environments (e.g. Render 512MB RAM)
export MALLOC_ARENA_MAX=2
export PYTHONUNBUFFERED=1

# Runs the FastAPI API and the LiveKit agent worker in a single container.
# Uses $PORT when the platform assigns one (Render), otherwise 8000.
PORT="${PORT:-8000}"

# Run agent worker in background with auto-restart on disconnect
(
  while true; do
    echo "[worker] Starting LiveKit receptionist agent worker..."
    python -m app.agent.worker start || true
    echo "[worker] Worker exited. Restarting in 3 seconds..."
    sleep 3
  done
) &

# Run Uvicorn in foreground as primary web service (single worker to conserve RAM)
exec uvicorn app.main:app --host 0.0.0.0 --port "$PORT" --workers 1
