/**
 * GalleryWall — full-screen overlay showing the local collection of finished
 * drawings (Feature 2.1). Grid of thumbnails on the paper colour; click one
 * for a large view with "Save image" (re-export of the stored thumbnail) and
 * delete; a clear-all lives in the header. Everything is local (see
 * useGallery.js) — nothing leaves the device.
 */
import React, { useState } from 'react';

const ui = {
  overlay: {
    position: 'absolute', inset: 0, zIndex: 20, background: 'rgba(246, 241, 231, 0.97)',
    display: 'flex', flexDirection: 'column', fontFamily: 'Georgia, serif',
  },
  header: {
    display: 'flex', alignItems: 'center', gap: 12,
    padding: '18px 22px 10px',
  },
  title: { fontSize: 26, margin: 0, color: '#1a1a2e', flex: 1 },
  btn: {
    padding: '8px 16px', fontSize: 14, fontFamily: 'Georgia, serif',
    border: '2px solid #1a1a2e', borderRadius: 999, background: '#fff',
    color: '#1a1a2e', cursor: 'pointer',
  },
  grid: {
    flex: 1, overflowY: 'auto', padding: '10px 22px 26px',
    display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))',
    gap: 14, alignContent: 'start',
  },
  card: {
    position: 'relative', border: '2px solid #1a1a2e', borderRadius: 12,
    overflow: 'hidden', cursor: 'pointer', background: '#fff', padding: 0,
    lineHeight: 0, boxShadow: '0 4px 14px rgba(0,0,0,0.08)',
  },
  cardImg: { width: '100%', display: 'block' },
  cardMeta: {
    position: 'absolute', left: 0, right: 0, bottom: 0, lineHeight: 1.3,
    background: 'rgba(26,26,46,0.72)', color: '#fff', fontSize: 11,
    padding: '4px 8px', textAlign: 'left',
  },
  empty: { color: '#5a5a6e', fontSize: 16, padding: '30px 22px' },
  // large view
  big: {
    position: 'absolute', inset: 0, zIndex: 21, background: 'rgba(20,20,30,0.82)',
    display: 'flex', flexDirection: 'column', alignItems: 'center',
    justifyContent: 'center', gap: 16, padding: 24,
  },
  bigImg: {
    maxWidth: '86vw', maxHeight: '70vh', borderRadius: 10,
    border: '3px solid #f6f1e7', background: '#f6f1e7',
  },
  bigMeta: { color: '#f6f1e7', fontSize: 14, textAlign: 'center', lineHeight: 1.5 },
};

const MODE_LABEL = { trace: 'Portrait', scribble: 'One-line' };

function fmtDate(ts) {
  try {
    return new Date(ts).toLocaleDateString(undefined, {
      month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
    });
  } catch {
    return '';
  }
}

function metaLine(e) {
  const m = e.meta || {};
  const bits = [MODE_LABEL[m.mode] ?? m.mode, m.detail, `${m.seconds}s`];
  if (m.strokes) bits.push(`${m.strokes} strokes`);
  if (m.instrument) bits.push(m.instrument);
  return bits.filter(Boolean).join(' · ');
}

function saveThumb(e) {
  const a = document.createElement('a');
  a.href = e.thumb;
  a.download = `hypnotic-hand-${new Date(e.date).toISOString().slice(0, 10)}.jpg`;
  document.body.appendChild(a);
  a.click();
  a.remove();
}

export default function GalleryWall({ entries, onRemove, onClear, onClose }) {
  const [selected, setSelected] = useState(null); // entry | null
  const sel = selected && entries.find((e) => e.id === selected.id) ? selected : null;

  return (
    <div style={ui.overlay} role="dialog" aria-label="Gallery">
      <div style={ui.header}>
        <h2 style={ui.title}>Gallery</h2>
        {entries.length > 0 && (
          <button
            style={ui.btn}
            onClick={() => { if (window.confirm('Clear the whole gallery?')) onClear(); }}
          >
            Clear all
          </button>
        )}
        <button style={ui.btn} onClick={onClose} aria-label="Close gallery">✕ Close</button>
      </div>

      {entries.length === 0 ? (
        <p style={ui.empty}>
          Nothing here yet — finished drawings collect on this wall automatically.
        </p>
      ) : (
        <div style={ui.grid}>
          {entries.map((e) => (
            <button
              key={e.id}
              style={ui.card}
              onClick={() => setSelected(e)}
              title={`${fmtDate(e.date)} — ${metaLine(e)}`}
            >
              <img src={e.thumb} alt={`Drawing from ${fmtDate(e.date)}`} style={ui.cardImg} />
              <span style={ui.cardMeta}>{fmtDate(e.date)}</span>
            </button>
          ))}
        </div>
      )}

      {sel && (
        <div style={ui.big} onClick={() => setSelected(null)}>
          <img
            src={sel.thumb}
            alt="Selected drawing"
            style={ui.bigImg}
            onClick={(ev) => ev.stopPropagation()}
          />
          <div style={ui.bigMeta}>
            {fmtDate(sel.date)}<br />{metaLine(sel)}
          </div>
          <div style={{ display: 'flex', gap: 10 }} onClick={(ev) => ev.stopPropagation()}>
            <button style={ui.btn} onClick={() => saveThumb(sel)}>Save image ↓</button>
            <button
              style={ui.btn}
              onClick={() => { onRemove(sel.id); setSelected(null); }}
            >
              Delete
            </button>
            <button style={ui.btn} onClick={() => setSelected(null)}>Back</button>
          </div>
        </div>
      )}
    </div>
  );
}
