/**
 * ControlsPanel — a collapsible "⚙ Style" panel (Feature #4) that lets the
 * viewer make the drawing theirs: named presets, ink colour, stroke boldness,
 * draw time, splash intensity, and backend detail level. Settings live in App
 * (persisted to localStorage) and are applied on the next draw; ink colour also
 * recolours a finished piece live.
 */
import React, { useState } from 'react';

const PRESETS = {
  'Fine liner': { inkColor: '#141428', weight: 0.7, seconds: 26, splash: 0.55, detail: 'std',   mode: 'trace' },
  'Bold ink':   { inkColor: '#0d0d14', weight: 1.5, seconds: 30, splash: 1.0,  detail: 'std',   mode: 'trace' },
  'Sketch':     { inkColor: '#3a2f2a', weight: 1.0, seconds: 34, splash: 1.3,  detail: 'dense', mode: 'scribble' },
};
const SWATCHES = ['#141428', '#0d0d14', '#3a2f2a', '#1e3a5f', '#5a1f2e'];
const DETAILS = [['fine', 'Fine'], ['std', 'Standard'], ['dense', 'Dense']];
const MODES = [['trace', 'Portrait'], ['scribble', 'One-line']];
const INSTRUMENTS = [['duet', 'Duet'], ['violin', 'Violin'], ['piano', 'Piano']];

const ui = {
  wrap: { position: 'absolute', left: 16, bottom: 16, zIndex: 11, fontFamily: 'Georgia, serif' },
  toggle: {
    padding: '9px 16px', fontSize: 15, border: '2px solid #1a1a2e', borderRadius: 999,
    background: '#fff', color: '#1a1a2e', cursor: 'pointer',
  },
  panel: {
    position: 'absolute', left: 0, bottom: 52, width: 264, background: '#fff',
    border: '2px solid #1a1a2e', borderRadius: 16, padding: 16,
    boxShadow: '0 10px 34px rgba(0,0,0,0.16)', display: 'flex', flexDirection: 'column', gap: 13,
  },
  row: { display: 'flex', flexDirection: 'column', gap: 6 },
  label: { fontSize: 11, color: '#5a5a6e', textTransform: 'uppercase', letterSpacing: 0.6 },
  presets: { display: 'flex', gap: 6 },
  preset: {
    flex: 1, padding: '7px 0', fontSize: 12.5, border: '1.5px solid #1a1a2e',
    borderRadius: 999, background: '#fff', color: '#1a1a2e', cursor: 'pointer',
  },
  swatches: { display: 'flex', gap: 9 },
  seg: { display: 'flex', gap: 4 },
  segBtn: (on) => ({
    flex: 1, padding: '6px 0', fontSize: 12, border: '1.5px solid #1a1a2e', borderRadius: 8,
    background: on ? '#1a1a2e' : '#fff', color: on ? '#fff' : '#1a1a2e', cursor: 'pointer',
  }),
  range: { width: '100%', accentColor: '#1a1a2e', cursor: 'pointer' },
};

export default function ControlsPanel({ settings, onChange }) {
  const [open, setOpen] = useState(false);
  const swatch = (c) => ({
    width: 26, height: 26, borderRadius: 999, background: c, cursor: 'pointer',
    border: settings.inkColor === c ? '3px solid #1a1a2e' : '2px solid #cfc7ba',
  });

  return (
    <div style={ui.wrap}>
      {open && (
        <div style={ui.panel}>
          <div style={ui.presets}>
            {Object.keys(PRESETS).map((name) => (
              <button key={name} style={ui.preset} onClick={() => onChange(PRESETS[name])}>
                {name}
              </button>
            ))}
          </div>

          <div style={ui.row}>
            <span style={ui.label}>Ink</span>
            <div style={ui.swatches}>
              {SWATCHES.map((c) => (
                <div key={c} style={swatch(c)} title={c} onClick={() => onChange({ inkColor: c })} />
              ))}
            </div>
          </div>

          <div style={ui.row}>
            <span style={ui.label}>Boldness · {settings.weight.toFixed(1)}×</span>
            <input style={ui.range} type="range" min="0.5" max="2" step="0.1"
              value={settings.weight}
              onChange={(e) => onChange({ weight: parseFloat(e.target.value) })} />
          </div>

          <div style={ui.row}>
            <span style={ui.label}>Draw time · {settings.seconds}s</span>
            <input style={ui.range} type="range" min="18" max="45" step="1"
              value={settings.seconds}
              onChange={(e) => onChange({ seconds: parseInt(e.target.value, 10) })} />
          </div>

          <div style={ui.row}>
            <span style={ui.label}>Splash · {Math.round(settings.splash * 100)}%</span>
            <input style={ui.range} type="range" min="0" max="1.5" step="0.05"
              value={settings.splash}
              onChange={(e) => onChange({ splash: parseFloat(e.target.value) })} />
          </div>

          <div style={ui.row}>
            <span style={ui.label}>Mode</span>
            <div style={ui.seg}>
              {MODES.map(([v, lbl]) => (
                <button key={v} style={ui.segBtn((settings.mode ?? 'trace') === v)}
                  title={v === 'trace'
                    ? 'Faithful strokes — the hand lifts the pen between lines'
                    : 'Abstract single unbroken line (the original look)'}
                  onClick={() => onChange({ mode: v })}>
                  {lbl}
                </button>
              ))}
            </div>
          </div>

          <div style={ui.row}>
            <span style={ui.label}>Detail</span>
            <div style={ui.seg}>
              {DETAILS.map(([v, lbl]) => (
                <button key={v} style={ui.segBtn(settings.detail === v)}
                  onClick={() => onChange({ detail: v })}>
                  {lbl}
                </button>
              ))}
            </div>
          </div>

          <div style={ui.row}>
            <span style={ui.label}>Instrument · with 🔊 on</span>
            <div style={ui.seg}>
              {INSTRUMENTS.map(([v, lbl]) => (
                <button key={v} style={ui.segBtn((settings.instrument ?? 'duet') === v)}
                  title={v === 'duet'
                    ? 'Long strokes bowed on violin, short flicks struck on piano'
                    : v === 'violin' ? 'All strokes bowed' : 'All strokes struck'}
                  onClick={() => onChange({ instrument: v })}>
                  {lbl}
                </button>
              ))}
            </div>
          </div>
        </div>
      )}
      <button style={ui.toggle} onClick={() => setOpen((o) => !o)}>⚙ Style</button>
    </div>
  );
}
