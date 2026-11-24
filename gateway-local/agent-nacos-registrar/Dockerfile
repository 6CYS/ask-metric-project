FROM python:3.12-slim

WORKDIR /app
COPY register.py ./register.py
RUN python -m pip install --no-cache-dir "nacos-sdk-python==2.0.11" \
    && useradd --system --create-home app
USER app
ENTRYPOINT ["python", "/app/register.py"]
