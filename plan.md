# HVAC AI Voice Receptionist — Project Plan

> **Status:** Phase A complete & verified. High-contrast UI overhaul completed with Aeonik Trial typography & interactive calendar. Next: Phase C (Dashboard Login).
> **Last updated:** 2026-09-06
> **Author:** Codex (with TL)

---

## 1. What we're building

A 24/7 AI voice receptionist for a small HVAC business. Customers call (or click), the agent talks to them in natural voice, books appointments, looks up existing ones, and hands off to a human for emergencies. The owner has a dashboard to watch calls, manage appointments, and (in the next phase) call the agent directly from the browser.

```
                ┌─────────────────────────────────────────────────┐
                │                  Customer                       │
                │   (phone call today, embed widget tomorrow)     │
                └─────────────────────┬───────────────────────────┘
                                      │ SIP / WebRTC
                                      ▼
                ┌─────────────────────────────────────────────────┐
                │              LiveKit Cloud (DE 2)               │
                │         room: hvac-<uuid> per session           │
                └────────────┬─────────────────────┬─────────────┘
                             │ audio                │ audio
                             ▼                      ▼
       ┌─────────────────────────────┐  ┌──────────────────────────────┐
       │  Render Worker              │  │  Dashboard (browser)         │
       │  agent: hvac-receptionist   │  │  Vercel — owner-only for now │
       │  LLM: Groq  STT: Deepgram   │  │                              │
       │  TTS: Cartesia  VAD: Silero │  │  future: Live Call button   │
       └─────────────┬───────────────┘  └──────────────┬───────────────┘
                     │                                  │
                     └──────────────┬───────────────────┘
                                    ▼
                ┌─────────────────────────────────────────────────┐
                │        Render API (FastAPI + SQLite)           │
                │   /health  /v1/config/public                   │
                │   /v1/calls  /v1/appointments                  │
                │   /v1/calls/token  ← new in Phase A            │
                └─────────────────────────────────────────────────┘
```

**Two audiences the system has to serve:**
1. **Customers** — call (or eventually click) and get help, no login, no app to install.
2. **Owner / staff** — log into a dashboard, see calls/appointments, test the agent, manage the business.

---

## 2. What's done so far (live today ✅)

- **Backend API** — `https://hvac-receptionist.onrender.com/health` → `{"status":"ok"}`
- **LiveKit agent worker** — registered as `hvac-receptionist`, joins rooms, takes calls, speaks opening greeting immediately
- **Dispatch API** — `POST /v1/calls/token` creates LiveKit room tokens for browser calling
- **Dashboard** — `https://hvac-receptionist-umber.vercel.app` (Live Call console, Calls log, Appointments with interactive month calendar & table view, pure white background, Aeonik Trial typography, avatar logo)
- **CORS** — Vercel → Render wired (`CORS_ORIGINS` set on Render)
- **Code on GitHub** — repo pushed
- **Cold-call workflow proven** — end-to-end via WebRTC browser call and LiveKit Playground

---

## 3. Build roadmap (the rest of the work)

| Phase | What | Why | Estimate |
|---|---|---|---|
| **A** | **Live Call page in the dashboard** (the "call button") | Owner can demo the agent in 1 click without opening LiveKit Playground. The single biggest UX gap. | 1 session |
| **B** | **Customer embed widget** | Real customers need a way in before we get a phone number. Drop a `<script>` on the HVAC business's site → chat/voice bubble. | 1–2 sessions |
| **C** | **Dashboard login** (single password, env-driven) | The Vercel URL is public. Need at minimum a password before sending this to any real business. | 0.5 session |
| **D** | **CRM upgrade** (customers page, calendar view, edit/delete) | Once the agent is taking real calls, the owner needs to manage them. | 2–3 sessions |
| **E** | **SIP / real phone number** (LiveKit + Twilio/Telnyx SIP trunk) | A demo button isn't a real product. Real businesses need a phone number. | 1–2 sessions, ~$1–5/mo |
| **F** | **Client delivery** (Hetzner VPS + domain, for the first paying client) | Render/Vercel is fine for demos and dev. A paying client gets their own box. | 1 session + ~€5/mo |

