# Bosanda — Design System Reference

**Source:** Vision UI Dashboard PRO (React) — <https://demos.creative-tim.com/vision-ui-dashboard-pro-react/#/dashboards/default>
**Purpose:** Visual reference for the three Bosanda surfaces defined in [PLAN.md](./PLAN.md):

- `bosanda.dev` — storefront + user dashboard
- `admin.bosanda.dev` — admin dashboard
- `api.bosanda.dev` — API gateway (no UI; JSON only)

This is the "glass-on-dark-navy" aesthetic: frosted translucent cards floating over a deep
navy gradient, white type, and vivid multi-stop gradient accents for primary actions and
data highlights.

> **Provenance.** Every value in §1–§4 marked **[extracted]** was read directly from the
> live demo via `getComputedStyle`. Values marked **[inferred]** are reasonable additions
> for states the demo did not expose on the dashboard route (e.g. warning color, input
> borders) and must be confirmed against the real kit before locking. Nothing here is a
> pixel-measured guess.

---

## 1. Foundations

### 1.1 Typography

| Token              | Value                                                    | Source      |
| ------------------ | -------------------------------------------------------- | ----------- |
| Primary family     | `"Plus Jakarta Display", Helvetica, Arial, sans-serif`   | [extracted] |
| Icon family        | `"Material Icons Round"`                                 | [extracted] |
| Heading color      | `#FFFFFF`                                                | [extracted] |
| Heading weight     | `500` (section titles), `700` (labels/captions)          | [extracted] |
| Section title size | `20px` (h5-equivalent)                                   | [extracted] |
| Caption / eyebrow  | `12px`, weight `700`, `text-transform: uppercase`, white | [extracted] |
| Nav item label     | `10px`, weight `700`                                     | [extracted] |

Plus Jakarta Display is a paid/licensed font in the original kit. For Bosanda, substitute
**Plus Jakarta Sans** (open source, Google Fonts) — near-identical letterforms. Wire it up
in `apps/web` and `apps/admin` via `next/font/google`.

### 1.2 Color palette

**Backdrop (darkest → base surfaces)**

| Token                  | Hex / value                                                | Source      |
| ---------------------- | ---------------------------------------------------------- | ----------- |
| `--bg-app`             | `#030C1D` (`rgb(3,12,29)`) + `body-background.png` overlay | [extracted] |
| `--surface-grad-start` | `rgba(6,11,40,0.94)` (`#060B28`)                           | [extracted] |
| `--surface-grad-end`   | `rgba(10,14,35,0.49)` (`#0A0E23`)                          | [extracted] |

**Text**

| Token              | Hex                                                   | Source      |
| ------------------ | ----------------------------------------------------- | ----------- |
| `--text-primary`   | `#FFFFFF`                                             | [extracted] |
| `--text-secondary` | `#A0AEC0` (`rgb(160,174,192)`)                        | [extracted] |
| `--text-muted`     | `#718096` (`rgb(113,128,150)`)                        | [extracted] |
| `--text-slate`     | `#344767` (`rgb(52,71,103)`) — on light surfaces only | [extracted] |

**Status**

| Token       | Hex                                                                | Source                                |
| ----------- | ------------------------------------------------------------------ | ------------------------------------- |
| `--success` | `#01B574` (`rgb(1,181,116)`) — positive deltas, "paid", "active"   | [extracted]                           |
| `--danger`  | `#E31A1A` (`rgb(227,26,26)`) — negative deltas, "expired", "error" | [extracted]                           |
| `--warning` | `#FFB547`                                                          | [inferred — confirm]                  |
| `--info`    | `#0075FF`                                                          | [extracted, from info gradient start] |

**Accent gradients** (the signature element — used on primary buttons, active states, chart fills)

| Token               | Value                                                                               | Source      |
| ------------------- | ----------------------------------------------------------------------------------- | ----------- |
| `--grad-primary`    | `linear-gradient(310deg, #4318FF, #9F7AEA)` (indigo → violet)                       | [extracted] |
| `--grad-info`       | `linear-gradient(310deg, #0075FF, #21D4FD)` (blue → cyan)                           | [extracted] |
| `--grad-surface`    | `linear-gradient(127.09deg, rgba(6,11,40,0.94) 19.41%, rgba(10,14,35,0.49) 76.65%)` | [extracted] |
| `--grad-nav-active` | `linear-gradient(126.97deg, rgba(6,11,40,0.74) 28.26%, rgba(10,14,35,0.71) 91.2%)`  | [extracted] |
| `--grad-text`       | `linear-gradient(97.89deg, #FFFFFF 70.67%, rgba(117,122,140,0) 108.55%)`            | [extracted] |
| `--divider`         | `linear-gradient(to right, rgba(0,117,255,0), #FFFFFF, rgba(255,255,255,0))`        | [extracted] |

