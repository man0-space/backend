# man0 backend

The Fastify API manages authentication and NEAR accounts, builds workflow graphs with Vibe, coordinates execution, routes Intents and settles x402 service fees. See the [project overview](https://github.com/man0-space/submission), [developer docs](https://docs.man0.space/developer/overview) and [judge walkthrough](https://github.com/man0-space/submission/blob/main/JUDGES.md).

Copy `.env.example` to `.env` and fill the required service values. Use dedicated databases for this checkout. In this directory:

```sh
npm ci
npm run migrate
npm run dev
```

Run `npm run build` to check TypeScript. The judge walkthrough includes the focused payment, wallet and proof tests.