**Order: A → C → B → D → E → F**

- **A** is the demo unlock (you can show the agent working in a polished UI today).
- **C** locks the door before we show it to anyone outside us.
- **B** and **D** are the two halves of "make it a real product" (customer-facing + owner-facing).
- **E** is the only piece that costs real money and requires a vendor account, so we leave it for when there's a client to put it on.
- **F** is the hand-off, not a build step.

---

## 4. Phase A — Live Call page (the call button) — detailed

This is the part you specifically asked about. It is the next thing we build.

### 4.1 Goal

From the dashboard, click **Start call** → talk to the AI agent in the browser using the mic. Click **End call** → session ends, the call is recorded in the DB like any other call. The owner never opens the LiveKit Playground again.

### 4.2 How it works (data flow)

```
┌──────────────┐                                  ┌──────────────────┐
│  Dashboard   │  1. POST /v1/calls/token         │   Render API     │
│  (browser)   │ ───────────────────────────────► │   (FastAPI)      │
│              │ ◄─────────────────────────────── │                  │
│              │  { url, token, room }            │   generates a    │
│              │                                  │   LiveKit JWT    │
│              │  2. Connect with token           │   using API key  │
│              │ ───────────────────────────────► │                  │
│              │                                  └────────┬─────────┘
│              │  3. WebRTC media                          │
│              │ ◄────────────────────────────────────────►│
│              │  (audio: mic up, agent voice down)        │
│              │                                           ▼
│              │                                  ┌──────────────────┐
│              │  4. agent joins the same room    │  Render Worker   │
│              │     (auto-dispatch by name)      │  (hvac-receptionist)
└──────────────┘                                  └──────────────────┘
```

The browser never sees the LiveKit API secret — it only gets a short-lived JWT minted by the backend. The worker is the same one we already have running; no changes to the agent code.

### 4.3 Files to change — Backend