### 1.3 Elevation, radius, blur

| Token                 | Value                                                              | Source      |
| --------------------- | ------------------------------------------------------------------ | ----------- |
| `--radius-card`       | `20px`                                                             | [extracted] |
| `--radius-control`    | `12px` (nav items, small pills)                                    | [extracted] |
| `--blur-card`         | `blur(120px)` (`backdrop-filter`)                                  | [extracted] |
| `--shadow-card`       | `0 20px 27px 0 rgba(0,0,0,0.05)`                                   | [extracted] |
| `--shadow-nav-active` | `0 4px 7px -1px rgba(0,0,0,0.11), 0 2px 4px -1px rgba(0,0,0,0.07)` | [extracted] |

### 1.4 CSS variable block (drop into `globals.css`)

```css
:root {
  --bg-app: #030c1d;
  --surface-grad: linear-gradient(
    127.09deg,
    rgba(6, 11, 40, 0.94) 19.41%,
    rgba(10, 14, 35, 0.49) 76.65%
  );
  --nav-active-grad: linear-gradient(
    126.97deg,
    rgba(6, 11, 40, 0.74) 28.26%,
    rgba(10, 14, 35, 0.71) 91.2%
  );
  --grad-primary: linear-gradient(310deg, #4318ff, #9f7aea);
  --grad-info: linear-gradient(310deg, #0075ff, #21d4fd);
  --divider: linear-gradient(to right, rgba(0, 117, 255, 0), #fff, rgba(255, 255, 255, 0));

  --text-primary: #ffffff;
  --text-secondary: #a0aec0;
  --text-muted: #718096;

  --success: #01b574;
  --danger: #e31a1a;
  --warning: #ffb547;
  --info: #0075ff;

  --radius-card: 20px;
  --radius-control: 12px;
  --blur-card: 120px;
  --shadow-card: 0 20px 27px 0 rgba(0, 0, 0, 0.05);
  --shadow-nav-active: 0 4px 7px -1px rgba(0, 0, 0, 0.11), 0 2px 4px -1px rgba(0, 0, 0, 0.07);
}

body {
  background-color: var(--bg-app);
  background-image: url("/images/body-background.png"); /* re-create or replace */
  color: var(--text-primary);
  font-family: "Plus Jakarta Sans", Helvetica, Arial, sans-serif;
}
```

---

## 2. Core components

### 2.1 Glass card (the base surface)

The atomic building block. Everything sits inside one.

```css
.card {
  background: var(--surface-grad);
  backdrop-filter: blur(var(--blur-card));
  border-radius: var(--radius-card);
  box-shadow: var(--shadow-card);
  padding: 22px;
}
```

- **Bg color** is transparent; the gradient does the work. **[extracted]**
- No border in the default demo card. **[extracted]**

### 2.2 Stat / KPI tile

Seen across the top of the dashboard ("Today's Money", etc.). Layout:
`eyebrow label (12px/700/uppercase, muted)` → `big value (white)` → `delta`
(`+55%` in `--success` or `-2%` in `--danger`), with a gradient icon chip on the right.

- Icon chip: 45px rounded square filled with `--grad-info` or `--grad-primary`.
- Delta color is the only place status colors appear in tiles.

### 2.3 Buttons

| Variant | Fill                             | Use                               |
| ------- | -------------------------------- | --------------------------------- |
| Primary | `--grad-primary`                 | main CTA (Buy, Pay, Create key)   |
| Info    | `--grad-info`                    | secondary emphasis (Top up, View) |
| Ghost   | transparent, `1px solid #FFFFFF` | icon buttons, tertiary            | **[extracted from icon btn]** |

Rounded `--radius-control`; white text; no shadow at rest.

### 2.4 Sidebar

| Property    | Value                                                                         | Source      |
| ----------- | ----------------------------------------------------------------------------- | ----------- |
| Width       | `250px`                                                                       | [extracted] |
| Background  | `--surface-grad`                                                              | [extracted] |
| Radius      | `20px` (floats inset from viewport edge)                                      | [extracted] |
| Item label  | `10px` / weight `700`                                                         | [extracted] |
| Active item | `--grad-nav-active`, radius `12px`, padding `8px 32px`, `--shadow-nav-active` | [extracted] |

