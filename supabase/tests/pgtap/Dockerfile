FROM postgres:15-bookworm

RUN apt-get update \
  && apt-get install -y --no-install-recommends postgresql-15-pgtap \
  && rm -rf /var/lib/apt/lists/*
