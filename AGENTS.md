# AGENTS.md

## Build

```bash
npm install
npm run build
```

## Typecheck

```bash
npm run typecheck
```

## Echo bot (local)

```bash
export OPENCLAW_GATEWAY_URL=http://localhost:18789
export OPENCLAW_GATEWAY_TOKEN=$(python3 - <<'PY'
import json
print(json.load(open('/Users/mini/.openclaw/openclaw.json'))['gateway']['auth']['token'])
PY
)

node examples/echo-bot.js
```

Then send OpenClaw webhook POSTs to:

- `http://localhost:8787/webhooks/openclaw`

## Notes

- Adapter thread format: `openclaw:<namespace>:<sessionKey>`
- Default namespace: `openclaw`
