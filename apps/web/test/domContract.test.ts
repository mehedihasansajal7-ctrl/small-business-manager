import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Guards the CSS/DOM contract that keeps the app clickable.
 *
 * This exists because of a real bug: the balance-sheet sections used
 * `className="sheet"`, which is the mobile nav drawer's FULL-SCREEN fixed overlay
 * (`position: fixed; inset: 0; z-index: 40`). Opening the Balance sheet therefore
 * painted invisible layers over the whole page and every later click landed on
 * them — the app looked frozen with no error. Programmatic `.click()` still
 * worked, so nothing caught it until a real pointer click was tested.
 */

const SRC = join(__dirname, '..', 'src');

function collectSources(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...collectSources(full));
      continue;
    }
    if (entry.endsWith('.tsx') || entry.endsWith('.ts')) out.push(full);
  }
  return out;
}

/** Class selectors that are full-screen fixed overlays in the stylesheets. */
const OVERLAY_CLASSES = ['sheet'];

describe('no component reuses a full-screen overlay class', () => {
  it('reserves `.sheet` (fixed, inset:0, z-index 40) for the nav drawer in Layout.tsx', () => {
    const offenders: string[] = [];
    for (const file of collectSources(SRC)) {
      const relativePath = relative(SRC, file).replace(/\\/g, '/');
      if (relativePath === 'components/Layout.tsx') continue; // the drawer itself
      const text = readFileSync(file, 'utf8');
      for (const className of OVERLAY_CLASSES) {
        // exact className="sheet" (not "sheet__title" or "sheetsec")
        const pattern = new RegExp(`className=(["'\`])${className}\\1`);
        if (pattern.test(text)) offenders.push(`${relativePath} uses className="${className}"`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('keeps the overlay rule itself intact', () => {
    const css = readFileSync(join(SRC, 'styles', '01-base.css'), 'utf8');
    const rule = /\.sheet\s*\{[^}]*position:\s*fixed;[^}]*inset:\s*0;[^}]*z-index:\s*40;[^}]*\}/s;
    expect(rule.test(css), '.sheet must stay a fixed full-screen overlay (the drawer depends on it)').toBe(true);
  });

  it('gives statement sections their own non-overlay class', () => {
    const css = readFileSync(join(SRC, 'styles', '04-screens.css'), 'utf8');
    expect(/\.sheetsec\s*\{/.test(css), '.sheetsec should exist for report sections').toBe(true);
    // ...and it must not be positioned as an overlay.
    const rule = css.match(/\.sheetsec\s*\{([^}]*)\}/s)?.[1] ?? '';
    expect(rule).not.toContain('position: fixed');
    expect(rule).not.toContain('inset: 0');
  });
});

describe('a screen error can never silently kill the whole app', () => {
  it('wraps the routed screen in an ErrorBoundary', () => {
    const app = readFileSync(join(SRC, 'App.tsx'), 'utf8');
    expect(app).toContain('ErrorBoundary');
    expect(/<ErrorBoundary[\s\S]*?<\/ErrorBoundary>/.test(app)).toBe(true);
  });

  it('has a boundary that shows the message and offers a retry', () => {
    const boundary = readFileSync(join(SRC, 'components', 'ErrorBoundary.tsx'), 'utf8');
    expect(boundary).toContain('getDerivedStateFromError');
    expect(boundary).toContain('componentDidCatch');
    expect(boundary).toContain('Try again');
  });
});

/**
 * A wrongly posted sale used to be uncorrectable in the app: the API supported
 * `POST /api/sales/:id/void` and the `sale.void` permission existed, but the UI
 * had no action at all, so an owner's only option was a manual API call.
 * Posted documents must stay correctable from the screen they were posted on.
 */
describe('posted documents can be corrected from the UI', () => {
  it('exposes the reversal endpoints in the web API layer', () => {
    const api = readFileSync(join(SRC, 'api', 'endpointsFinance.ts'), 'utf8');
    expect(api).toMatch(/voidSale:\s*\(/);
    expect(api).toMatch(/voidPurchase:\s*\(/);
    expect(api).toContain('/void');
  });

  it('offers a Void action on the sales list, gated by the sale.void permission', () => {
    const sales = readFileSync(join(SRC, 'screens', 'Sales.tsx'), 'utf8');
    expect(sales).toContain("hasPermission(permissions, 'sale.void')");
    expect(sales).toContain('sales.voidTitle');
    // A reason is mandatory, and the audit log records it.
    expect(sales).toContain('TextAreaInput');
    expect(sales).toMatch(/voidReason\.trim\(\)\.length < 5/);
  });
});
