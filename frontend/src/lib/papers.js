/**
 * papers.js — curated PAPER STOCKS, each a complete colour system.
 *
 * Art rationale (why presets, not a free colour picker): what makes a line
 * drawing read is VALUE CONTRAST between ink and ground, and what makes it
 * beautiful is a harmonized, limited palette. A free picker invites
 * mid-value paper + mid-value ink = mud. So each paper ships with:
 *
 *   · bg          — the ground itself. Never pure black/white: real papers
 *                   are warm. Noir is a warm off-black (charcoal paper),
 *                   not #000 — pure black reads as a dead screen, and ink
 *                   pooling/shadow nuance vanishes against it.
 *   · inks        — 5 swatches picked FOR that ground (all ≥ strong value
 *                   contrast), first = defaultInk. Light grounds get the
 *                   classic drawing inks (india, sepia, prussian, oxblood);
 *                   dark grounds get body-colour — chalk, gouache golds and
 *                   corals — the way chalk lifts off black paper or white
 *                   line work sits on a cyanotype.
 *   · splashes    — watercolor pigment pairs [light, dark] tuned to the
 *                   ground: pastels on ivory; deep JEWEL tones on noir
 *                   (bright pastels on black look chalk-dusty and fight the
 *                   ink); gouache earth tones on kraft; a tonal Prussian
 *                   wash on slate (a cyanotype stays monochrome — that
 *                   restraint IS the look).
 *   · watermark   — export caption colour with the same quiet ~45% presence
 *                   on every ground.
 *   · text / sub / overlay — UI chrome tints so the idle screen reads like
 *                   the same paper, not a white app floating on it.
 *
 * Traditions each stock nods to: Ivory = pen-and-ink on hot-press;
 * Noir = white chalk / scratchboard on black; Kraft = gouache + carbon on
 * packing paper (the classic sketchbook combo); Slate = cyanotype blueprint.
 */

export const PAPERS = {
  ivory: {
    label: 'Ivory',
    bg: '#f6f1e7',
    overlay: 'rgba(246, 241, 231, 0.9)',
    text: '#1a1a2e',
    sub: '#5a5a6e',
    inks: ['#141428', '#0d0d14', '#3a2f2a', '#1e3a5f', '#5a1f2e'],
    watermark: 'rgba(30, 58, 95, 0.45)',
    splashes: [
      ['#f4a9b8', '#e05c6e'], // rose
      ['#9bd0e8', '#3a7ca5'], // cerulean
      ['#f7d08a', '#e88f34'], // ochre
      ['#b8e0c8', '#3d8b64'], // viridian
      ['#cdb4e8', '#7d5ba6'], // violet
    ],
  },
  noir: {
    label: 'Noir',
    bg: '#131316', // warm charcoal-black, not #000
    overlay: 'rgba(19, 19, 22, 0.9)',
    text: '#ece5d8',
    sub: '#a49d93',
    inks: ['#f2ede3', '#e8b84b', '#e0574a', '#8fd0d4', '#d98fb0'],
    // chalk white · gold · vermilion · celadon · rose — body-colour on black
    watermark: 'rgba(242, 237, 227, 0.42)',
    splashes: [
      ['#8c2f41', '#43121d'], // garnet
      ['#2a6172', '#0e2f3a'], // deep teal
      ['#8a6526', '#3f2d0d'], // antique gold
      ['#4d3675', '#221540'], // amethyst
      ['#2a5c40', '#0e2c1c'], // emerald
    ],
  },
  kraft: {
    label: 'Kraft',
    bg: '#c8a97e',
    overlay: 'rgba(200, 169, 126, 0.9)',
    text: '#2a2118',
    sub: '#5c4d3a',
    inks: ['#2a2118', '#f5efe2', '#8c3b2e', '#26324e', '#2f4a3a'],
    // carbon · white gouache · red oxide · indigo · hooker green
    watermark: 'rgba(42, 33, 24, 0.45)',
    splashes: [
      ['#e8d5b0', '#b9915e'], // cream gouache
      ['#c26a50', '#7c3527'], // terracotta
      ['#7d9a86', '#42604d'], // sage
      ['#7488ab', '#3d4f6e'], // slate blue
      ['#d3ab52', '#8a6b23'], // yellow ochre
    ],
  },
  slate: {
    label: 'Slate',
    bg: '#1e3d5c', // Prussian — cyanotype ground
    overlay: 'rgba(30, 61, 92, 0.9)',
    text: '#e9f1f5',
    sub: '#a7bfd1',
    inks: ['#f4f7f6', '#bcd9e8', '#e8d5a3', '#f0b8a8', '#9fd8c0'],
    // blueprint white · pale cyan · chamois · coral chalk · mint
    watermark: 'rgba(233, 241, 245, 0.4)',
    splashes: [
      ['#4a7aa4', '#2b5170'], // wash 1 — tonal Prussian, lighter
      ['#6790b3', '#3a648a'], // wash 2
      ['#35618a', '#1f3f5e'], // wash 3 — deeper pool
      ['#5c86ab', '#31567a'], // wash 4
      ['#7fa3c2', '#4a7398'], // wash 5 — palest veil
    ],
  },
};

export const DEFAULT_PAPER = 'ivory';

export function getPaper(key) {
  return PAPERS[key] || PAPERS[DEFAULT_PAPER];
}

/** The paper's house ink — used when switching to a paper on which the
 *  current ink would sink into the ground. */
export function defaultInk(key) {
  return getPaper(key).inks[0];
}
