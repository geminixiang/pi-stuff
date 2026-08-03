# pi-stuff site

Static, dependency-free product site for pi-stuff. It uses semantic HTML, CSS, and progressively enhanced JavaScript; there is no build step.

## Cloudflare Pages

Create a Pages project connected to the `pi-stuff` repository and use:

- **Production branch:** `main`
- **Framework preset:** None
- **Build command:** leave empty
- **Build output directory:** `site`
- **Root directory:** repository root

Cloudflare Pages will publish `site/index.html` and apply the security and cache rules in `site/_headers`.

## Local preview

Any static file server can serve this directory. No dependencies are required. For example, from the repository root:

```sh
npx serve site
```

The site remains readable when JavaScript is disabled. Motion respects `prefers-reduced-motion`.
