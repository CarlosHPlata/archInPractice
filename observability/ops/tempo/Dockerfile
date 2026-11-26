# Tempo plus its configuration, for deployments that cannot mount ops/tempo
# (docker-compose.yml mounts the folder into the stock image instead).
# Keep the version in step with the tempo service in docker-compose.yml.

# The Tempo image has no shell, so the data directory is prepared here: a
# named volume mounted on it then starts out writable by the tempo user.
FROM busybox:1.37 AS dirs
RUN mkdir -p /var/tempo

FROM grafana/tempo:2.10.10
COPY --from=dirs --chown=10001:10001 /var/tempo /var/tempo
COPY tempo.yml /etc/tempo/tempo.yml
CMD ["-config.file=/etc/tempo/tempo.yml"]
