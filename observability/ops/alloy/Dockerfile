# Alloy plus its configuration, for deployments that cannot mount ops/alloy
# (docker-compose.yml mounts the folder into the stock image instead).
# Keep the version in step with the alloy service in docker-compose.yml.
# LOKI_URL and TEMPO_OTLP_ENDPOINT say where to send logs and traces.
FROM grafana/alloy:v1.22.0
COPY config.alloy /etc/alloy/config.alloy
