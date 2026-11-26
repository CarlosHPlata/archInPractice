# Grafana plus its data sources and dashboard, for deployments that cannot
# mount ops/grafana (docker-compose.yml mounts the folders into the stock image).
# Keep the version in step with the grafana service in docker-compose.yml.
# PROMETHEUS_URL, LOKI_URL and TEMPO_URL say where the data sources are.
FROM grafana/grafana:13.3.1
COPY provisioning /etc/grafana/provisioning
COPY dashboards /var/lib/grafana/dashboards
