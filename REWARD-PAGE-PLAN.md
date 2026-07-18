# Offer 4 — Reward Page Plan

## Context
- Project: Vhagar POS (Next.js 14 App Router, Tailwind CSS)
- Brand colors: brand=#22322A (Nomad Green), accent=#5E1A20 (Wild Garnet)
- Layout: mobile-first, wrapped in max-w-md
- Home page tile links: /sell, /find, /rack, /stock, /sales, /admin
- Draft exists at root page.tsx using eact-custom-roulette — needs to become pp/reward/page.tsx
- Discount integration is manual (no backend changes), staff enters discount on /sell

## Steps

1. **Install dependency**
   - Run 
pm install react-custom-roulette
   - (Types are bundled; no @types/ package needed)

2. **Create pp/reward/page.tsx**
   - Client component ('use client')
   - Use eact-custom-roulette Wheel component
   - 8 segments: 10% OFF, 15% OFF, 20% OFF, 25% OFF, TRY AGAIN, 30% OFF, 35% OFF, 40% OFF
   - Central "SPIN" button that disables after one spin per session
   - Result modal: win message with discount + instruction to show screen to staff; "TRY AGAIN" gets separate message
   - Sound effect on spin using Web Audio API (consistent with sell/page.tsx eedback() pattern)
   - Use project brand colors / Tailwind utilities; keep it mobile-friendly inside max-w-md

3. **Link from Home (pp/page.tsx)**
   - Add a new tile in TILES array: href: "/reward", label "Spin to Win", emoji "🎰", sub "Try your luck for a discount"
   - Style it similar to existing tiles (use accent or brand treatment to make it stand out as a promo)

4. **Cleanup root draft**
   - Remove root-level page.tsx (it is not part of Next.js App Router routing and would conflict or be ignored)

## Validation
- 
pm run dev → navigate to /reward
- Spin wheel → lands on prize, button disables, modal shows correct message
- Navigate back to / → new tile is visible and links correctly
- Page reload resets spin state (acceptable per spec)
- No 
pm run build errors
