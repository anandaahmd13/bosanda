# Nginx configuration

Edge for the three Bosanda domains (PLAN.md §16, §18). Nothing here has been loaded
by a real nginx — `nginx` is not installed in the authoring environment, so
`nginx -t` was **not** run. Treat the first `nginx -t` on the VPS as the real
syntax check and expect to fix typos.

| Domain              | Upstream         | App             | Buffering |
| ------------------- | ---------------- | --------------- | --------- |
| `bosanda.dev`       | `127.0.0.1:3000` | Next storefront | on        |
| `admin.bosanda.dev` | `127.0.0.1:3001` | Next admin      | on        |
| `api.bosanda.dev`   | `127.0.0.1:4000` | Fastify gateway | **off**   |

`proxy_buffering off` on the API vhost is the load-bearing detail. With buffering
on, SSE deltas arrive batched or not until the turn completes, and streaming — the
thing Bosanda sells — does not work. The asymmetry between the API vhost and the
two app vhosts is deliberate, not an oversight: buffering is correct for HTML and
fatal for SSE.

## Layout

```text
conf.d/
  00-bosanda-http.conf              upstreams, log_format, hygiene   (http{} level)
snippets/
  bosanda-tls.conf                  protocols, ciphers, stapling     (server level)
  bosanda-security-headers.conf     HSTS, nosniff, Permissions-Policy
  bosanda-proxy-common.conf         forwarded headers, keepalive
sites-available/
  bosanda.dev.conf                  Next storefront  → 127.0.0.1:3000
  admin.bosanda.dev.conf            Next admin       → 127.0.0.1:3001
  api.bosanda.dev.conf              Fastify gateway  → 127.0.0.1:4000
```

Two ownership rules keep this tree from breaking in non-obvious ways:

- **Rate-limit zones live in the per-vhost files**, never in `conf.d`. Declaring
  the same zone name in two places is a fatal startup error, and the right rate
  for a token stream, a storefront page, and an admin report have nothing to do
  with each other.
- **Every `location` that calls `add_header` re-includes
  `bosanda-security-headers.conf`.** nginx does not merge `add_header` across
  levels: one `add_header` in a location silently discards every inherited
  security header for that path. The re-includes look redundant and are not.

## Install (OWNER ACTION — requires the real VPS)

```sh
sudo apt install nginx certbot
sudo mkdir -p /var/www/certbot

sudo install -m 0644 deploy/nginx/conf.d/00-bosanda-http.conf /etc/nginx/conf.d/
sudo install -m 0644 deploy/nginx/snippets/bosanda-*.conf     /etc/nginx/snippets/
sudo install -m 0644 deploy/nginx/sites-available/*.conf      /etc/nginx/sites-available/
```

## Certificate bootstrap (chicken-and-egg)

The vhosts reference `/etc/letsencrypt/live/...`, which does not exist on a fresh
box, and nginx **refuses to start** when an `ssl_certificate` path is missing. So
certificates must be issued before the HTTPS blocks are enabled.

1. Confirm DNS A/AAAA records for all three names point at the VPS. Certbot fails
   the challenge otherwise, and rate-limits after repeated failures.
2. Enable only the port-80 half: comment out every `listen 443` server block in
   the three vhost files, symlink them, `sudo nginx -t && sudo systemctl reload nginx`.
   The `/.well-known/acme-challenge/` location is exempt from the HTTPS redirect
   precisely so this step works.
3. Issue, with the webroot matching that location:

   ```sh
   sudo certbot certonly --webroot -w /var/www/certbot \
     -d bosanda.dev -d www.bosanda.dev
   sudo certbot certonly --webroot -w /var/www/certbot -d admin.bosanda.dev
   sudo certbot certonly --webroot -w /var/www/certbot -d api.bosanda.dev
   ```

   Apex and `www` share one certificate — `bosanda.dev.conf` assumes that.

   `certonly` is not optional. Certbot's nginx plugin rewrites server blocks and
   would replace the hand-audited settings in `bosanda-tls.conf` with its own
   weaker defaults.

4. Uncomment the 443 blocks, then enable everything:

   ```sh
   for h in bosanda.dev admin.bosanda.dev api.bosanda.dev; do
     sudo ln -sf /etc/nginx/sites-available/$h.conf /etc/nginx/sites-enabled/$h.conf
   done
   sudo rm -f /etc/nginx/sites-enabled/default  # else it answers unmatched Host headers
   sudo nginx -t && sudo systemctl reload nginx
   ```

5. Renewal: certbot installs its own systemd timer, but `certonly` does not reload
   nginx, so the certificate would renew on disk while nginx keeps serving the
   expired one until the next restart. Add the hook once:

   ```sh
   printf '#!/bin/sh\nsystemctl reload nginx\n' \
     | sudo tee /etc/letsencrypt/renewal-hooks/deploy/reload-nginx.sh
   sudo chmod 0755 /etc/letsencrypt/renewal-hooks/deploy/reload-nginx.sh
   sudo certbot renew --dry-run
   systemctl list-timers | grep certbot
   ```

## Verifying streaming actually streams

The failure mode is silent: buffering leaves clients working but holds every token
until the end. Check explicitly rather than assuming.

```sh
# Tokens must appear incrementally. If the whole body lands at once, buffering is
# back. -N disables curl's own buffering, which otherwise masks the problem.
curl -N -sS https://api.bosanda.dev/v1/chat/completions \
  -H "Authorization: Bearer $BOSANDA_KEY" \
  -H 'Content-Type: application/json' \
  -d '{"model":"<published-model>","stream":true,
       "messages":[{"role":"user","content":"count slowly to twenty"}]}'
```

Cross-check in the access log: on a streaming request `upstream_header_time`
should be a small fraction of `request_time`. If they are nearly equal, nginx held
the response.

```sh
sudo tail -f /var/log/nginx/api.bosanda.dev.access.log | grep chat/completions
```

## Body size

`client_max_body_size 8m` on the API vhost mirrors `LIMITS.maxBodyBytes`
(`8 * 1024 * 1024`) in `packages/protocol/src/limits.ts`. Changing one without the
other either hands clients an unparseable HTML 413 from nginx (if nginx is lower)
or lets oversized bodies reach Node (if nginx is higher). The gateway owns the
error shape; nginx is the backstop.

## Owner actions still outstanding

- **CSP on the two Next vhosts.** A strict `script-src 'self'` with no
  `unsafe-inline` needs a per-request nonce that only the app can generate — nginx
  has no CSPRNG in plain configuration. If `apps/web` also sends a CSP header the
  browser enforces the intersection of both, which breaks the nonce policy. Pick a
  single owner for the header; see the comment block in `bosanda.dev.conf`. No
  Next app was built or served during this work, so this is unverified.
- **Admin IP allowlist or WireGuard** — the block is present and commented in
  `admin.bosanda.dev.conf`. Enabling it wrongly locks the owner out, and v1 has no
  email recovery channel. Test from mobile data with an SSH session still open.
- **Pakasir source-IP restriction** on the webhook path, once the ranges are
  published. Guessing would break order activation.
- **`resolver 127.0.0.53`** in `bosanda-tls.conf` assumes systemd-resolved. A wrong
  value makes OCSP stapling fail silently; the handshake still succeeds.
- **Do not submit HSTS `preload`** until all three names serve valid HTTPS. It is
  effectively irreversible.
