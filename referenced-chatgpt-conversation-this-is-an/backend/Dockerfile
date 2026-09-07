FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PYTHONPATH=/app

WORKDIR /app

COPY pyproject.toml README.md start.sh ./
COPY app ./app

RUN sed -i 's/\r$//' start.sh && chmod +x start.sh \
    && pip install --no-cache-dir .

EXPOSE 8000

CMD ["./start.sh"]
