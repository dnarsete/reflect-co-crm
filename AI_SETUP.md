# AI Assistant — Activation Guide

The AI assistant infrastructure is fully built and **currently dormant** (zero cost). Until you flip it on, the Help tab uses the simple rule-based answer system. This guide is the step-by-step to activate the real Claude-powered AI when you're ready.

## Current state

- ✅ Edge Function code is in `supabase/functions/ai-assistant/index.ts`
- ✅ Frontend supports `AI_MODE: 'live'` (currently set to `'off'` in `config.js`)
- ✅ Tools defined for: accounts, orders, forecasts, revenue summary, overdue accounts, promotions, products, period comparison
- ✅ Admin-only tools: rep performance breakdown, forecast rollup, list reps
- ✅ Row-Level-Security is preserved (Edge Function passes user JWT to Supabase)
- ✅ Prompt caching enabled on system prompt + tool definitions (~10x cost reduction)

## Activation checklist (~10 min once you have credits)

### 1. Get an Anthropic API key

1. Sign up at <https://console.anthropic.com>
2. Add credit (Settings → Billing → Buy credits — $5 is more than enough for testing)
3. Create an API key (Settings → API Keys → Create Key)
4. Copy the key (starts with `sk-ant-…`)

### 2. Add the key as a Supabase secret

```bash
# Option A: via Supabase Dashboard
# 1. Open https://supabase.com/dashboard/project/clzpkjssxvmgvgloxehk/settings/edge-functions
# 2. Click "Manage secrets" → New secret
# 3. Name: ANTHROPIC_API_KEY
# 4. Value: paste your sk-ant-... key
# 5. Save

# Option B: via Supabase CLI (if installed)
supabase secrets set ANTHROPIC_API_KEY=sk-ant-xxxxx
```

Optional: also set `ANTHROPIC_MODEL` to override the default (`claude-haiku-4-5-20251001`). Values:
- `claude-haiku-4-5-20251001` — cheapest, fastest (default)
- `claude-sonnet-4-6` — better at complex analysis, ~5x cost
- `claude-opus-4-7` — best reasoning, ~25x cost (overkill for most CRM use)

### 3. Deploy the Edge Function

Option A — via Supabase Dashboard (no CLI needed):
1. Open <https://supabase.com/dashboard/project/clzpkjssxvmgvgloxehk/functions>
2. Click **Create a new function**
3. Name: `ai-assistant`
4. Paste the entire contents of `supabase/functions/ai-assistant/index.ts`
5. **Deploy**

Option B — via Supabase CLI:
```bash
cd reflect-co-crm
supabase functions deploy ai-assistant
```

### 4. Flip the feature flag

In `config.js`:
```js
AI_MODE: 'live',  // was 'off'
```
Commit and push. GitHub Pages auto-deploys in ~60 seconds.

### 5. Verify

1. Hard-refresh the CRM (⌘+Shift+R)
2. Open the **💬 Help** tab → top right should now show "AI: live" badge
3. Try a question: *"Which of my accounts haven't ordered in 60 days?"*
4. Confirm a real, reasoned answer (not the canned rule-based response)

## Cost monitoring

- Anthropic dashboard shows real-time spend at <https://console.anthropic.com/settings/usage>
- Per-query cost is logged in the Edge Function response payload (`usage` field) — you can dump that to a Supabase table later for in-app metrics
- Estimated cost per query with Haiku: $0.001–0.005. Sonnet: $0.005–0.030

## Adjusting tools and behavior

- **Tools**: edit `buildTools()` in `index.ts`. Each tool needs a schema definition and a corresponding case in `runTool()`.
- **System prompt / business rules**: edit `buildSystemPrompt()` in `index.ts`.
- **Model**: change `MODEL` constant or set `ANTHROPIC_MODEL` secret.
- **Iteration cap**: `MAX_TURNS` constant.

## Deactivate at any time

Set `AI_MODE: 'off'` in `config.js`, push, done. The rule-based answer system kicks back in. No data lost.

## Troubleshooting

| Error in Help tab | Likely cause | Fix |
|---|---|---|
| `AI not configured (ANTHROPIC_API_KEY missing)` | Secret not set in Supabase | Step 2 |
| `Anthropic API 401` | Invalid API key | Regenerate key, update secret |
| `Anthropic API 429` | Rate limit (very rare on Anthropic) | Wait a minute, try again |
| `Anthropic API 402` | Out of credit | Top up at console.anthropic.com |
| `Account disabled` | This user is disabled in profiles | Admin re-enables them |
| `Not authenticated` | User session expired | Sign back in |
