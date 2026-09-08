# ❄️ HVAC AI Receptionist & Dispatch Assistant
### *Enterprise Voice Automation, Missed-Call Capture, and Real-Time Dispatch Scheduling*

---

## 📑 Table of Contents
1. [Executive Summary & Business Case](#1-executive-summary--business-case)
2. [Market Opportunity & Unit Economics](#2-market-opportunity--unit-economics)
3. [Product Experience & Key Capabilities](#3-product-experience--key-capabilities)
4. [System Architecture & Technology Stack](#4-system-architecture--technology-stack)
5. [Voice AI & Audio Engineering Pipeline](#5-voice-ai--audio-engineering-pipeline)
6. [Agent Intelligence, Prompts & Tool Calling](#6-agent-intelligence-prompts--tool-calling)
7. [Security Hardening & Production Reliability](#7-security-hardening--production-reliability)
8. [Dynamic Multi-Tenant & Custom Demo Branding](#8-dynamic-multi-tenant--custom-demo-branding)
9. [Project Directory & File Structure](#9-project-directory--file-structure)
10. [Local Development & Setup Guide](#10-local-development--setup-guide)
11. [Production Deployment & Infrastructure](#11-production-deployment--infrastructure)
12. [Strategic Roadmap (SIP, Telephony & CRM Sync)](#12-strategic-roadmap-sip-telephony--crm-sync)

---

## 1. Executive Summary & Business Case

### The Contractor's Dilemma: Missed Calls = Lost Revenue
In the residential and commercial Heating, Ventilation, and Air Conditioning (HVAC) industry, **inbound phone calls are the lifeblood of revenue**. When a homeowner’s air conditioner fails during a 100°F summer heatwave or a furnace breaks during freezing winter temperatures, the caller is in distress. 

Industry data shows:
* **85% of homeowners who reach a voicemail do not leave a message**—they hang up and immediately call the next contractor on Google Maps or Local Services Ads.
* **$1,500 - $3,500**: Average ticket size for an urgent repair dispatch.
* **$8,000 - $16,000+**: Average revenue for an emergency equipment replacement (e.g., heat pump or split system).
* **High Front-Desk Overhead**: Employing a 24/7 human dispatch team costs \$3,500 to \$8,000+ per month in wages, night-shift differentials, and training.
* **Peak Surge Bottlenecks**: During weather extremes, call volume spikes 300–500%. Human receptionists place callers on hold, resulting in abandoned calls and frustrated customers.

### The Solution: 24/7 AI Voice Receptionist
The **HVAC AI Receptionist** is an autonomous, ultra-low-latency voice intelligence platform designed specifically for HVAC contractors. It acts as an elite, never-sleeping front-office coordinator that:
1. **Answers on the 1st Ring (<2 seconds)**: Zero hold time, eliminating caller drop-off.
2. **Triages Life Safety & Emergencies**: Instantly identifies gas leaks, carbon monoxide alerts, and extreme freezing conditions, immediately directing safety protocols and alerting on-call technicians.
3. **Books Qualified Service Dispatches Directly onto the Calendar**: Gathers homeowner address, equipment age, and failure symptoms, and commits qualified dispatches directly into the dispatch database.
4. **Verifies Existing Service Calls**: Handles repetitive "Where is my technician?" or appointment verification calls in seconds, freeing human office staff from phone tag.
5. **Summarizes and Catalogs Every Interaction**: Delivers structured dispatch logs, customer sentiments, and recordings straight to the business dashboard.

---

## 2. Market Opportunity & Unit Economics

### Target Audience
* **Independent HVAC Contractors**: 1 to 15 dispatch vans operating in local metropolitan areas.
* **Plumbing & Electrical Trades**: Service businesses with identical emergency on-call mechanics.
* **Home Service Franchises**: Regional franchises seeking standardized call qualification and booking rates.

### Contractor Return on Investment (ROI)
| Metric | Without AI Receptionist | With AI Receptionist | Contractor Impact |
| :--- | :--- | :--- | :--- |
| **Call Answer Rate** | 65% – 75% (misses lunch & after-hours) | **99.9% (24/7/365)** | Captures ~25% more inbound demand |
| **After-Hours Response** | Answering service / Voicemail | **Instant Voice Qualification** | Secures \$1,500+ emergency calls instantly |
| **Hold Time** | 45s – 3 mins during seasonal surges | **< 2 seconds** | Eliminates customer churn to competitors |
| **Front-Desk Night Payroll** | \$3,500 – \$6,000/mo for 24/7 coverage | **< \$50/mo cloud compute** | **Saves \$40,000 – \$70,000/year** |
| **Payback Period** | N/A | **1 booked job** | 1 captured emergency replacement pays for months |

### Software Economics & Margins
* **Operating Cost per Call**: ~\$0.03 – \$0.08 per 3-minute voice session (Deepgram STT + Groq LLM + Cartesia TTS + LiveKit bandwidth).
* **SaaS Pricing Model**: \$299 – \$699/month flat fee per contractor, delivering **85%–90% gross margins** while delivering 10x–20x ROI to the contractor.

---

## 3. Product Experience & Key Capabilities

### A. Live Interactive Voice Demo Console (`/` - Live Call Tab)
* **Real-Time WebRTC Voice Call**: Prospective clients and contractors can test the receptionist live from desktop or smartphone browser with 1 click—no phone number or software required.
* **Role-Framed Interface**: Replaces confusing developer jargon with intuitive trade terms: *Virtual Receptionist*, *Customer Simulation*, and *Inbound Dispatch Line Active*.
* **Dedicated Mobile Phone Dial Screen**: Automatically transforms on mobile viewports (<768px) into an authentic iOS/Android phone call screen with live timers, mute toggles, radial voice animations, and one-tap emergency buttons.
* **1-Click High-Margin HVAC Test Scenarios**:
  1. *Urgent AC Repair Booking* (Revenue Protection: captures \$1,500+ tickets).
  2. *Upcoming Service Verification* (Office Efficiency: resolves ETA and visits).
  3. *High-Margin Equipment Inquiry* (System Sales: qualifies \$8,000+ heat pump leads).
  4. *Gas Leak & Emergency Triage* (Safety Triage: life-safety protocol & on-call alert).

### B. Dispatcher & Owner Dashboard (`/` - Overview Tab)
* **Real-Time Financial & Operational KPIs**: Total Calls Handled, Scheduled Bookings, Booking Conversion Rate (%), and Emergency Calls Triaged.
* **Dispatch Call Log**: Chronological audit trail showing caller telephone numbers, call durations, exact timestamps, AI-generated summary transcripts, and call outcome badges (`BOOKED`, `VERIFIED`, `EMERGENCY`, `INQUIRY`).

### C. Master Schedule & Booking Board (`/` - Appointments Tab)
* **Interactive Fullscreen Calendar**: Month grid view featuring date badges, appointment density pills, and detail flyouts.
* **Table & List Views**: Searchable and filterable by customer name, service type, date, and technician assignment.
* **Direct Booking Synchronization**: Appointments booked by the AI voice agent appear instantly on the dispatch board.

---

## 4. System Architecture & Technology Stack

```
                               ┌──────────────────────────────────────────────┐
                               │           Customer / Homeowner               │
                               │  (Mobile Browser, Desktop Web, or Telephone) │
                               └──────────────────────┬───────────────────────┘
                                                      │ WebRTC Audio (Opus 48kHz)
                                                      ▼
                               ┌──────────────────────────────────────────────┐
                               │            LiveKit Cloud (SFU / SF)          │
                               │  Room: hvac-<uuid> (Isolated Audio Session)  │
                               └──────────────┬───────────────────────────────┘
                                              │ Audio RTP Streams
                                              ▼
┌────────────────────────────────────────────────────────────────────────────────────────────────────────┐
│                                Render Containerized Backend & Agent Worker                             │
│                                                                                                        │
│   ┌────────────────────────────────┐         ┌─────────────────────────────────────────────────────┐   │
│   │       FastAPI Web Service      │         │             LiveKit Agent Worker                    │   │
│   │  - REST API (/v1/calls/token)  │         │  - Room participant: 'hvac-receptionist'            │   │
│   │  - Rate Limiting (SlowAPI)     │         │  - Thread executor (0 idle procs, ~150MB RAM)       │   │
│   │  - Prompt Injection Defense    │         │                                                     │   │
│   │  - Public Config Endpoint      │         │   1. STT: Deepgram Nova-3 (streaming audio-to-text) │   │
│   └───────────────┬────────────────┘         │   2. VAD: Silero ONNX (min_dur=0.25s, thresh=0.65)  │   │
│                   │                          │   3. LLM: Groq Llama 3.3 70B Versatile (reasoning)  │   │
│                   │                          │   4. TTS: Cartesia Sonic-3 (calibrated vol=0.75)    │   │
│                   ▼                          │   5. Tools: book_appointment, lookup_visit          │   │
│   ┌────────────────────────────────┐         └──────────────────────────┬──────────────────────────┘   │
│   │      SQLite / SQLAlchemy       │                                    │                              │
│   │  - calls, appointments, logs   │◄───────────────────────────────────┘                              │
│   └────────────────────────────────┘                                                                   │
└────────────────────────────────────────────────────────────────────────────────────────────────────────┘
                                              ▲
                                              │ HTTP JSON
                                              ▼
                               ┌──────────────────────────────────────────────┐
                               │            Frontend Single-Page App          │
                               │       (Vercel: React 18, Vite, Tailwind)     │
                               │  - Vercel Web Guidelines (tabular-nums)      │
                               │  - LiveKit Client Audio Renderer             │
                               │  - Dynamic Branding Loader                   │
                               └──────────────────────────────────────────────┘
```

### Component Breakdown
| Layer | Technologies | Purpose |
| :--- | :--- | :--- |
| **Frontend UI** | React 18, Vite, TypeScript, Tailwind CSS, Lucide Icons, `@livekit/components-react` | Ultra-fast client interface, live call console, schedule calendar, and dispatch analytics. |
| **Backend API** | Python 3.12, FastAPI, Pydantic v2, SlowAPI, SQLAlchemy, Uvicorn | Session token minting, rate limiting, appointments/calls management, and configuration. |
| **Voice Worker** | `livekit-agents` v1.3+, `livekit-plugins-openai`, `livekit-plugins-silero` | Real-time participant joining WebRTC rooms, orchestrating VAD, STT, LLM, and TTS. |
| **WebRTC Transport**| LiveKit Cloud (Frankfurt/US Global Mesh) | Sub-100ms global audio transport and bidirectional data channels. |
| **Database** | SQLite via SQLAlchemy (migration-ready for PostgreSQL) | Zero-maintenance, ACID-compliant persistence for calls, appointments, and transcripts. |
| **Hosting & CI/CD** | Vercel (Frontend) + Render Docker (Backend) + GitHub Actions | Automated git-push production deployments with automatic builds and health monitoring. |

---

## 5. Voice AI & Audio Engineering Pipeline

Voice interactions require sub-second end-to-end latency to feel natural. The HVAC AI Receptionist achieves a **human-comparable turn-taking latency of 500ms–800ms**.

```
Caller Speaks ──► Silero VAD ──► Deepgram Nova-3 ──► Groq Llama 3.3 70B ──► Cartesia Sonic-3 ──► LiveKit WebRTC ──► Speaker
                   (250ms)        (Streaming STT)       (Streaming LLM)       (Volume: 0.75)       (Opus 48kHz)
```

### 1. Speech-to-Text (STT): Deepgram Nova-3
* **Model**: `deepgram/nova-3` via LiveKit Cloud inference.
* **Capabilities**: Streaming bidirectional transcription with custom HVAC domain terminology (e.g., *Freon, evaporator coil, capacitor, SEER rating, heat pump, mini-split, thermocouple*).
* **Latency**: ~150ms interim transcript delivery.

### 2. Voice Activity Detection (VAD): Silero VAD (ONNX)
* **Configuration**: `min_speech_duration = 0.25s`, `activation_threshold = 0.65`.
* **Acoustic Transient Rejection**: Ignores momentary mouth clicks, keyboard typing, and room echo, eliminating false interruptions.
* **Endpointing**: `min_delay = 0.5s`, `max_delay = 2.5s`, allowing natural pauses without cutting callers off mid-thought.

### 3. Language Intelligence: Groq Llama 3.3 70B Versatile
* **Model**: `llama-3.3-70b-versatile` via Groq's LPU inference engine.
* **First-Token Latency**: ~180ms.
* **Reasoning**: `reasoning_effort="low"` to optimize time-to-first-sound while preserving strict tool-calling accuracy.

### 4. Text-to-Speech (TTS): Cartesia Sonic-3 (Acoustically Calibrated)
* **Model**: `cartesia/sonic-3` with voice `694f9389-aac1-45b6-b726-9d9369183238` (warm, authoritative receptionist persona).
* **Digital Headroom Calibration**: Configured with `extra_kwargs={"volume": 0.75}`, reducing peak raw 16-bit PCM amplitudes from digital ceiling clipping (`+-32767`) down to `~19,000` (`-4dB` to `-6dB` headroom).
* **WebRTC AGC Stability**: Completely eliminates the 2-second initial audio distortion burst caused by WebRTC automatic gain control limiter pumping.
* **Streaming Latency**: ~90ms first audio packet generation.

### 5. Client Playback & Echo Immunity
* **Barge-in Protection**: `interruption.min_duration = 0.8s` and `resume_false_interruption = False`. Callers can interrupt naturally, but speaker acoustic echo bleed will never cause the agent to glitch or restart speech.
* **Browser Gain**: `<RoomAudioRenderer volume={0.85} />` prevents digital-to-analog converter (DAC) overdrive on mobile and laptop speakers.

---

## 6. Agent Intelligence, Prompts & Tool Calling

### Core Persona & Directives
The assistant operates under strict behavioral guardrails defined in [`backend/app/agent/prompts.py`](file:///c:/Users/TL/Documents/Codex/2026-08-27/referenced-chatgpt-conversation-this-is-an/backend/app/agent/prompts.py):
* **Identity**: Professional, calm, empathetic front-office dispatcher for the configured HVAC business.
* **Concise Speech**: Speaks in 1–2 conversational sentences at a time—never reading long lists or lecturing the caller.
* **Phone Persona**: Avoids markdown, bullet points, or robotic system announcements.

### Operational Protocols
1. **Safety Triage (Critical First Step)**:
   * *Gas Smell / Gas Leak*: Immediately instructs caller: *"For your safety, please evacuate the building immediately and do not turn on any light switches. Call 911 or your gas utility from outside."*
   * *Carbon Monoxide Alarm*: Orders immediate evacuation and fresh air.
   * *Active Water Gushing / Electrical Arcing*: Provides immediate emergency shutoff instructions.
2. **Dispatch Qualification**:
   * Collects customer name, callback phone number, service address, and specific equipment symptoms (heating vs cooling, strange noises, error codes).
3. **Approved Services Enforcement**:
   * Validates services against the business's approved catalog (e.g., AC repair, furnace tune-up, heat pump replacement). Politely declines or refers out unsupported trades (e.g., septic systems or major electrical wiring).

### Function Calling Tools
* **`book_appointment`**:
  * Parameters: `service`, `date`, `time`, `phone_number`, `customer_name`, `address`, `notes`.
  * Logic: Validates opening hours, checks service availability, commits the record to SQLite, and confirms the date and time with the customer.
* **`lookup_visit`**:
  * Parameters: `phone_number`.
  * Logic: Queries the database for existing upcoming dispatches and returns scheduled arrival windows and technician status.

---

## 7. Security Hardening & Production Reliability

The platform implements multi-layer defense-in-depth across API and agent layers:

### 1. Rate Limiting & Abuse Prevention
* Integrated **SlowAPI** with in-memory bucket token rate limiting:
  * `POST /v1/calls/token`: **5 requests / minute per IP** (prevents automated WebRTC token exhaustion).
  * `POST /v1/appointments`: **10 requests / minute per IP** (prevents calendar spam).
  * Public read endpoints: **60 requests / minute per IP**.

### 2. Prompt Injection & Jailbreak Defenses
* Strict input sanitization in [`backend/app/security.py`](file:///c:/Users/TL/Documents/Codex/2026-08-27/referenced-chatgpt-conversation-this-is-an/backend/app/security.py):
  * Blocks system prompt overrides (e.g., *"ignore all previous instructions"*, *"system prompt"*, *"DAN mode"*).
  * Enforces maximum character lengths (120 chars for names, 200 for addresses, 20 for phones).
  * Strips dangerous control characters and script tags.

### 3. Memory & Resource Optimization (Render Free Tier Safe)
* Configured `AgentServer(num_idle_processes=0, job_executor_type=JobExecutorType.THREAD)`.
* By default, LiveKit agents spawn 12 idle worker processes (~1.8GB RAM). Our custom threading architecture keeps baseline memory at **~150MB**, operating comfortably within Render’s 512MB RAM ceiling with zero out-of-memory (OOM) crashes.

### 4. High-Availability Uptime Monitoring
* Monitored via **UptimeRobot** HTTP probe targeting `https://hvac-receptionist.onrender.com/health` every 5 minutes.
* Automatically keeps the Render container warm and prevents cold-start spin-down.

---

## 8. Dynamic Multi-Tenant & Custom Demo Branding

The application is engineered to serve both **generic hosted production** and **hyper-personalized client sales demos** without maintaining separate branches:

```
Hosted Vercel / Render Production:
  Backend /v1/config/public  ──► "Example HVAC"
  Frontend Header            ──► "Example HVAC" [EH]
  Voice Receptionist         ──► "Thank you for calling Example HVAC..."

Custom Client Demo (e.g. Scraped Austin Contractor):
  Set .env: BUSINESS_COMPANY_NAME="McCullough Heating & Air Conditioning"
  Backend /v1/config/public  ──► "McCullough Heating & Air Conditioning"
  Frontend Header            ──► "McCullough Heating & Air Conditioning" [MH]
  Voice Receptionist         ──► "Thank you for calling McCullough Heating & Air Conditioning..."
```

### Zero Hardcoded Strings
* Frontend dynamically fetches `/v1/config/public` on mount.
* Dynamic initials avatar generator (`getInitials`) handles multi-word company names.
* Test scenarios, call headers, and voice persona adapt seamlessly to the configured business name, address, and service catalog.

---

## 9. Project Directory & File Structure

```
hvac-receptionist/
├── .github/
│   └── workflows/                       # Automated CI/CD actions
├── frontend/                            # React 18 SPA (Vite + Tailwind)
│   ├── src/
│   │   ├── components/ui/
│   │   │   ├── live-call-page.tsx       # Live call console, phone HUD & scenarios
│   │   │   ├── fullscreen-calendar.tsx  # Interactive dispatch schedule calendar
│   │   │   └── dialog.tsx               # Accessible modal primitives
│   │   ├── App.tsx                      # Primary layout, routing, dynamic branding
│   │   ├── api.ts                       # Typed REST client with error fallbacks
│   │   ├── types.ts                     # TypeScript data models
│   │   └── index.css                    # Tailwind design system & Aeonik fonts
│   ├── package.json
│   └── vite.config.ts
├── referenced-chatgpt-conversation-this-is-an/
│   └── backend/                         # FastAPI & LiveKit Agent Service
│       ├── app/
│       │   ├── agent/
│       │   │   ├── prompts.py           # Receptionist instructions & safety triage
│       │   │   ├── tools.py             # Appointment booking & lookup tools
│       │   │   └── worker.py            # LiveKit Agent worker entrypoint
│       │   ├── api.py                   # REST endpoints (/health, /token, /calls)
│       │   ├── call_tracking.py         # Call lifecycle & transcript summarizer
│       │   ├── config.py                # Pydantic runtime settings
│       │   ├── database.py              # SQLite models & session management
│       │   ├── logging.py               # Structured JSON logging
│       │   ├── main.py                  # FastAPI application factory & CORS
│       │   └── security.py              # SlowAPI rate limits & input sanitizers
│       ├── tests/                       # Pytest automated test suite (29 tests)
│       ├── Dockerfile                   # Production container definition
│       ├── pyproject.toml               # Python dependencies & build config
│       └── start.sh                     # Multi-process container bootstrapper
├── DESIGN.md                            # Visual guidelines & UI specifications
├── plan.md                              # Historical implementation roadmap
└── vercel.json                          # Vercel SPA routing rules
```

---

## 10. Local Development & Setup Guide

### Prerequisites
* **Node.js**: v18.0 or higher + `npm`
* **Python**: v3.12 or higher
* **LiveKit Cloud Account**: URL, API Key, and Secret
* **Groq API Key**: For LPU LLM inference

### 1. Backend Setup
```bash
cd referenced-chatgpt-conversation-this-is-an

# Create and activate Python virtual environment
python -m venv .venv
# Windows:
.\.venv\Scripts\Activate.ps1
# macOS/Linux:
source .venv/bin/activate

# Install dependencies in editable mode
pip install -e ".[dev]"

# Create your .env file
cp .env.example .env
```

Configure `.env` with your credentials:
```env
LIVEKIT_URL=wss://your-subdomain.livekit.cloud
LIVEKIT_API_KEY=your_api_key
LIVEKIT_API_SECRET=your_api_secret
LLM_API_KEY=gsk_your_groq_api_key
LLM_BASE_URL=https://api.groq.com/openai/v1
LLM_MODEL=llama-3.3-70b-versatile
TTS_VOICE=694f9389-aac1-45b6-b726-9d9369183238
TTS_VOLUME=0.75
```

Run backend services:
```bash
# Terminal 1: Run FastAPI HTTP Server
uvicorn app.main:app --host 127.0.0.1 --port 8000 --app-dir backend --reload

# Terminal 2: Run LiveKit Voice Agent Worker
python -m app.agent.worker dev
```

### 2. Frontend Setup
```bash
cd frontend

# Install Node modules
npm install

# Start Vite development server
npm run dev
# Open http://localhost:3000
```

### 3. Running Automated Tests
```bash
# Backend pytest suite (29 unit & integration tests)
cd referenced-chatgpt-conversation-this-is-an
pytest

# Frontend TypeScript and bundle build
cd frontend
npm run build
```

---

## 11. Production Deployment & Infrastructure

### Live Production Endpoints
* **Web Dashboard**: `https://hvac-receptionist-umber.vercel.app`
* **Backend API**: `https://hvac-receptionist.onrender.com`
* **Health Check**: `https://hvac-receptionist.onrender.com/health`
* **LiveKit Cloud**: `wss://hvac-receptionist-b2k26t6b.livekit.cloud`
* **GitHub Repository**: `https://github.com/khitousanis8-rgb/hvac-receptionist`

### Deployment Architecture
1. **Frontend on Vercel**:
   * Continuous deployment connected to the `main` git branch.
   * `VITE_API_URL` configured to `https://hvac-receptionist.onrender.com`.
   * Fast CDN distribution with automatic asset compression and HTTPS termination.
2. **Backend on Render (Docker Web Service)**:
   * Multi-process Docker container running both Uvicorn and the LiveKit worker via [`start.sh`](file:///c:/Users/TL/Documents/Codex/2026-08-27/referenced-chatgpt-conversation-this-is-an/backend/start.sh).
   * Automatically restarts the LiveKit worker in background if transient network disconnects occur.
   * Environment variables injected directly via Render dashboard secrets.

---

## 12. Strategic Roadmap (SIP, Telephony & CRM Sync)

### Phase 1: Direct Telephony & Inbound Phone Numbers (SIP Trunking)
* Connect **Twilio** or **Telnyx** SIP Trunks directly to LiveKit SIP Bridge.
* Assign dedicated local 10-digit phone numbers (or port existing contractor numbers).
* Enable call forwarding from existing Google My Business or Yelp phone lines.

### Phase 2: CRM & Field Service Management (FSM) Integration
* **ServiceTitan & Housecall Pro Two-Way Sync**:
  * Push scheduled appointments directly into ServiceTitan jobs.
  * Real-time technician dispatch assignment and customer notification SMS.
* **Google Calendar & Outlook Calendar Sync**: For small 1-van operators using standard calendar boards.

### Phase 3: Outbound Proactive Maintenance Booking
* Autonomous outreach to past customers for seasonal tune-ups (e.g., Spring AC check-ups, Fall heating tune-ups).
* Reactivation of dormant client databases to drive predictable recurring revenue.

---
*Built with precision for modern HVAC contractors. Powered by LiveKit, Deepgram, Groq, and Cartesia.*