| File | Change | Why |
|---|---|---|
| `backend/pyproject.toml` | Add `"livekit-api>=0.12,<1.0"` to `dependencies` | We need `livekit-api` (separate from `livekit-agents`) to mint JWTs server-side. |
| `backend/app/agent/dispatch.py` | **NEW** — `create_room_and_token(room_name, identity, ttl=3600)` using `livekit.api.LiveKitAPI` + `AccessToken` | Keeps token logic in one place, easy to test, hides the API secret from the route. |
| `backend/app/main.py` | (a) Widen CORS: `allow_methods=["GET", "POST"]`. (b) Add `POST /v1/calls/token` route. (c) Route calls `dispatch.create_room_and_token(...)` and returns `{url, token, room}`. | This is the only new public endpoint in Phase A. The dispatch module is the only thing that ever touches `LIVEKIT_API_KEY` / `LIVEKIT_API_SECRET`. |
| `backend/app/call_tracking.py` | No code change, but Phase A finally exercises it: the call created by the dashboard gets a real `caller_phone=None` row, a real transcript, and a real outcome. | Validates the call-tracking path end-to-end. |
| `backend/.env.example` | Add a comment that `LIVEKIT_URL` is also consumed by the token endpoint (so devs know where `wss://` comes from). | Docs. |
| `backend/tests/test_dispatch.py` | **NEW** — unit test that `create_room_and_token` returns a non-empty token and the same room name twice in a row (so re-clicks don't spawn duplicate rooms). | Safety net. |

### 4.4 Files to change — Frontend

| File | Change | Why |
|---|---|---|
| `frontend/package.json` | Add `"@livekit/components-react": "^2.6"` and `"livekit-client": "^2.6"` | Official LiveKit React bindings — handle token storage, room lifecycle, mic permission, audio playback. No custom WebRTC code. |
| `frontend/src/components/ui/live-call-page.tsx` | **NEW** — A page with: idle state (big "Start call" button, mic permission hint), in-call state (mic toggle, mute, end call button, elapsed timer, connection state pill), ended state (transcript preview if available, "Start another call" CTA). | One self-contained page, doesn't touch the existing dashboard. |
| `frontend/src/App.tsx` | (a) Import `LiveCallPage`. (b) Add a "Live Call" item to the sidebar with the `PhoneCall` lucide icon (already in the dep). (c) Wire it into the existing page router. | The page already has a router — 5-line change. |
| `frontend/src/lib/api.ts` | Add `apiPost(path, body)` helper that handles base URL + JSON + error throwing, mirroring the existing `apiUrl`. | Consistent with the GET path, used by exactly one call. |
| `frontend/.env.example` (new if missing) | `VITE_LIVEKIT_URL=wss://hvac-68aybu47.livekit.cloud` (the same URL already on Render). | The token endpoint hands back the URL too, but we keep an env var for the "preview" tooltip. |
| **Vercel env vars** | Add `VITE_LIVEKIT_URL` to the Vercel project. | So the Vercel build embeds it. |

### 4.5 Edge cases being covered

- **Re-click "Start call" while already in a call** → block on the client (button disabled) **and** reject on the server (`409 Conflict`).
- **Worker not running / LiveKit rejects the dispatch** → return `503` with a clear error so the UI can show "agent offline, try again".
- **Mic permission denied** → caught client-side, show a banner, never POST.
- **Token expired (1h TTL) while in a call** → LiveKit drops the participant; the UI listens for `Disconnected` and shows "call ended".

### 4.6 Verification (what "done" means for Phase A)

1. `git push` → Render auto-builds → no errors in deploy log.
2. `https://hvac-receptionist.onrender.com/v1/calls/token` returns `405` on GET and a real `{url, token, room}` on `POST {}`.
3. Vercel build is clean after `VITE_LIVEKIT_URL` is added.
4. On `https://hvac-receptionist-umber.vercel.app/live-call`:
   - Idle screen renders, "Start call" button visible.
   - Click → mic prompt → connect → agent says hello within ~1s.
   - Speak → agent responds.
   - Click "End" → return to idle → row appears in `/calls` within 1s.
5. Reload the page → state cleanly idle (no zombie rooms).
6. Two browsers click "Start" at the same time → two separate rooms, no cross-talk.

### 4.7 Definition of Done

Phase A is done when the owner can demo the entire product to a prospect by opening one Vercel URL, clicking **Live Call**, and having a real conversation with their AI receptionist — no Playground, no separate tokens, no developer in the loop.

---

## 5. Phase C — Dashboard login (0.5 session)

Single shared password from `VITE_DASHBOARD_PASSWORD` and `DASHBOARD_PASSWORD`, hashed check on the API side for any `/v1/*` mutation, plus a frontend gate that wraps `<App />` and stores a session token in `sessionStorage`.

**Why before B:** the second we let real customers in (B), the dashboard is the only thing standing between the public and the owner's data, and it has to be locked.

---

## 6. Phase B — Customer embed widget (1–2 sessions)

A small `<script src="https://hvac-receptionist.onrender.com/embed.js">` that drops a chat/voice bubble in the bottom-right of any page. Click → same flow as the Live Call page, but with a different identity (`visitor-<uuid>`) and a different agent greeting. The agent is already built; the widget is just a thinner Live Call page mounted via Shadow DOM so it doesn't fight the host site's CSS.

**Why it's after A:** we already need the dispatch endpoint and the LiveKit client wiring for A; B reuses 100% of that.

---

## 7. Phase D — CRM upgrade (2–3 sessions)

Customers list (deduplicated by phone, merge on callback), edit/delete on appointments, calendar view (month + week), per-call detail page with the full transcript. Backed by SQLAlchemy on the existing SQLite, with the same patterns already in `call_tracking.py` and `scheduling.py`.

---

## 8. Phase E — SIP / real phone number (1–2 sessions, ~$1–5/mo)

LiveKit SIP trunk + Twilio or Telnyx number. The agent code is unchanged — LiveKit delivers the audio as a SIP participant in the same room.

**Why last:** needs a vendor account + monthly cost + a real client's number, so we don't do it until there's a real caller to route to.

---

## 9. Phase F — Client delivery (1 session + ~€5/mo)

Hetzner CX22 (or similar) VPS, Caddy + Docker Compose, real domain, separate Render → Hetzner migration once a paying client exists.

**Why last:** Render is fine for demos and dev; a paying client should be on its own infrastructure, but that's a hand-off task, not a build task.

---

## 10. Cost summary (today vs. with a client)

| Item | Today (demo) | With 1 client (Phase E + F) |
|---|---|---|
| Render (API + worker) | $0 (free tier, spins down on idle) | ~$7/mo (always-on starter) |
| Vercel (dashboard) | $0 (hobby) | $0 |
| LiveKit Cloud | $0 (free dev tier) | ~$0–50/mo depending on minutes |
| Groq / Deepgram / Cartesia | $0 (free tiers) | ~$0–20/mo |
| Twilio/Telnyx phone number | — | ~$1–5/mo |
| Hetzner VPS | — | ~€5/mo |
| **Total** | **$0** | **~$15–85/mo per client** |

---

## 11. Decisions logged

- **LiveKit Cloud (Germany 2)** for WebRTC — generous free tier, ships fast.
- **Groq** for LLM (llama-3.3-70b-versatile) — fast, cheap, OpenAI-compatible API.
- **LiveKit inference** for STT/TTS (Deepgram nova-3, Cartesia sonic-3) — one vendor, one bill.
- **Render** for backend — picked over Fly.io (needs card) and Koyeb (shutting down).
- **Vercel** for dashboard — free, fast preview deploys.
- **SQLite** for the demo — single operator, single file, zero ops. Postgres is a Phase F (or later) conversation.
- **Theme + WebGL shader on the dashboard** — the user said "make it feel premium" early on, and it does. Keeping it.
- **No phone number yet** — Phase E. The whole point of Phases A–D is to make the product demoable *without* a phone number.

---

## 12. Open questions

1. **Per-customer config in the dashboard?** Right now `business_company_name`, `services`, `opening_hours`, etc. live in Render env vars. For multiple clients (Phase F), they need to be per-tenant in the DB. Not blocking until F.
2. **Multi-tenant in the widget?** Phase B's widget will be a single shared agent. If we want different agents per business, the embed script needs a tenant ID. Defer to when we have 2+ clients.
3. **Recording storage?** LiveKit can record rooms to S3. Out of scope for A–D; revisit in E/F.

---

## 13. File index (where to look)

- `plan.md` — this file
- `referenced-chatgpt-conversation-this-is-an/README.md` — what the project is
- `referenced-chatgpt-conversation-this-is-an/DEPLOYMENT.md` — how it's deployed
- `referenced-chatgpt-conversation-this-is-an/backend/app/main.py` — FastAPI routes (Phase A adds `POST /v1/calls/token` here)
- `referenced-chatgpt-conversation-this-is-an/backend/app/agent/worker.py` — LiveKit agent (unchanged in Phase A)
- `referenced-chatgpt-conversation-this-is-an/backend/app/agent/dispatch.py` — **NEW in Phase A** (token + room)
- `referenced-chatgpt-conversation-this-is-an/backend/pyproject.toml` — **add `livekit-api` in Phase A**
- `frontend/src/App.tsx` — page router (Phase A adds Live Call route here)
- `frontend/src/components/ui/live-call-page.tsx` — **NEW in Phase A**
- `frontend/src/components/ui/sidebar.tsx` — sidebar (Phase A adds the Live Call item)
- `frontend/package.json` — **add `@livekit/components-react` + `livekit-client` in Phase A**
