/**
 * ShareDialog — Phase 5.4's consent-then-link flow.
 *
 * Sharing creates a PUBLIC URL, so the dialog leads with exactly what will
 * be uploaded before anything moves: the finished drawing (still + video
 * with its music) — NEVER the source photo, which stays on the device — and
 * that the link expires after 30 days. That wording is a product decision
 * (owner, 2026-08-01); keep it in lockstep with what api/share.mjs stores.
 *
 * States: confirm → working → done(url) | error. On deployments without a
 * Blob store (or the vite dev server) createShareLink throws
 * ShareUnconfiguredError and the dialog offers the plain file share instead
 * — the feature degrades to exactly what the app did before 5.4.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';

const S = {
  scrim: {
    position: 'absolute', inset: 0, zIndex: 40,
    background: 'rgba(20, 20, 30, 0.45)',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    padding: 18,
  },
  card: {
    width: 420, maxWidth: '92vw', borderRadius: 18,
    border: '2px solid #1a1a2e', background: '#fdfbf6', color: '#1a1a2e',
    fontFamily: 'Georgia, serif', padding: '22px 24px 20px',
    boxShadow: '0 18px 60px rgba(0,0,0,0.35)', textAlign: 'center',
    boxSizing: 'border-box',
  },
  h: { margin: '0 0 10px', fontSize: 21, letterSpacing: 0.4 },
  p: { margin: '0 0 14px', fontSize: 14.5, lineHeight: 1.55, color: '#3a3a4a' },
  fine: { margin: '2px 0 0', fontSize: 12.5, color: '#6a6a7e', lineHeight: 1.5 },
  row: { display: 'flex', gap: 10, justifyContent: 'center', flexWrap: 'wrap', marginTop: 14 },
  btn: {
    padding: '10px 20px', fontSize: 15, fontFamily: 'Georgia, serif',
    border: '2px solid #1a1a2e', borderRadius: 999, background: '#fff',
    color: '#1a1a2e', cursor: 'pointer',
  },
  primary: {
    padding: '10px 22px', fontSize: 15, fontFamily: 'Georgia, serif',
    border: '2px solid #1a1a2e', borderRadius: 999, background: '#1a1a2e',
    color: '#fdfbf6', cursor: 'pointer',
  },
  ghost: {
    padding: '8px 12px', fontSize: 13.5, fontFamily: 'Georgia, serif',
    background: 'none', border: 'none', color: '#5a5a6e', cursor: 'pointer',
    textDecoration: 'underline dotted', textUnderlineOffset: 4,
  },
  urlBox: {
    width: '100%', boxSizing: 'border-box', padding: '10px 14px',
    fontSize: 14, fontFamily: 'Georgia, serif', textAlign: 'center',
    border: '2px solid #1a1a2e', borderRadius: 999, background: '#fff',
    color: '#1a1a2e', outlineColor: '#1a1a2e',
  },
  err: { color: '#b3402a', fontSize: 14, margin: '0 0 6px' },
};

export default function ShareDialog({
  onClose,
  onCreateLink,          // async () => {url, expiresAt}
  canShareFile = false,  // navigator.share with files exists
  onShareFile = null,    // the pre-5.4 file share (fallback path)
  hasVideo = false,
}) {
  const [step, setStep] = useState('confirm'); // confirm | working | done | error
  const [url, setUrl] = useState('');
  const [errMsg, setErrMsg] = useState('');
  const [unconfigured, setUnconfigured] = useState(false);
  const [copied, setCopied] = useState(false);
  const urlRef = useRef(null);
  // Strict-Mode-safe liveness: the effect BODY must re-arm the ref, because
  // dev StrictMode mounts → unmounts → remounts, and a cleanup-only ref
  // would stay false forever after the simulated unmount (found the hard
  // way: the link arrived and the dialog silently never showed it).
  const aliveRef = useRef(true);
  useEffect(() => {
    aliveRef.current = true;
    return () => { aliveRef.current = false; };
  }, []);

  const create = useCallback(async () => {
    setStep('working');
    try {
      const r = await onCreateLink();
      if (!aliveRef.current) return;
      setUrl(r.url);
      setStep('done');
    } catch (e) {
      if (!aliveRef.current) return;
      setUnconfigured(e?.code === 'unconfigured');
      setErrMsg(
        e?.code === 'unconfigured'
          ? 'Link sharing isn’t switched on for this deployment yet.'
          : 'The link couldn’t be created — the drawing is still yours to save.'
      );
      setStep('error');
    }
  }, [onCreateLink]);

  const copy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => { if (aliveRef.current) setCopied(false); }, 1600);
    } catch {
      // Clipboard refused (permissions) → select the text so ⌘C works.
      urlRef.current?.select();
    }
  }, [url]);

  const shareUrl = useCallback(async () => {
    try {
      await navigator.share({ url, title: 'Hypnotic Hand', text: 'Watch my photo being drawn ✍️' });
    } catch { /* cancelled */ }
  }, [url]);

  return (
    <div style={S.scrim} onClick={onClose} role="dialog" aria-modal="true" aria-label="Share this drawing">
      <div style={S.card} onClick={(e) => e.stopPropagation()}>
        {step === 'confirm' && (
          <>
            <h2 style={S.h}>Share a link to this drawing</h2>
            <p style={S.p}>
              This uploads the <b>finished drawing</b> — the
              {hasVideo ? ' video of it being drawn (with its music) and a still' : ' still image'} —
              and gives you a public link anyone can open.
            </p>
            <p style={S.fine}>
              Your photo is <b>never uploaded</b> — it stays on this device; only the
              line drawing travels. The link expires after <b>30 days</b>.
            </p>
            <div style={S.row}>
              <button style={S.primary} onClick={create}>Create link 🔗</button>
              {canShareFile && onShareFile && (
                <button style={S.btn} onClick={() => { onClose(); onShareFile(); }}>
                  Share the file instead
                </button>
              )}
            </div>
            <button style={S.ghost} onClick={onClose}>Cancel</button>
          </>
        )}

        {step === 'working' && (
          <>
            <h2 style={S.h}>Framing it…</h2>
            <p style={S.p}>Uploading the drawing and minting its link.</p>
          </>
        )}

        {step === 'done' && (
          <>
            <h2 style={S.h}>Your drawing has an address</h2>
            <input
              ref={urlRef}
              style={S.urlBox}
              value={url}
              readOnly
              onFocus={(e) => e.target.select()}
              aria-label="Share link"
            />
            <div style={S.row}>
              <button style={S.primary} onClick={copy}>{copied ? 'Copied ✓' : 'Copy link'}</button>
              {typeof navigator !== 'undefined' && typeof navigator.share === 'function' && (
                <button style={S.btn} onClick={shareUrl}>Share ↗</button>
              )}
              <a href={url} target="_blank" rel="noreferrer" style={{ textDecoration: 'none' }}>
                <button style={S.btn}>Open ↗</button>
              </a>
            </div>
            <p style={S.fine}>It lasts 30 days, then quietly fades away.</p>
            <button style={S.ghost} onClick={onClose}>Done</button>
          </>
        )}

        {step === 'error' && (
          <>
            <h2 style={S.h}>{unconfigured ? 'No links here yet' : 'That didn’t work'}</h2>
            <p style={S.err}>{errMsg}</p>
            <div style={S.row}>
              {canShareFile && onShareFile && (
                <button style={S.primary} onClick={() => { onClose(); onShareFile(); }}>
                  Share the file instead
                </button>
              )}
              {!unconfigured && <button style={S.btn} onClick={create}>Try again</button>}
            </div>
            <button style={S.ghost} onClick={onClose}>Close</button>
          </>
        )}
      </div>
    </div>
  );
}
