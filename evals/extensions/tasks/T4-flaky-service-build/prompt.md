Start a small HTTP service in this directory with `node server.mjs`. It listens on 127.0.0.1 and is flaky at first (the first responses are 503). Keep it running under process supervision so it still listens if this session is killed.

Then run `node build.mjs` in the background. The build retries the flaky service, writes `build-ok` once it gets HTTP 200, and keeps running. Do not block the session on either process.
