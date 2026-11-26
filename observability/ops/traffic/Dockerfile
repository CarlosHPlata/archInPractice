# curl plus the traffic script, for deployments that cannot mount ops/traffic
# (docker-compose.yml mounts the folder into the stock image instead).
# Keep the version in step with the traffic service in docker-compose.yml.
# STORE_URL, INTERVAL and MAX_BURST are described in README.md.
FROM curlimages/curl:8.23.0
COPY generate-request.sh /traffic/generate-request.sh
ENTRYPOINT ["sh", "/traffic/generate-request.sh"]
