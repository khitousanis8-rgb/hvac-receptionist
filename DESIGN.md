---
version: 1.0.0
name: HVAC-Receptionist-Design-System
description: A precision enterprise voice-AI and dispatch interface anchored on a pure white canvas with deep ink typography, hairline borders, and a dedicated mobile-first phone experience for on-the-go HVAC dispatchers and technicians. Combines calendar SaaS clarity (Cal.com), voice telemetry elegance (ElevenLabs), stark developer-platform precision (Vercel), and tactile mobile ergonomics.

colors:
  canvas: "#ffffff"
  canvas-subtle: "#fafafa"
  canvas-muted: "#f4f4f5"
  surface-card: "#ffffff"
  surface-elevated: "#ffffff"
  surface-hover: "#fafafa"
  surface-active: "#f4f4f5"
  
  # Typography ink
  ink: "#0a0a0a"
  ink-secondary: "#4e505b"
  ink-muted: "#71717a"
  ink-subtle: "#a1a1aa"
  
  # Structural borders
  hairline: "#e7e7e7"
  hairline-subtle: "#f0f0f0"
  hairline-strong: "#d4d4d8"
  
  # Brand & Semantic Accents
  primary: "#0b5ed7"
  primary-hover: "#0a53be"
  primary-active: "#0948a3"
  primary-soft: "#eff6ff"
  primary-border: "#bfdbfe"
  
  # Status colors
  success: "#059669"
  success-soft: "#ecfdf5"
  success-border: "#a7f3d0"
  
  warning: "#d97706"
  warning-soft: "#fffbeb"
  warning-border: "#fde68a"
  
  danger: "#dc2626"
  danger-soft: "#fff1f2"
  danger-border: "#fecdd3"

typography:
  fontFamily:
    display: "'Aeonik Trial', 'Aeonik', -apple-system, BlinkMacSystemFont, sans-serif"
    body: "'Aeonik Trial', 'Aeonik', -apple-system, BlinkMacSystemFont, sans-serif"
    mono: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace"

  scale:
    display-xl:
      fontSize: 28px
      fontWeight: 600
      letterSpacing: -0.03em
      lineHeight: 1.2
    title-lg:
      fontSize: 20px
      fontWeight: 600
      letterSpacing: -0.025em
      lineHeight: 1.25
    title-md:
      fontSize: 16px
      fontWeight: 600
      letterSpacing: -0.02em
      lineHeight: 1.3
    title-sm:
      fontSize: 14px
      fontWeight: 600
      letterSpacing: -0.015em
      lineHeight: 1.35
    body-md:
      fontSize: 13px
      fontWeight: 400
      letterSpacing: -0.01em
      lineHeight: 1.45
    body-sm:
      fontSize: 12px
      fontWeight: 400
      letterSpacing: -0.005em
      lineHeight: 1.4
    caption:
      fontSize: 11px
      fontWeight: 500
      letterSpacing: 0.02em
      lineHeight: 1.3
    code:
      fontSize: 11px
      fontWeight: 500
      letterSpacing: 0
      lineHeight: 1.4

spacing:
  xs: 4px
  sm: 8px
  md: 12px
  lg: 16px
  xl: 24px
  xxl: 32px

radii:
  sm: 6px
  md: 8px
  lg: 12px
  xl: 16px
  pill: 9999px

elevation:
  card: "0 1px 2px 0 rgba(0, 0, 0, 0.03)"
  card-hover: "0 4px 12px 0 rgba(0, 0, 0, 0.05)"
  dock: "0 -4px 20px 0 rgba(0, 0, 0, 0.04)"
  modal: "0 20px 40px -15px rgba(0, 0, 0, 0.12)"

mobile-first-guidelines:
  touch-targets:
    minimum: 44px
    preferred: 48px to 64px for primary call controls
  dock:
    position: "fixed bottom-0 inset-x-0"
    backdrop: "backdrop-blur-md bg-white/95"
    safe-area: "padding-bottom includes env(safe-area-inset-bottom)"
  ergonomics:
    one-thumb-zone: "Place all primary navigation and in-call actions (Mute, Hangup) in the bottom third of the viewport."
    top-bar: "Keep header reserved for status glance (API online dot, emergency tap-to-call icon)."
    appointment-view: "Horizontal swipeable date strip + vertical agenda stream with direct tel: buttons."
---

# HVAC Receptionist Design Language

## 1. Visual Atmosphere & Philosophy
The interface embodies **precision, reliability, and calm utility**. Because dispatchers and technicians often handle stressful emergencies (such as furnace failure in sub-zero winter or AC failure in sweltering heat), the interface strips away unnecessary visual clutter. It delivers high-contrast readability on true white, micro-hairlines that create razor-sharp division, and tactile buttons with instant visual feedback.

## 2. Dedicated Phone Architecture
Unlike generic responsive layouts that merely collapse a desktop sidebar into a hidden hamburger menu, this application provides a dedicated smartphone experience:

### A. Bottom Navigation Dock (`MobileBottomNav`)
- Fixed at the bottom with safe area insets.
- Provides immediate 1-tap switching between **Dashboard**, **Calls**, **Live Call (Center Pill)**, **Schedule**, and **Settings**.
- Center action pill is highlighted with subtle radar animation to emphasize real-time voice capability.

### B. Mobile Call Screen
- Full-screen smartphone phone dialer aesthetic.
- Large elapsed time counter (`00:32`).
- Animated multi-ring audio radar that expands and pulses when the remote receptionist speaks or listens.
- 64×64px circular buttons for Mute and End Call, positioned in the natural thumb reach zone.
- One-tap suggested scenario pills for quick test calls.

### C. Mobile Schedule & Agenda (`MobileAgendaView`)
- 7-day horizontal date selector with day numbers and appointment indicator dots.
- Tactile agenda cards with service badges, scheduled time, customer name, and direct 1-tap `tel:` phone links.

## 3. Desktop Experience
- Collapsible sidebar with quick collapse/expand.
- High-density telemetry cards with booking rate calculations.
- Comprehensive month calendar grid with appointment popovers.
- Inbound call audit log with expandable transcript summaries and duration breakdowns.
