FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PYTHONPATH=/app

WORKDIR /app

COPY pyproject.toml README.md start.sh ./
COPY app ./app

RUN pip install --no-cache-dir . \
    && chmod +x start.sh

EXPOSE 8000

CMD ["./start.sh"]
