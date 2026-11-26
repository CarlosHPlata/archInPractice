# Prometheus plus its configuration, for deployments that cannot mount
# ops/prometheus (docker-compose.yml mounts the folder into the stock image).
# Keep the version and the flags in step with docker-compose.yml.
FROM prom/prometheus:v3.16.0
COPY prometheus.shrine.yml /etc/prometheus/prometheus.yml
CMD ["--config.file=/etc/prometheus/prometheus.yml", "--storage.tsdb.path=/prometheus", "--storage.tsdb.retention.time=1d"]
