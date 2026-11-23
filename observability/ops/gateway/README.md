# gateway (Traefik)

## What it is for

Traefik is the reverse proxy in front of the store. It is the only container that publishes the store to your machine (port 8080), so every request from outside goes through it before it reaches a service. That makes it the natural place for things that must happen once per request, at the edge.

## How it is configured

Traefik has two kinds of configuration, in two files. The folder is mounted read-only at `/etc/traefik`.

| File | Kind | When it is read |
| --- | --- | --- |
| `traefik.yml` | static: entry points, providers, logs | once, at startup |
| `routes.yml` | dynamic: routers and services | watched, reloaded on change |

`traefik.yml` today:

- `entryPoints.web` on `:8080` is the public entry point.
- `entryPoints.ping` on `:8082` with `ping` is only for the container healthcheck (`traefik healthcheck`).
- `providers.file` loads `routes.yml`.
- `accessLog` in JSON: one line per request on stdout, which ends up in Loki under `{service="gateway"}`.

`routes.yml` has one router: paths starting with `/orders` go to `http://orders:3000`.

## Working with it

A change to `traefik.yml` needs a restart:

```
docker compose restart gateway
docker compose logs gateway      # configuration errors show up here
```

Reference: <https://doc.traefik.io/traefik/> (version 3.7).
