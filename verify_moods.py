"""Mood consonance verifier (Phase 3 invariant).

Stroke pitches are effectively random, so EVERY scale degree of every mood
must sit consonantly over that mood's drone chord. This script enforces it
numerically:

  1. PARSES the MOODS table straight out of useDrawSound.js (no duplicated
     data to drift out of sync) — each mood block must keep one `base:`,
     one `scale: [...]`, one `drone: [...]`, and one `droneLP:` line.
  2. Models each sound the way the synth builds it: melody voice = sawtooth
     partials (1/n) behind the rest-bow lowpass; drone tone = triangle
     partials (odd, 1/n^2) behind the mood's drone lowpass; partial
     amplitudes scaled by the actual voice/drone gain levels.
  3. Scores every scale tone against the full drone chord with the
     Plomp–Levelt / Sethares sensory-roughness curve, and compares against
     CONTROL tones that are genuinely wrong (semitone and tritone against
     the drone root, played in the drone's own register — the clashes the
     scale quantizer must make impossible).

PASS = every mood's worst scale tone is clearly below every control clash.
"""
import math
import re
import sys

SRC = "frontend/src/hooks/useDrawSound.js"

VOICE_GAIN = 0.075   # bow-note target gain in the synth
VOICE_LP = 1600.0    # rest-bow lowpass (filterBase + 700 for dawn; close enough
                     # for all moods — brightness only rises with pen speed)
N_SAW = 10           # melody partials modeled
N_TRI = 4            # drone odd partials modeled (1,3,5,7)


def parse_moods(path):
    js = open(path).read()
    block = re.search(r"const MOODS = \{(.*?)\n\};", js, re.S).group(1)
    moods = {}
    for m in re.finditer(
        r"(\w+): \{.*?base: ([\d.]+).*?scale: \[([^\]]+)\].*?"
        r"drone: \[([^\]]+)\].*?droneLevel: ([\d.]+), droneLP: (\d+)",
        block, re.S,
    ):
        name, base, scale, drone, dlevel, dlp = m.groups()
        moods[name] = {
            "base": float(base),
            "scale": [int(x) for x in scale.replace(" ", "").split(",")],
            "drone": [float(x) for x in drone.replace(" ", "").split(",")],
            "droneLevel": float(dlevel),
            "droneLP": float(dlp),
        }
    return moods


def lp(amp, freq, cutoff):
    """One-pole lowpass magnitude — matches the feel of the synth's biquads."""
    return amp / math.sqrt(1.0 + (freq / cutoff) ** 2)


def saw_partials(f0, gain):
    return [(f0 * n, lp(gain / n, f0 * n, VOICE_LP)) for n in range(1, N_SAW + 1)]


def tri_partials(f0, gain, cutoff):
    return [
        (f0 * n, lp(gain / (n * n), f0 * n, cutoff))
        for n in (1, 3, 5, 7)[:N_TRI]
    ]


def pl_dissonance(f1, a1, f2, a2):
    """Plomp–Levelt pair roughness, Sethares parameterization."""
    fmin = min(f1, f2)
    s = 0.24 / (0.021 * fmin + 19.0)
    d = abs(f1 - f2)
    return a1 * a2 * (math.exp(-3.5 * s * d) - math.exp(-5.75 * s * d))


def roughness(melody_f0, mood):
    mel = saw_partials(melody_f0, VOICE_GAIN)
    total = 0.0
    for df0 in mood["drone"]:
        for fd, ad in tri_partials(df0, mood["droneLevel"], mood["droneLP"]):
            for fm, am in mel:
                total += pl_dissonance(fd, ad, fm, am)
    return total * 1e4  # readable units


def main():
    moods = parse_moods(SRC)
    assert len(moods) == 4, f"expected 4 moods, parsed {len(moods)}: {list(moods)}"

    failures = []
    print(f"{'mood':8s} {'worst scale tone':>18s} {'controls (semi/tri)':>22s}")
    for name, mood in moods.items():
        scores = []
        for st in mood["scale"]:
            f = mood["base"] * 2 ** (st / 12)
            scores.append((roughness(f, mood), st))
        worst, worst_deg = max(scores)

        # Controls: notes the quantizer must never emit — a semitone and a
        # tritone against the drone root, voiced ONE octave above the root
        # (the drone's own neighborhood, where clashes are ugliest).
        root = mood["drone"][0]
        controls = [roughness(root * 2 * 2 ** (s / 12), mood) for s in (1, 6)]
        ctl_min = min(controls)

        ok = worst < 0.6 * ctl_min
        print(
            f"{name:8s} {worst:10.3f} (deg {worst_deg:+3d}) "
            f"{controls[0]:10.3f} /{controls[1]:9.3f}   {'OK' if ok else 'FAIL'}"
        )
        if not ok:
            failures.append(name)

    if failures:
        print(f"\nDISSONANCE RISK in: {', '.join(failures)}", file=sys.stderr)
        sys.exit(1)
    print("\nOK: every scale degree of every mood sits below the clash controls.")


if __name__ == "__main__":
    main()