Active item also gets a filled gradient icon chip; inactive items show an outline icon +
muted label.

### 2.5 Inputs

The dashboard route didn't expose a text input, so lock these against the kit's auth pages:

- Field: dark translucent fill, `1px` subtle border, radius `--radius-control`, white text,
  `--text-muted` placeholder. **[inferred — confirm]**
- Focus: border brightens toward `--info`. **[inferred — confirm]**

### 2.6 Divider

Horizontal rule using `--divider` (center-bright, fades at both ends). Used between card
sections and sidebar groups.

---

## 3. Charts & data viz

The demo leans on gradient-filled line/bar charts. For Bosanda dashboards:

- Line/area fills: fade from `--grad-info` (or `--grad-primary`) down to transparent.
- Grid lines: very low-opacity white.
- Positive series → `--success`, negative → `--danger`, neutral → `--info`.
- See the `dataviz` skill before building any chart; keep the palette consistent light/dark.

---

## 4. Mapping to Bosanda surfaces

### 4.1 `bosanda.dev` — storefront + user dashboard

| Screen (from PLAN.md §4, §15) | Components                                                                                                             |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Registration / login          | Centered glass card, gradient primary submit, muted helper text                                                        |
| Package selection (10M–100M)  | Row of glass cards, one per size; price in white, "weighted tokens" note in `--text-secondary`; gradient primary "Buy" |
| New key vs. top-up choice     | Segmented control (two nav-active-style pills) inside a glass card                                                     |
| Payment status                | Status chip (`--success` paid / `--warning` pending / `--danger` expired)                                              |
| Dashboard: quota & expiry     | KPI tiles — remaining weighted tokens, expiry countdown, active keys count                                             |
| Usage                         | Gradient area chart of weighted-token burn over the 24h window                                                         |
| API keys                      | Table inside glass card; key masked by default; eye-toggle reveal; gradient "Rotate"/danger "Revoke"                   |

### 4.2 `admin.bosanda.dev` — admin dashboard

Same design language, denser. Tables and controls per PLAN.md §15.

| Panel                           | Notes                                                                                    |
| ------------------------------- | ---------------------------------------------------------------------------------------- |
| Packages / stock (per 10M size) | Editable glass cards; stock counters as KPI tiles                                        |
| Orders / Pakasir reconciliation | Table + status chips; reconcile action = info gradient                                   |
| Users & keys                    | Search bar (input spec §2.5), user table, danger "Disable"/"Revoke"                      |
| Kiro provider pool              | Per-account cards: active-request count, cooldown, region, circuit state as status chips |
| Models & adapter                | Publish toggles; compatibility-suite results as pass/fail chips (`--success`/`--danger`) |
| Kill switches                   | Prominent danger-outlined toggles (global / region / model / account / tool-use)         |

### 4.3 Kill-switch & health visual language

PLAN.md §3 requires fast-readable operational state. Standardize:

- **Healthy / enabled / paid** → `--success`
- **Cooldown / pending / degraded** → `--warning`
- **Disabled / open circuit / expired / error** → `--danger`
- **Neutral / info action** → `--info`

Apply the same chip everywhere (gateway health, provider pool, order state, package stock)
so an operator reads status by color instantly.

---

## 5. Assets to reproduce

| Asset         | Original                                 | Bosanda action                                                                       |
| ------------- | ---------------------------------------- | ------------------------------------------------------------------------------------ |
| Body backdrop | `body-background.png` (dark navy nebula) | Re-create or replace with an owned/licensed image; do **not** hotlink the demo asset |
| Font          | Plus Jakarta Display (licensed)          | Use Plus Jakarta Sans (OSS)                                                          |
| Icons         | Material Icons Round                     | Free; ship via `next/font` or an icon package                                        |

---

## 6. Licensing note

Vision UI Dashboard PRO is a **paid, licensed** Creative Tim product. This document records
only design _tokens and patterns_ (colors, spacing, type scale) observed from the public
demo for building Bosanda's own components — it is **not** a copy of Creative Tim's source.
Do not copy their React/CSS source, redistribute their assets, or ship their proprietary
font. If the team wants to use their actual component code, purchase the appropriate license
first. This mirrors the reference-use caution already established for `kelola-router` in
PLAN.md §2.
