FROM python:3.12-slim AS runtime

ARG PIP_INDEX_URL=https://pypi.org/simple

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_DEFAULT_TIMEOUT=120 \
    PIP_INDEX_URL=${PIP_INDEX_URL} \
    PIP_RETRIES=10 \
    PATH="/home/app/.local/bin:${PATH}"

WORKDIR /app

COPY pyproject.toml README.md ./
COPY src ./src
RUN --mount=type=cache,target=/root/.cache/pip \
    python -m pip install --timeout 300 "setuptools>=75" \
    && python -m pip install --no-build-isolation .

# Runtime query and model configuration must travel with the image.
COPY config ./config
COPY resources ./resources
COPY alembic-goldendb.ini ./alembic-goldendb.ini
COPY alembic_goldendb ./alembic_goldendb
COPY scripts ./scripts

RUN useradd --create-home --uid 10001 app \
    && chown -R app:app /app

USER app

EXPOSE 8010

HEALTHCHECK --interval=30s --timeout=8s --start-period=20s --retries=3 \
  CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8010/health/ready', timeout=5)" || exit 1

CMD ["python", "-m", "uvicorn", "ask_metric.main:app", "--host", "0.0.0.0", "--port", "8010"]
