/**
 * useGallery — the local "gallery wall" (Feature 2.1).
 *
 * Every finished drawing saves a small JPEG thumbnail (dataURL, ~30–50 KB)
 * plus the settings that produced it into localStorage["hh-gallery-v1"].
 * FIFO cap of 24 entries keeps the whole store ≈ 1–1.5 MB, comfortably under
 * quota; every localStorage touch sits in try/catch (private-mode quota can
 * be 0). Thumbnails only — full-res stills/videos are out of scope by design
 * (move to IndexedDB if that's ever demanded).
 *
 * Nothing leaves the device: this is a purely local collection, and the
 * gallery UI offers per-entry delete and a clear-all.
 */
import { useCallback, useState } from 'react';

const GALLERY_KEY = 'hh-gallery-v1';
const MAX_ENTRIES = 24;

function load() {
  try {
    const raw = typeof localStorage !== 'undefined' && localStorage.getItem(GALLERY_KEY);
    const list = raw ? JSON.parse(raw) : [];
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

function persist(list) {
  try {
    localStorage.setItem(GALLERY_KEY, JSON.stringify(list));
  } catch {
    /* quota / private mode — the in-memory gallery still works this session */
  }
}

export function useGallery() {
  const [entries, setEntries] = useState(load);

  // entry: { thumb: dataURL, meta: {mode, detail, instrument, seconds, strokes} }
  const addEntry = useCallback((thumb, meta) => {
    setEntries((prev) => {
      const entry = {
        id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
        date: Date.now(),
        thumb,
        meta,
      };
      const next = [entry, ...prev].slice(0, MAX_ENTRIES); // newest first, FIFO cap
      persist(next);
      return next;
    });
  }, []);

  const removeEntry = useCallback((id) => {
    setEntries((prev) => {
      const next = prev.filter((e) => e.id !== id);
      persist(next);
      return next;
    });
  }, []);

  const clear = useCallback(() => {
    setEntries(() => {
      persist([]);
      return [];
    });
  }, []);

  return { entries, addEntry, removeEntry, clear };
}
