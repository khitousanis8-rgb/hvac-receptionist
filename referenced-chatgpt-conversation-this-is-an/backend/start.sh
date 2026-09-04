#!/bin/sh
# Runs the FastAPI API and the LiveKit agent worker in a single container.
uvicorn app.main:app --host 0.0.0.0 --port 8000 &
exec python -m app.agent.worker start