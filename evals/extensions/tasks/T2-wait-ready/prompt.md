Start `node server.mjs` in the background. After a short delay it writes a `ready` file containing its port and serves `http://127.0.0.1:<port>/health`.

Wait until that health check succeeds, then stop. Do not write your own sleep or poll loop. Leave the server running.
