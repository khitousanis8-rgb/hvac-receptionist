FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PYTHONPATH=/app \
    PORT=7860

WORKDIR /app

# Create a non-root user with UID 1000 for Hugging Face Spaces compatibility
RUN useradd -m -u 1000 user && \
    chown -R user:user /app

COPY --chown=user:user pyproject.toml README.md start.sh ./
COPY --chown=user:user app ./app

RUN pip install --no-cache-dir . \
    && chmod +x start.sh

USER user

EXPOSE 7860

CMD ["./start.sh"]
